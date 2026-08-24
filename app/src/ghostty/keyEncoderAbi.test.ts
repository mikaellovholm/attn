// @vitest-environment node
// The receipt behind keyEncoderAbi.ts.
//
// Every other terminal test mocks 'ghostty-web' away, so nothing exercised the
// one part of it attn still ships: the key encoder, running against the module
// abi.ts describes. Pin da5ddcb retired the allocators that encoder calls, and
// the failure was invisible — InputHandler catches the TypeError and warns, so
// the arrows and every Option-composed character stopped reaching the PTY while
// ordinary typing kept working.
//
// This drives the real vendored module through the real encoder, so the next
// pin bump that moves an allocator fails here instead of on someone's keyboard.
// @types/node isn't a direct dependency of this package (only a transitive peer
// of vite/vitest), matching abi.layout.test.ts's pattern.
// @ts-expect-error -- see above
import { readFileSync } from 'node:fs';
// @ts-expect-error -- see above
import { fileURLToPath } from 'node:url';
import { Ghostty as GhosttyWeb, KeyEncoderOption } from 'ghostty-web';
import { beforeAll, describe, expect, it } from 'vitest';
import { Ghostty } from './index';
import { withKeyEncoderAllocators } from './keyEncoderAbi';

// ghostty-web's Key and Mods enums are declared but not emitted, so its
// consumers spell the values out.
const KEY = { TWO: 8, C: 22, DOWN: 75, LEFT: 76, RIGHT: 77, UP: 78 } as const;
const MODS = { NONE: 0, CTRL: 2, ALT: 4 } as const;
const PRESS = 1;

const wasmPath = fileURLToPath(new URL('../../vendor/ghostty-vt/ghostty-vt.wasm', import.meta.url));

let module: WebAssembly.Module;

async function instantiate(): Promise<WebAssembly.Instance> {
  return WebAssembly.instantiate(module, { env: { log: () => {} } });
}

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync(wasmPath));
});

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('the key encoder attn hands to InputHandler', () => {
  it('encodes the arrows, which have no hardcoded fallback', async () => {
    const encoder = new Ghostty(await instantiate()).keyInput.createKeyEncoder();
    encoder.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, false);
    expect(decode(encoder.encode({ action: PRESS, key: KEY.UP, mods: MODS.NONE }))).toBe('\x1b[A');
    expect(decode(encoder.encode({ action: PRESS, key: KEY.DOWN, mods: MODS.NONE }))).toBe('\x1b[B');
    expect(decode(encoder.encode({ action: PRESS, key: KEY.RIGHT, mods: MODS.NONE }))).toBe('\x1b[C');
    expect(decode(encoder.encode({ action: PRESS, key: KEY.LEFT, mods: MODS.NONE }))).toBe('\x1b[D');
  });

  it('follows the cursor-key mode InputHandler reads off the terminal', async () => {
    const encoder = new Ghostty(await instantiate()).keyInput.createKeyEncoder();
    encoder.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, true);
    expect(decode(encoder.encode({ action: PRESS, key: KEY.LEFT, mods: MODS.NONE }))).toBe('\x1bOD');
  });

  it('passes an Option-composed character through as itself', async () => {
    // ⌥2 on a Nordic Mac layout: code Digit2, key "@". InputHandler treats any
    // alt-modified key as non-printable, so "@" only exists if the encoder runs.
    const encoder = new Ghostty(await instantiate()).keyInput.createKeyEncoder();
    expect(decode(encoder.encode({
      action: PRESS, key: KEY.TWO, mods: MODS.ALT, utf8: '@',
    }))).toBe('@');
  });

  it('encodes a control combo', async () => {
    const encoder = new Ghostty(await instantiate()).keyInput.createKeyEncoder();
    expect(decode(encoder.encode({
      action: PRESS, key: KEY.C, mods: MODS.CTRL, utf8: 'c',
    }))).toBe('\x03');
  });
});

describe('the allocators the adapter supplies', () => {
  // Why the adapter exists. When ghostty-web ships a build that calls the
  // current pair, this fails and the adapter can go.
  it('are absent from the module ghostty-web is handed', async () => {
    const raw = await instantiate();
    const encoder = new GhosttyWeb(raw).createKeyEncoder();
    expect(() => encoder.encode({ action: PRESS, key: KEY.LEFT, mods: MODS.NONE }))
      .toThrow(TypeError);
    expect(() => encoder.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, false))
      .toThrow(TypeError);
  });

  it('leaves the module\'s own exports untouched', async () => {
    const raw = await instantiate();
    const adapted = withKeyEncoderAllocators(raw);
    expect(adapted.exports.memory).toBe(raw.exports.memory);
    expect(adapted.exports.ghostty_wasm_alloc).toBe(raw.exports.ghostty_wasm_alloc);
  });
});
