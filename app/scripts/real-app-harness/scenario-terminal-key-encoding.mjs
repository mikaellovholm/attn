#!/usr/bin/env node

// Real keystrokes reaching a real PTY as the right bytes.
//
// InputHandler answers unmodified Enter/Tab/Escape and friends from a hardcoded
// table; everything else — the arrows, control combos, an Option-composed
// character — is encoded by libghostty-vt's key encoder. A pin bump moved the
// allocators that encoder calls, and the failure was silent: InputHandler
// catches the TypeError and warns, so ordinary typing kept working while the
// arrows and half a Nordic keyboard went nowhere. No scenario noticed, because
// every unit test mocks the encoder's package away.
//
// The pane runs `stty raw -echo; cat -v`, which prints the bytes it is handed
// rather than acting on them: the Left arrow shows up as `^[[D` on screen. So
// the assertion is over the sequence the daemon's PTY actually received, not
// over a shell line editor's interpretation of it, and it holds whatever shell
// and keymap the machine has.
//
// The Option-composed key is checked by arrival, not by value: which character
// ⌥2 composes is the active keyboard layout's business (`@` on a Nordic layout),
// and the bug dropped it whatever it was.
//
// Prereqs: a built `./attn` (or ATTN_HARNESS_BIN); a non-production profile
// install with the automation layer.

import {
  createSessionAndWaitForInitialPane,
  launchFreshAppAndConnect,
  parseCommonArgs,
  printCommonHelp,
} from './common.mjs';
import { UiAutomationClient } from './uiAutomationClient.mjs';
import { DaemonObserver } from './daemonObserver.mjs';
import { MacOSDriver, delay } from './macosDriver.mjs';
import {
  captureSessionArtifacts,
  waitForPaneAttached,
  waitForPaneInputFocus,
  waitForPaneShellReady,
  waitForPaneText,
  waitForPaneVisible,
} from './scenarioAssertions.mjs';
import { createScenarioRunner } from './scenarioRunner.mjs';

// macOS virtual key codes. InputDriver's --key map covers printable keys only.
const KEY_CODE = { two: 19, left: 123, right: 124, down: 125, up: 126 };

// What each keypress must put on the PTY, as `cat -v` renders it. The arrows
// are the encoder's own output; ^G is a control combo, which takes the same
// path.
const EXPECTED = [
  { name: 'ArrowLeft', press: (d) => d.pressKeyCode(KEY_CODE.left), bytes: '^[[D' },
  { name: 'ArrowRight', press: (d) => d.pressKeyCode(KEY_CODE.right), bytes: '^[[C' },
  { name: 'ArrowUp', press: (d) => d.pressKeyCode(KEY_CODE.up), bytes: '^[[A' },
  { name: 'ArrowDown', press: (d) => d.pressKeyCode(KEY_CODE.down), bytes: '^[[B' },
  { name: 'Ctrl+G', press: (d) => d.pressKey('g', { control: true }), bytes: '^G' },
];

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === '--') {
    args.shift();
  }
  const options = parseCommonArgs(args);
  return {
    options,
    help: args.includes('--help') || args.includes('-h'),
  };
}

async function paneText(client, sessionId, paneId) {
  const read = await client.request('read_pane_text', { sessionId, paneId });
  return read.text;
}

