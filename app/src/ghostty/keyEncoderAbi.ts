import type { GhosttyExports } from './abi';

/** wasm32; abi.layout.test.ts holds the module to it. */
const USIZE_SIZE = 4;

/**
 * The allocators ghostty-web's key encoder calls, which libghostty-vt retired.
 *
 * Upstream folded `ghostty_wasm_{alloc,free}_{u8,usize,u8_array}` into the
 * single `ghostty_wasm_alloc`/`ghostty_wasm_free` pair. abi.ts moved with the
 * rename; ghostty-web 0.4.0 — the newest published, and the only part of that
 * package attn still uses — did not, and it reaches for all three retired
 * pairs. A missing export is not a link error in wasm: the call throws a
 * TypeError that InputHandler catches and logs, so the keystroke goes nowhere.
 *
 * Every key that needs the encoder is affected — the arrows, control combos,
 * and any Option-composed character — while InputHandler's hardcoded table
 * keeps unmodified Enter/Tab/Escape and friends working. That is the shape of
 * the bug: typing looks fine and the cursor will not move.
 *
 * The sizes below are the ones the retired names implied: one byte, one wasm32
 * usize, and the caller's own length.
 */
export function withKeyEncoderAllocators(instance: WebAssembly.Instance): WebAssembly.Instance {
  const e = instance.exports as unknown as GhosttyExports;
  return {
    exports: {
      ...instance.exports,
      ghostty_wasm_alloc_u8: () => e.ghostty_wasm_alloc(1),
      ghostty_wasm_free_u8: (ptr: number) => e.ghostty_wasm_free(ptr, 1),
      ghostty_wasm_alloc_usize: () => e.ghostty_wasm_alloc(USIZE_SIZE),
      ghostty_wasm_free_usize: (ptr: number) => e.ghostty_wasm_free(ptr, USIZE_SIZE),
      ghostty_wasm_alloc_u8_array: (len: number) => e.ghostty_wasm_alloc(len),
      ghostty_wasm_free_u8_array: (ptr: number, len: number) => e.ghostty_wasm_free(ptr, len),
    },
  };
}
