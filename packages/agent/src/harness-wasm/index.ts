/**
 * The Rust harness core compiled to WebAssembly, as a separate entry
 * (`@relay-harness/agent-core/harness-wasm`) so the main entry and browser bundles do not carry
 * the module. `createHarnessWasmEngine` runs `HarnessCore`'s pillars in it; `callHarnessWasm` and
 * `HarnessWasmEngine` speak the module's JSON interface directly.
 */

export { createHarnessWasmEngine } from "./engine.ts";
export { callHarnessWasm, HarnessWasmEngine, type HarnessWasmEngineOptions } from "./loader.ts";
