import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { type LayaAnswer, LayaOnnxClassifier, type LayaQuestionDefinition } from "./native-onnx.ts";
import type { LayaModelFile } from "./runtime.ts";

/**
 * Lifecycle around the in-process relay-laya classifier (ACI phase 1): integrity-checked offline
 * loading, a single shared load, serialized inference, timeouts, cancellation and a circuit breaker.
 * Every failure is a rejected `LayaRuntimeError`, so callers keep their heuristic fallback.
 * Not wired into routing until the plan's parity gate is lifted.
 */

export interface LayaNativeManifest {
	version: string;
	repository: string;
	/** Immutable Hugging Face commit the files come from. */
	revision: string;
	/** SHA-256 of the question schema the reference was produced with (`layaDecisionsFile().decisions`). */
	schemaSha256: string;
	runtime: string;
	/** `path` is the location in the local snapshot, `asset` the file in the repository. */
	files: LayaModelFile[];
}

export const LAYA_NATIVE_MANIFEST: LayaNativeManifest = {
	version: "relay-laya-v5-onnx-fp32",
	repository: "eltonssouza/relay-laya",
	revision: "561d9714816754b99dc5922789be996dd3cf385c",
	schemaSha256: "8b3d443b26817b6d08bd7aea4ab8443bcf437d031b380653080f5250156254fe",
	runtime: "@huggingface/transformers@4.3.1",
	files: [
		{
			path: "config.json",
			asset: "encoder/config.json",
			size: 2018,
			sha256: "3ceae14d210557b47abcde2768b27afbb2131974f9c4dd714f2236fd9ee54981",
		},
		{
			path: "rl_agent_config.json",
			asset: "rl_agent_config.json",
			size: 754,
			sha256: "372f1c5e59e1e90b1206d5e0e34095856db904eaf599dd9c3564d20fd4f74e31",
		},
		{
			path: "tokenizer.json",
			asset: "tokenizer/tokenizer.json",
			size: 34363188,
			sha256: "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f",
		},
		{
			path: "tokenizer_config.json",
			asset: "tokenizer/tokenizer_config.json",
			size: 647,
			sha256: "7ae408fbffdbeb418b26ea67609e8f60bd7fac6f782172a945e78c841c10a595",
		},
		{
			path: "onnx/laya.onnx",
			asset: "onnx/laya.onnx",
			size: 1288365866,
			sha256: "e6f13c59702380ae133fb406d400c90666fb2272b458361168534aa7aeacd6ff",
		},
	],
};

export type LayaRuntimeErrorCode =
	| "missing"
	| "corrupt"
	| "load"
	| "timeout"
	| "aborted"
	| "circuit_open"
	| "disposed"
	| "inference";

export class LayaRuntimeError extends Error {
	readonly code: LayaRuntimeErrorCode;

	constructor(code: LayaRuntimeErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "LayaRuntimeError";
		this.code = code;
	}
}

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

/** Checks every manifest file by size and SHA-256. Runs offline; nothing is downloaded. */
export async function verifyNativeModel(dir: string, manifest: LayaNativeManifest): Promise<void> {
	for (const file of manifest.files) {
		const path = join(dir, file.path);
		let size: number;
		try {
			size = statSync(path).size;
		} catch (error) {
			throw new LayaRuntimeError("missing", `Laya model file ${file.path} is missing in ${dir}`, { cause: error });
		}
		if (size !== file.size)
			throw new LayaRuntimeError("corrupt", `Laya model file ${file.path} has ${size} bytes, expected ${file.size}`);
		const digest = await sha256(path);
		if (digest !== file.sha256)
			throw new LayaRuntimeError(
				"corrupt",
				`Laya model file ${file.path} has SHA-256 ${digest}, expected ${file.sha256}`,
			);
	}
}

export interface LayaClassifierLike {
	classify(request: string, questions: Record<string, LayaQuestionDefinition>): Promise<Record<string, LayaAnswer>>;
	close(): Promise<void>;
}

export interface LayaDecisionRuntimeOptions {
	dir: string;
	manifest?: LayaNativeManifest;
	/** Per-request limit, including time spent waiting for the previous request. Default: 30 s. */
	timeoutMs?: number;
	/** Consecutive failures that open the circuit. Default: 3. */
	failureThreshold?: number;
	/** How long an open circuit rejects requests before one is let through. Default: 60 s. */
	cooldownMs?: number;
	/** Test seams. */
	load?: (dir: string) => Promise<LayaClassifierLike>;
	verify?: (dir: string, manifest: LayaNativeManifest) => Promise<void>;
	now?: () => number;
}

export type LayaRuntimeState = "idle" | "loading" | "ready" | "failed" | "disposed";

export interface LayaRuntimeHealth {
	state: LayaRuntimeState;
	circuit: "closed" | "open";
	consecutiveFailures: number;
	version: string;
	revision: string;
	error?: { code: LayaRuntimeErrorCode; message: string };
}

function abortError(): LayaRuntimeError {
	return new LayaRuntimeError("aborted", "Laya request was cancelled");
}

