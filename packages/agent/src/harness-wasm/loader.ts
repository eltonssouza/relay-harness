/**
 * Loads the harness WebAssembly module, built from `crates/harness-wasm`, and speaks its interface.
 *
 * The module exports three functions and speaks JSON: the host allocates a buffer, writes a
 * request `{ method, ... }`, calls `harness_call`, reads `{ ok }` or `{ error }` and frees both
 * buffers. `HarnessWasmEngine` wraps one engine instance of the module.
 */

import { HARNESS_WASM_BASE64 } from "./module.generated.ts";

/** The part of the WebAssembly API used here; the ES2024 lib and Node's types do not declare it. */
interface WebAssemblyApi {
	Module: new (bytes: Uint8Array<ArrayBuffer>) => object;
	Instance: new (module: object, imports: object) => { exports: unknown };
}

interface HarnessWasmExports {
	memory: { buffer: ArrayBuffer };
	harness_alloc(length: number): number;
	harness_free(pointer: number, length: number): void;
	harness_call(pointer: number, length: number): bigint;
}

let instance: HarnessWasmExports | undefined;

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** The module's exports, compiled and instantiated on first use. Node and Bun compile it synchronously. */
function harnessWasm(): HarnessWasmExports {
	if (!instance) {
		const wasm = (globalThis as unknown as { WebAssembly: WebAssemblyApi }).WebAssembly;
		const module = new wasm.Module(decodeBase64(HARNESS_WASM_BASE64));
		instance = new wasm.Instance(module, {}).exports as HarnessWasmExports;
	}
	return instance;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Send one request to the module and return its result; a module error throws. */
export function callHarnessWasm(request: { method: string; [key: string]: unknown }): unknown {
	const wasm = harnessWasm();
	const input = encoder.encode(JSON.stringify(request));
	const pointer = wasm.harness_alloc(input.length);
	new Uint8Array(wasm.memory.buffer, pointer, input.length).set(input);
	const packed = wasm.harness_call(pointer, input.length);
	wasm.harness_free(pointer, input.length);
	const resultPointer = Number(packed >> 32n);
	const resultLength = Number(packed & 0xffffffffn);
	const text = decoder.decode(new Uint8Array(wasm.memory.buffer, resultPointer, resultLength));
	wasm.harness_free(resultPointer, resultLength);
	const response = JSON.parse(text) as { ok?: unknown; error?: string };
	if (response.error !== undefined) throw new Error(`harness-wasm ${request.method}: ${response.error}`);
	return response.ok;
}

/** Options of a module engine, as `HarnessCore` takes them: `false` disables a pillar. */
export interface HarnessWasmEngineOptions {
	alignment?:
		| { maxConstraints?: number; hasAuthorizer?: boolean; scopeGuard?: boolean; authorizationGate?: boolean }
		| false;
	evidence?: { maxGatesPerRequest?: number } | false;
	context?:
		| { keepRecent?: number; batchSize?: number; minElideChars?: number; maxDigestEntries?: number; cwd?: string }
		| false;
	verifyCommands?: readonly string[];
	workspace?: { cwd?: string; home?: string; tempDir?: string };
}

/** One engine instance inside the module. Call `dispose` when done; the instance holds the pillars' state. */
export class HarnessWasmEngine {
	readonly id: number;

	constructor(options: HarnessWasmEngineOptions = {}) {
		this.id = (callHarnessWasm({ method: "create", options }) as { engine: number }).engine;
	}

	/** Call an engine method of the module (`check`, `assessFinalMessage`, ...). */
	call(method: string, params: Record<string, unknown> = {}): unknown {
		return callHarnessWasm({ method, engine: this.id, ...params });
	}

	dispose(): void {
		callHarnessWasm({ method: "dispose", engine: this.id });
	}
}