async function main() {
  const { options, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printCommonHelp('scripts/real-app-harness/scenario-terminal-key-encoding.mjs');
    return;
  }

  const runner = createScenarioRunner(options, {
    scenarioId: 'TERMINAL-KEY-ENCODING',
    tier: 'tier1-local-shell',
    prefix: 'terminal-key-encoding',
    metadata: {
      shell: 'default',
      focus: 'native arrow / control / Option keystrokes encoded onto a real PTY',
    },
  });

  const client = new UiAutomationClient({ appPath: options.appPath });
  const observer = new DaemonObserver({ wsUrl: options.wsUrl });
  const driver = new MacOSDriver({ appPath: options.appPath });
  let sessionId = null;

  runner.log('run context', { runDir: runner.runDir, sessionDir: runner.sessionDir, wsUrl: options.wsUrl });

  runner.registerCleanup('close_observer', () => observer.close());
  runner.registerCleanup('quit_app', () => client.quitApp());
  runner.registerCleanup('close_session_panes', async () => {
    if (!sessionId) return;
    const workspace = await client.request('get_workspace', { sessionId }).catch(() => null);
    for (const pane of workspace?.panes || []) {
      await client.request('close_pane', { sessionId, paneId: pane.paneId }).catch(() => {});
    }
  });

  try {
    await runner.step('launch_app', async () => {
      await launchFreshAppAndConnect(client, observer);
    });

    let pane;
    await runner.step('create_session', async () => {
      sessionId = await createSessionAndWaitForInitialPane({
        client,
        observer,
        cwd: runner.sessionDir,
        label: `key-encoding-${runner.runId}`,
        agent: 'shell',
        waitForInitialPaneVisible: false,
        sessionWaitMs: 30_000,
      });
      await client.request('select_session', { sessionId });
      const workspace = await client.request('get_workspace', { sessionId });
      pane = workspace?.panes?.[0];
      runner.assert(Boolean(pane), `No pane in workspace: ${JSON.stringify(workspace)}`);
      await waitForPaneVisible(client, sessionId, pane.paneId, 20_000);
      await waitForPaneAttached(client, sessionId, pane.paneId, 20_000);
      await waitForPaneShellReady(client, sessionId, pane.paneId, {
        timeoutMs: 20_000,
        description: 'shell pane ready',
      });
    });

    const marker = `KEYS_${runner.runId}`;
    await runner.step('start_byte_echo', async () => {
      // An automation write is fine for the setup: the keys under test are the
      // only thing that has to travel the frontend's own input path.
      await client.request('write_pane', {
        sessionId,
        paneId: pane.paneId,
        text: `printf '${marker}\\n'; stty raw -echo; cat -v`,
      });
      await waitForPaneText(
        client,
        sessionId,
        pane.paneId,
        (text) => text.split('\n').some((line) => line.trim() === marker),
        'byte echo running',
        20_000,
      );
      await client.request('focus_pane', { sessionId, paneId: pane.paneId });
      await driver.activateApp();
      await waitForPaneInputFocus(client, sessionId, pane.paneId, 12_000);
    });

    // Everything `cat -v` prints after the marker. The marker's own line is the
    // fence, so the shell's echo of the setup command cannot be mistaken for a
    // keystroke's bytes.
    const echoedBytes = (text) => {
      const at = text.lastIndexOf(marker);
      return at < 0 ? '' : text.slice(at + marker.length).replace(/\s+/g, '');
    };

    const received = [];
    await runner.step('press_encoded_keys', async () => {
      for (const key of EXPECTED) {
        const before = echoedBytes(await paneText(client, sessionId, pane.paneId));
        await key.press(driver);
        const state = await waitForPaneText(
          client,
          sessionId,
          pane.paneId,
          (text) => echoedBytes(text).length > before.length,
          `${key.name} reached the PTY`,
          10_000,
        );
        const after = echoedBytes(state?.text ?? await paneText(client, sessionId, pane.paneId));
        const arrived = after.slice(before.length);
        received.push({ key: key.name, expected: key.bytes, arrived });
        runner.assert(
          arrived === key.bytes,
          `${key.name} put ${JSON.stringify(arrived)} on the PTY, expected ${JSON.stringify(key.bytes)}`,
        );
        runner.log('key encoded', { key: key.name, bytes: arrived });
      }
    });

    let composed = '';
    await runner.step('press_option_composed_key', async () => {
      const before = echoedBytes(await paneText(client, sessionId, pane.paneId));
      await driver.pressKeyCode(KEY_CODE.two, { option: true });
      const state = await waitForPaneText(
        client,
        sessionId,
        pane.paneId,
        (text) => echoedBytes(text).length > before.length,
        'Option-composed character reached the PTY',
        10_000,
      );
      composed = echoedBytes(state?.text ?? await paneText(client, sessionId, pane.paneId)).slice(before.length);
      // Which character ⌥2 composes belongs to the active layout; that it
      // arrives at all is what the encoder decides.
      runner.log('option composed', { keyCode: KEY_CODE.two, bytes: composed });
    });

    await delay(200);
    const result = runner.finishSuccess({
      sessionId,
      paneId: pane.paneId,
      received,
      optionComposed: composed,
    });
    console.log('[verify] PASS — every encoded keystroke reached the PTY as the right bytes.');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (sessionId) {
      await captureSessionArtifacts(client, runner.runDir, 'key-encoding-failure', sessionId).catch(() => {});
    }
    const result = runner.finishFailure(error, { sessionId });
    console.error(result.error);
    process.exitCode = 1;
  } finally {
    if (sessionId) {
      const workspace = await client.request('get_workspace', { sessionId }).catch(() => null);
      for (const pane of workspace?.panes || []) {
        await client.request('close_pane', { sessionId, paneId: pane.paneId }).catch(() => {});
      }
    }
    await client.quitApp().catch(() => {});
    await observer.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
