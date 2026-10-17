import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { getEngineeringResourcesPath } from "../../config.ts";
import { LAYA_QUESTIONS } from "./questions.ts";
import type { LayaModelManifest } from "./runtime.ts";
import { isLocalUrl } from "./server.ts";

export interface NativeLayaServerOptions {
	home: string;
	manifest: LayaModelManifest;
	baseUrl: () => string;
	/** Python executable override, passed as an executable path, never through a shell. */
	python: () => string | undefined;
}

/** CPU inference using the original checkpoint in a private Python environment. */
export class NativeLayaServer {
	private options: NativeLayaServerOptions;
	private child: ChildProcess | undefined;
	private installing: Promise<boolean> | undefined;
	private abort: AbortController | undefined;
	state: "unknown" | "installing" | "ready" | "failed" = "unknown";
	detail: string | undefined;

	constructor(options: NativeLayaServerOptions) {
		this.options = options;
	}

	configure(options: NativeLayaServerOptions): void {
		this.options = options;
	}

	async isUp(): Promise<boolean> {
		try {
			const response = await fetch(new URL("/health", this.options.baseUrl()), {
				signal: AbortSignal.timeout(1500),
			});
			if (!response.ok) return false;
			const body = (await response.json()) as { ok?: boolean; decisions?: string[] };
			if (body.ok !== true) return false;
			if (body.decisions && !Object.keys(LAYA_QUESTIONS).every((id) => body.decisions?.includes(id))) {
				throw new Error("The server on laya.baseUrl answers a different decision contract");
			}
			return true;
		} catch (error) {
			if (error instanceof Error && error.message.includes("decision contract")) throw error;
			return false;
		}
	}

	install(report: (message: string) => void = () => {}): Promise<boolean> {
		this.installing ??= this.run(report).finally(() => {
			this.installing = undefined;
		});
		return this.installing;
	}

