import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ClassifierAnswer } from "@relay-harness/ai";
import type { LayaAnswer, LayaQuestionDefinition } from "./native-onnx.ts";
import {
	LAYA_NATIVE_MANIFEST,
	LayaDecisionRuntime,
	type LayaNativeManifest,
	LayaRuntimeError,
} from "./native-runtime.ts";

/**
 * `laya.runtime: "onnx"`: relay-laya runs in the Relay process through ONNX Runtime, with no Python.
 * `install()` downloads the pinned snapshot once (about 1.3 GB) and verifies every file; later starts
 * only verify the local files and never touch the network. Same surface as the other Laya servers.
 */

const DOWNLOAD_STALL_MS = 120_000;

export interface OnnxLayaServerOptions {
	/** Laya home; the snapshot lives in `<home>/onnx-runtime/<revision>`. */
	home: string;
	manifest?: LayaNativeManifest;
	/** Test seams. */
	fetch?: typeof fetch;
	createRuntime?: (dir: string, manifest: LayaNativeManifest) => LayaDecisionRuntime;
}

function fileUrl(manifest: LayaNativeManifest, asset: string): string {
	return `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${asset}`;
}

function matches(path: string, size: number): boolean {
	try {
		return statSync(path).size === size;
	} catch {
		return false;
	}
}

export class OnnxLayaServer {
	private readonly options: Required<Omit<OnnxLayaServerOptions, "home">> & { home: string };
	private runtime: LayaDecisionRuntime | undefined;
	private installing: Promise<boolean> | undefined;
	private abort: AbortController | undefined;
	state: "unknown" | "installing" | "ready" | "failed" = "unknown";
	detail: string | undefined;

	constructor(options: OnnxLayaServerOptions) {
		this.options = {
			home: options.home,
			manifest: options.manifest ?? LAYA_NATIVE_MANIFEST,
			fetch: options.fetch ?? fetch,
			createRuntime:
				options.createRuntime ?? ((dir, manifest) => new LayaDecisionRuntime({ dir, manifest, timeoutMs: 60_000 })),
		};
	}

	get dir(): string {
		return join(this.options.home, "onnx-runtime", this.options.manifest.revision);
	}

	/** Downloads missing files, verifies the snapshot and loads the model. Concurrent calls share one run. */
	install(report: (message: string) => void = () => {}): Promise<boolean> {
		this.installing ??= this.run(report).finally(() => {
			this.installing = undefined;
		});
		return this.installing;
	}

	private async run(report: (message: string) => void): Promise<boolean> {
		if (this.state === "ready" && this.runtime) return true;
		this.state = "installing";
		this.detail = undefined;
		const abort = new AbortController();
		this.abort = abort;
		try {
			await this.download(report, abort.signal);
			report("verifying the Laya ONNX model");
			const runtime = this.options.createRuntime(this.dir, this.options.manifest);
			await runtime.initialize();
			if (abort.signal.aborted) {
				await runtime.dispose();
				throw new LayaRuntimeError("aborted", "Laya installation was stopped");
			}
			this.runtime = runtime;
			this.state = "ready";
			return true;
		} catch (error) {
			this.state = "failed";
			this.detail = error instanceof Error ? error.message : String(error);
			return false;
		} finally {
			if (this.abort === abort) this.abort = undefined;
		}
	}

