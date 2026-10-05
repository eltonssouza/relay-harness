import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { type LayaModelManifest, type LayaPaths, runtimeStatus } from "./runtime.ts";

const HEALTH_TIMEOUT_MS = 1500;
const START_TIMEOUT_MS = 120_000;
const POLL_MS = 500;

export interface LayaServerOptions {
	paths: LayaPaths;
	manifest: LayaModelManifest;
	/** The configured System One URL, e.g. `http://127.0.0.1:8000/v1`. */
	baseUrl: () => string;
	fetch?: typeof fetch;
}

/** Whether a URL points at this machine, the only place Relay starts a server. */
export function isLocalUrl(url: string): boolean {
	try {
		return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
	} catch {
		return false;
	}
}

/** Starts and stops the local Laya server. A server that is already listening is used, never replaced. */
export class LayaServer {
	private readonly options: LayaServerOptions;
	private child: ChildProcess | undefined;
	private starting: Promise<boolean> | undefined;

	constructor(options: LayaServerOptions) {
		this.options = options;
	}

	status() {
		return runtimeStatus(this.options.manifest, this.options.paths);
	}

	async isUp(): Promise<boolean> {
		const request = this.options.fetch ?? globalThis.fetch;
		try {
			const response = await request(new URL("/health", this.options.baseUrl()), {
				signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			});
			return response.ok && ((await response.json()) as { ok?: boolean }).ok === true;
		} catch {
			return false;
		}
	}

	/** True when a server answers, starting ours first if the runtime is installed. Concurrent calls share one start. */
	ensureRunning(signal?: AbortSignal): Promise<boolean> {
		this.starting ??= this.startIfNeeded(signal).finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async startIfNeeded(signal?: AbortSignal): Promise<boolean> {
		if (await this.isUp()) return true;
		if (this.status() !== "ready" || !isLocalUrl(this.options.baseUrl())) return false;
		const { hostname, port } = new URL(this.options.baseUrl());
		const { paths } = this.options;
		mkdirSync(dirname(paths.log), { recursive: true });
		const log = openSync(paths.log, "a");
		try {
			this.child = spawn(
				paths.venvPython,
				[
					paths.serveScript,
					"--model",
					paths.model,
					"--host",
					hostname.replace(/^\[|\]$/g, ""),
					"--port",
					port || "8000",
				],
				{
					stdio: ["ignore", log, log],
					windowsHide: true,
					env: {
						...process.env,
						USE_TF: "0",
						HF_HUB_OFFLINE: "1",
						TRANSFORMERS_OFFLINE: "1",
						PYTHONIOENCODING: "utf-8",
					},
				},
			);
		} finally {
			closeSync(log);
		}
		const child = this.child;
		let exited = false;
		child.once("exit", () => {
			exited = true;
			if (this.child === child) this.child = undefined;
		});
		child.once("error", () => {
			exited = true;
		});
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (Date.now() < deadline && !exited && !signal?.aborted) {
			if (await this.isUp()) return true;
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
		this.stop();
		return false;
	}

	/** Stops the server this process started. */
	stop(): void {
		const child = this.child;
		this.child = undefined;
		if (!child?.pid) return;
		if (process.platform === "win32") {
			// The venv launcher spawns the real interpreter; kill the whole tree.
			spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
		} else {
			child.kill();
		}
	}

	get running(): boolean {
		return this.child !== undefined;
	}
}
