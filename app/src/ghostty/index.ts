import { Ghostty as GhosttyWeb } from 'ghostty-web';
import type { GhosttyExports } from './abi';
import { withKeyEncoderAllocators } from './keyEncoderAbi';
import { GhosttyTerminal, type GhosttyTerminalConfig } from './terminal';

export { CellFlags, GhosttyTerminal } from './terminal';
export type {
  GhosttyCell,
  GhosttyTerminalConfig,
  RGB,
  RenderStateColors,
  RenderStateCursor,
  SnapshotHistory,
} from './terminal';
export { DIRTY_FALSE, DIRTY_FULL, DIRTY_PARTIAL } from './abi';

/**
 * One loaded libghostty-vt instance, and the terminals created from it.
 *
 * `keyInput` is ghostty-web's wrapper over the same instance, through the
 * allocator adapter that package's encoder needs. Its key encoder is the only
 * part of ghostty-web attn still uses, and it drives InputHandler; the terminal
 * model above replaced everything else.
 */
export class Ghostty {
  readonly exports: GhosttyExports;
  readonly keyInput: GhosttyWeb;

  constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports as GhosttyExports;
    this.keyInput = new GhosttyWeb(withKeyEncoderAllocators(instance));
  }

  createTerminal(cols = 80, rows = 24, config: GhosttyTerminalConfig = {}): GhosttyTerminal {
    return new GhosttyTerminal(this.exports, cols, rows, config);
  }
}