	private async download(report: (message: string) => void, signal: AbortSignal): Promise<void> {
		const { manifest } = this.options;
		const missing = manifest.files.filter((file) => !matches(join(this.dir, file.path), file.size));
		const total = missing.reduce((sum, file) => sum + file.size, 0);
		let done = 0;
		for (const file of missing) {
			const target = join(this.dir, file.path);
			const partial = `${target}.part`;
			mkdirSync(dirname(target), { recursive: true });
			let stall: ReturnType<typeof setTimeout> | undefined;
			const stalled = new AbortController();
			const armStall = () => {
				clearTimeout(stall);
				stall = setTimeout(() => stalled.abort(), DOWNLOAD_STALL_MS);
			};
			try {
				armStall();
				const response = await this.options.fetch(fileUrl(manifest, file.asset), {
					signal: AbortSignal.any([signal, stalled.signal]),
				});
				if (!response.ok || !response.body)
					throw new LayaRuntimeError("missing", `Downloading ${file.asset} failed with HTTP ${response.status}`);
				const hash = createHash("sha256");
				let lastPercent = -1;
				const progress = new Transform({
					transform: (chunk: Buffer, _encoding, callback) => {
						armStall();
						hash.update(chunk);
						done += chunk.length;
						const percent = Math.floor((done / total) * 100);
						if (percent !== lastPercent) {
							lastPercent = percent;
							report(`downloading the Laya ONNX model (${percent}% of ${Math.round(total / 1e6)} MB)`);
						}
						callback(null, chunk);
					},
				});
				await pipeline(
					Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
					progress,
					createWriteStream(partial),
				);
				const digest = hash.digest("hex");
				if (digest !== file.sha256)
					throw new LayaRuntimeError(
						"corrupt",
						`Downloaded ${file.asset} has SHA-256 ${digest}, expected ${file.sha256}`,
					);
				renameSync(partial, target);
			} catch (error) {
				rmSync(partial, { force: true });
				if (stalled.signal.aborted && !signal.aborted)
					throw new LayaRuntimeError("timeout", `Downloading ${file.asset} stalled for ${DOWNLOAD_STALL_MS} ms`);
				if (signal.aborted) throw new LayaRuntimeError("aborted", "Laya installation was stopped");
				throw error;
			} finally {
				clearTimeout(stall);
			}
		}
	}

	async isUp(): Promise<boolean> {
		return this.state === "ready" && this.runtime?.health().state === "ready";
	}

	/** Answers through the loaded model. Rejects with `LayaRuntimeError` when it is not ready or fails. */
	async classify(
		request: string,
		questions: Record<string, LayaQuestionDefinition>,
		signal?: AbortSignal,
	): Promise<Record<string, LayaAnswer>> {
		if (!this.runtime || this.state !== "ready")
			throw new LayaRuntimeError("load", `Laya ONNX runtime is not ready (${this.describe()})`);
		return this.runtime.predict(request, questions, signal);
	}

	async stop(): Promise<void> {
		this.abort?.abort();
		await this.installing;
		const runtime = this.runtime;
		this.runtime = undefined;
		await runtime?.dispose();
		this.state = "unknown";
	}

	describe(): string {
		if (this.state === "ready") return `running in-process with ONNX Runtime (${this.options.manifest.version})`;
		if (this.state === "installing") return "installing the ONNX runtime";
		if (this.state === "failed") return `failed: ${this.detail}`;
		return existsSync(this.dir) ? "ONNX model present, not loaded yet" : "not checked yet";
	}
}

/** The classifier answers the System One client returns for the same response (see `parseAnswers` in @relay-harness/ai). */
export function toClassifierAnswers(answers: Record<string, LayaAnswer>): Record<string, ClassifierAnswer> {
	return Object.fromEntries(
		Object.entries(answers).map(([id, answer]): [string, ClassifierAnswer] => {
			if (answer.type === "choice")
				return [
					id,
					{
						type: "choice",
						choice: answer.choice,
						probabilities: answer.probabilities,
						confidence: answer.answer_confidence,
					},
				];
			if (answer.type === "score")
				return [id, { type: "score", score: answer.score, confidence: answer.answer_confidence }];
			return [id, { type: "bool", probability: answer.noul }];
		}),
	);
}

const servers = new Map<string, OnnxLayaServer>();

/** One loaded model per Laya home in a process; the model takes several GB of memory. */
export function sharedOnnxLayaServer(options: OnnxLayaServerOptions): OnnxLayaServer {
	let server = servers.get(options.home);
	if (!server) {
		server = new OnnxLayaServer(options);
		servers.set(options.home, server);
	}
	return server;
}