	private async command(
		command: string,
		args: string[],
		signal: AbortSignal,
		report?: (message: string) => void,
	): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			signal.throwIfAborted();
			const child = spawn(command, args, {
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			// Setup launches pip children. Stop the entire owned process tree before releasing its lock.
			const terminate = () => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				if (child.pid && process.platform === "win32") {
					const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
						windowsHide: true,
						stdio: "ignore",
					});
					killer.once("error", () => child.kill());
				} else if (child.pid) {
					try {
						process.kill(-child.pid, "SIGTERM");
					} catch {
						child.kill();
					}
				} else {
					child.kill();
				}
			};
			const timer = globalThis.setTimeout(terminate, report ? 60 * 60_000 : 10_000);
			timer.unref();
			signal.addEventListener("abort", terminate, { once: true });
			let output = "";
			for (const stream of [child.stdout, child.stderr]) {
				stream.setEncoding("utf8").on("data", (chunk: string) => {
					output = (output + chunk).slice(-4000);
					for (const line of chunk.split(/\r?\n/)) if (line.trim()) report?.(line.trim());
				});
			}
			child.once("error", reject);
			child.once("close", (code) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", terminate);
				if (signal.aborted) reject(signal.reason);
				else if (code === 0) resolve();
				else reject(new Error(output.trim() || `${command} exited with code ${code}`));
			});
		});
	}

	private async run(report: (message: string) => void): Promise<boolean> {
		this.state = "installing";
		this.detail = undefined;
		this.abort = new AbortController();
		const signal = this.abort.signal;
		let release: (() => Promise<void>) | undefined;
		try {
			if (await this.isUp()) {
				this.state = "ready";
				return true;
			}
			const url = new URL(this.options.baseUrl());
			if (!isLocalUrl(url.href))
				throw new Error(`${url.href} does not answer; remote servers are not managed by Relay`);
			if (url.protocol !== "http:" || url.pathname.replace(/\/$/, "") !== "/v1") {
				throw new Error("Local Laya requires an http://localhost:<port>/v1 base URL");
			}
			const root = join(this.options.home, "local-runtime");
			mkdirSync(root, { recursive: true });
			report("preparing local CPU runtime (no Docker or CUDA)");
			const lockDeadline = Date.now() + 60 * 60_000;
			while (!release) {
				signal.throwIfAborted();
				try {
					release = await lockfile.lock(root, { stale: 120_000 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= lockDeadline) throw error;
					await setTimeout(1000, undefined, { signal });
				}
			}
			signal.throwIfAborted();
			// Another session may have finished installation and started serving while we waited.
			if (await this.isUp()) {
				this.state = "ready";
				return true;
			}
			const script = join(getEngineeringResourcesPath(), "laya", "local-runtime.py");
			const serveScript = join(getEngineeringResourcesPath(), "laya", "local-serve.py");
			const manifest = join(root, "manifest.json");
			writeFileSync(manifest, `${JSON.stringify(this.options.manifest, null, 2)}\n`);
			const configured = this.options.python();
			const candidates: Array<[string, string[]]> = configured
				? [[configured, []]]
				: process.platform === "win32"
					? [
							["py", ["-3.11"]],
							["python", []],
							["py", ["-3.13"]],
						]
					: [
							["python3", []],
							["python", []],
						];
			let python: [string, string[]] | undefined;
			for (const candidate of candidates) {
				try {
					await this.command(
						candidate[0],
						[
							...candidate[1],
							"-I",
							"-c",
							"import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)",
						],
						signal,
					);
					python = candidate;
					break;
				} catch {
					signal.throwIfAborted();
				}
			}
			if (!python)
				throw new Error("Python 3.10–3.13 is required; install Python or set laya.python to its executable path");
			await this.command(
				python[0],
				[...python[1], "-I", script, "setup", "--root", root, "--manifest", manifest],
				signal,
				report,
			);
			signal.throwIfAborted();
			const executable = join(root, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
			const log = join(root, "server.log");
			const fd = openSync(log, "a");
			let spawnError: Error | undefined;
			try {
				this.child = spawn(
					executable,
					[
						"-I",
						serveScript,
						"serve",
						"--root",
						root,
						"--manifest",
						manifest,
						"--host",
						url.hostname.replace(/^\[|\]$/g, ""),
						"--port",
						url.port || "80",
					],
					{ windowsHide: true, stdio: ["ignore", fd, fd] },
				);
				this.child.once("error", (error) => {
					spawnError = error;
				});
				const child = this.child;
				const cleanup = () => {
					child.kill();
				};
				process.once("exit", cleanup);
				child.once("close", () => process.removeListener("exit", cleanup));
				child.unref();
			} finally {
				closeSync(fd);
			}
			report("loading the trained Laya model on CPU");
			const deadline = Date.now() + 180_000;
			while (Date.now() < deadline) {
				signal.throwIfAborted();
				if (spawnError) throw spawnError;
				if (this.child.exitCode !== null || this.child.signalCode !== null)
					throw new Error(readFileSync(log, "utf8").slice(-2000));
				if (await this.isUp()) {
					this.state = "ready";
					return true;
				}
				await setTimeout(1000, undefined, { signal });
			}
			throw new Error(`Laya did not start in time; see ${log}`);
		} catch (error) {
			this.child?.kill();
			this.child = undefined;
			this.state = "failed";
			this.detail = error instanceof Error ? error.message : String(error);
			return false;
		} finally {
			await release?.();
		}
	}

	async stop(): Promise<void> {
		this.abort?.abort();
		await this.installing;
		const child = this.child;
		if (child && child.exitCode === null && child.signalCode === null) {
			await new Promise<void>((resolve) => {
				child.ref();
				child.once("close", () => resolve());
				child.kill();
			});
		}
		this.child = undefined;
		this.state = "unknown";
	}

	describe(): string {
		if (this.state === "ready") return `running locally on CPU (${this.options.manifest.version})`;
		if (this.state === "installing") return "installing locally on CPU";
		if (this.state === "failed") return `failed: ${this.detail}`;
		return "not checked yet";
	}
}

const servers = new Map<string, NativeLayaServer>();

/** Sessions in one process share ownership so model changes and shutdown can stop their server. */
export function sharedNativeLayaServer(options: NativeLayaServerOptions): NativeLayaServer {
	let server = servers.get(options.home);
	if (!server) {
		server = new NativeLayaServer(options);
		servers.set(options.home, server);
	} else {
		server.configure(options);
	}
	return server;
}