export class LayaDecisionRuntime {
	private readonly options: Required<Omit<LayaDecisionRuntimeOptions, "dir">> & { dir: string };
	private state: LayaRuntimeState = "idle";
	private loading: Promise<LayaClassifierLike> | undefined;
	private classifier: LayaClassifierLike | undefined;
	private lastError: LayaRuntimeError | undefined;
	private consecutiveFailures = 0;
	private openUntil = 0;
	/** Inference is serialized: one ONNX run at a time keeps memory bounded. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: LayaDecisionRuntimeOptions) {
		this.options = {
			dir: options.dir,
			manifest: options.manifest ?? LAYA_NATIVE_MANIFEST,
			timeoutMs: options.timeoutMs ?? 30_000,
			failureThreshold: options.failureThreshold ?? 3,
			cooldownMs: options.cooldownMs ?? 60_000,
			load: options.load ?? ((dir) => LayaOnnxClassifier.load(dir)),
			verify: options.verify ?? verifyNativeModel,
			now: options.now ?? Date.now,
		};
	}

	/** Read through a method: `dispose()` can change the state while a load is awaiting. */
	private isDisposed(): boolean {
		return this.state === "disposed";
	}

	/** Verifies and loads the model once; concurrent callers share the same load. A failed load is not retried. */
	initialize(): Promise<void> {
		if (this.state === "disposed")
			return Promise.reject(new LayaRuntimeError("disposed", "Laya runtime was disposed"));
		if (this.state === "failed" && this.lastError) return Promise.reject(this.lastError);
		this.loading ??= this.load();
		return this.loading.then(() => undefined);
	}

	private async load(): Promise<LayaClassifierLike> {
		this.state = "loading";
		try {
			await this.options.verify(this.options.dir, this.options.manifest);
			const classifier = await this.options.load(this.options.dir);
			if (this.isDisposed()) {
				await classifier.close();
				throw new LayaRuntimeError("disposed", "Laya runtime was disposed while loading");
			}
			this.classifier = classifier;
			this.state = "ready";
			return classifier;
		} catch (error) {
			const failure =
				error instanceof LayaRuntimeError
					? error
					: new LayaRuntimeError("load", `Laya model failed to load: ${String(error)}`, { cause: error });
			if (!this.isDisposed()) this.state = "failed";
			this.lastError = failure;
			throw failure;
		}
	}

	async predict(
		request: string,
		questions: Record<string, LayaQuestionDefinition>,
		signal?: AbortSignal,
	): Promise<Record<string, LayaAnswer>> {
		if (signal?.aborted) throw abortError();
		if (this.options.now() < this.openUntil)
			throw new LayaRuntimeError("circuit_open", "Laya runtime is cooling down after repeated failures");
		await this.initialize();
		const classifier = this.classifier as LayaClassifierLike;
		const run = this.queue.then(() => {
			if (this.state === "disposed") throw new LayaRuntimeError("disposed", "Laya runtime was disposed");
			if (signal?.aborted) throw abortError();
			return classifier.classify(request, questions);
		});
		this.queue = run.catch(() => undefined);

		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const guards = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new LayaRuntimeError("timeout", `Laya did not answer within ${this.options.timeoutMs} ms`)),
				this.options.timeoutMs,
			);
			onAbort = () => reject(abortError());
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		try {
			const answers = await Promise.race([run, guards]);
			this.consecutiveFailures = 0;
			return answers;
		} catch (error) {
			const failure =
				error instanceof LayaRuntimeError
					? error
					: new LayaRuntimeError("inference", `Laya inference failed: ${String(error)}`, { cause: error });
			// A cancellation is the caller's choice, not a runtime fault.
			if (failure.code !== "aborted" && failure.code !== "disposed") {
				this.consecutiveFailures++;
				if (this.consecutiveFailures >= this.options.failureThreshold)
					this.openUntil = this.options.now() + this.options.cooldownMs;
			}
			throw failure;
		} finally {
			clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Requests run one after another; each gets its own timeout. */
	async predictBatch(
		requests: readonly string[],
		questions: Record<string, LayaQuestionDefinition>,
		signal?: AbortSignal,
	): Promise<Array<Record<string, LayaAnswer>>> {
		const results: Array<Record<string, LayaAnswer>> = [];
		for (const request of requests) results.push(await this.predict(request, questions, signal));
		return results;
	}

	health(): LayaRuntimeHealth {
		const open = this.options.now() < this.openUntil;
		return {
			state: this.state,
			circuit: open ? "open" : "closed",
			consecutiveFailures: this.consecutiveFailures,
			version: this.options.manifest.version,
			revision: this.options.manifest.revision,
			...(this.lastError ? { error: { code: this.lastError.code, message: this.lastError.message } } : {}),
		};
	}

	/** Waits for the in-flight request, then releases the model. Later calls reject with `disposed`. */
	async dispose(): Promise<void> {
		if (this.state === "disposed") return;
		this.state = "disposed";
		await this.queue;
		const classifier = this.classifier;
		this.classifier = undefined;
		await classifier?.close();
	}
}
