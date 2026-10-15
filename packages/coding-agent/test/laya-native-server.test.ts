import type * as ChildProcessModule from "node:child_process";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeLayaServer } from "../src/extensions/laya/native-server.ts";
import type { LayaModelManifest } from "../src/extensions/laya/runtime.ts";

vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof ChildProcessModule>();
	// These processes are never spawned. Mock termination in every test scenario.
	class MockChildProcess extends actual.ChildProcess {
		override kill = vi.fn(() => false);
	}
	return { ...actual, ChildProcess: MockChildProcess, spawn: vi.fn() };
});

const manifest: LayaModelManifest = {
	version: "v-test",
	layaPackage: "laya[serve]==0.3.27",
	baseUrl: "https://example.invalid/pinned/",
	files: [],
};

describe("native Laya server", () => {
	let home: string;
	let laya: NativeLayaServer;
	let up: boolean;
	let children: ChildProcess[];

	beforeEach(() => {
		vi.mocked(spawn).mockReset();
		home = mkdtempSync(join(tmpdir(), "relay-laya-native-"));
		up = false;
		children = [];
		laya = new NativeLayaServer({
			home,
			manifest,
			baseUrl: () => "http://127.0.0.1:8737/v1",
			python: () => "test-python",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				if (!up) throw new Error("ECONNREFUSED");
				return new Response(JSON.stringify({ ok: true }));
			}),
		);
		vi.mocked(spawn).mockImplementation((_command, args) => {
			const child = new ChildProcess();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			children.push(child);
			vi.spyOn(child, "ref");
			vi.spyOn(child, "kill").mockImplementation(() => {
				Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
				up = false;
				queueMicrotask(() => child.emit("close", 0));
				return true;
			});
			if (args?.includes("serve")) up = true;
			else
				queueMicrotask(() => {
					Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
					child.emit("close", 0);
				});
			return child;
		});
	});

	afterEach(async () => {
		await laya.stop();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("installs and starts the exact checkpoint locally without invoking Docker", async () => {
		const reports: string[] = [];
		const first = laya.install((message) => reports.push(message));
		expect(laya.install()).toBe(first);
		expect(await first).toBe(true);
		expect(laya.describe()).toContain("running locally on CPU");
		const calls = vi.mocked(spawn).mock.calls;
		expect(calls).toHaveLength(3);
		expect(calls[1][0]).toBe("test-python");
		expect(calls[1][1]).toEqual(expect.arrayContaining(["-I", "setup", "--root", join(home, "local-runtime")]));
		expect(calls[2][0]).toContain(join("local-runtime", "venv"));
		expect(calls[2][1]).toEqual(expect.arrayContaining(["serve", "--host", "127.0.0.1", "--port", "8737"]));
		expect(calls.every(([command]) => command !== "docker")).toBe(true);
		expect(reports).toContain("loading the trained Laya model on CPU");
		expect(existsSync(join(home, "local-runtime.lock"))).toBe(false);
		await laya.stop();
		expect(children.at(-1)?.kill).toHaveBeenCalledOnce();
		expect(children.at(-1)?.ref).toHaveBeenCalledOnce();
		expect(laya.state).toBe("unknown");
	});

	it("uses an existing healthy server without provisioning Python", async () => {
		up = true;
		expect(await laya.install()).toBe(true);
		expect(spawn).not.toHaveBeenCalled();
		await laya.stop();
		expect(up).toBe(true);
		expect(existsSync(join(home, "local-runtime"))).toBe(false);
	});

	it("does not wait for another close event after a server was killed externally", async () => {
		expect(await laya.install()).toBe(true);
		const child = children.at(-1)!;
		Object.defineProperty(child, "signalCode", { value: "SIGTERM" });
		child.emit("close", null, "SIGTERM");
		await laya.stop();
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("reports a missing Python and leaves keyword fallback available", async () => {
		vi.mocked(spawn).mockImplementation(() => {
			const child = new ChildProcess();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			queueMicrotask(() => child.emit("error", new Error("ENOENT")));
			return child;
		});
		expect(await laya.install()).toBe(false);
		expect(laya.state).toBe("failed");
		expect(laya.detail).toContain("set laya.python");
	});

	it("reports setup failure without starting a server", async () => {
		vi.mocked(spawn)
			.mockImplementationOnce(() => {
				const child = new ChildProcess();
				child.stdout = new PassThrough();
				child.stderr = new PassThrough();
				queueMicrotask(() => child.emit("close", 0));
				return child;
			})
			.mockImplementationOnce(() => {
				const child = new ChildProcess();
				child.stdout = new PassThrough();
				child.stderr = new PassThrough();
				queueMicrotask(() => {
					child.stderr?.emit("data", "model.safetensors does not match the pinned manifest");
					child.emit("close", 1);
				});
				return child;
			});
		expect(await laya.install()).toBe(false);
		expect(laya.detail).toContain("pinned manifest");
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it("never provisions a remote host or a managed HTTPS endpoint", async () => {
		for (const url of ["http://remote.invalid/v1", "https://127.0.0.1:8737/v1"]) {
			laya = new NativeLayaServer({ home, manifest, baseUrl: () => url, python: () => undefined });
			expect(await laya.install()).toBe(false);
		}
		expect(spawn).not.toHaveBeenCalled();
	});

	it("refuses an incompatible server without installing or stopping it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ ok: true, decisions: ["other"] }))),
		);
		expect(await laya.install()).toBe(false);
		expect(laya.detail).toContain("different decision contract");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("can cancel while another process holds the installation lock", async () => {
		const root = join(home, "local-runtime");
		mkdirSync(root);
		const release = await lockfile.lock(root);
		try {
			const pending = laya.install();
			await vi.waitFor(() => expect(laya.state).toBe("installing"));
			await laya.stop();
			expect(await pending).toBe(false);
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			await release();
		}
	});

	it("cancels the owned setup process tree before releasing the installation lock", async () => {
		let setupChild: ChildProcess | undefined;
		vi.spyOn(process, "kill").mockImplementation(() => {
			queueMicrotask(() => setupChild?.emit("close", null, "SIGTERM"));
			return true;
		});
		vi.mocked(spawn).mockImplementation((command, args) => {
			const child = new ChildProcess();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			if (args?.includes("setup")) {
				setupChild = child;
				Object.defineProperty(child, "pid", { value: 123 });
			} else {
				queueMicrotask(() => {
					if (command === "taskkill") setupChild?.emit("close", null, "SIGTERM");
					child.emit("close", 0);
				});
			}
			return child;
		});
		const pending = laya.install();
		await vi.waitFor(() => expect(setupChild).toBeDefined());
		await laya.stop();
		expect(await pending).toBe(false);
		expect(existsSync(join(home, "local-runtime.lock"))).toBe(false);
		if (process.platform === "win32") {
			expect(spawn).toHaveBeenCalledWith(
				"taskkill",
				["/PID", "123", "/T", "/F"],
				expect.objectContaining({ windowsHide: true }),
			);
		} else {
			expect(process.kill).toHaveBeenCalledWith(-123, "SIGTERM");
		}
	});

	it("reports an early model-loading crash from the local log", async () => {
		vi.mocked(spawn)
			.mockImplementationOnce(() => {
				const child = new ChildProcess();
				child.stdout = new PassThrough();
				child.stderr = new PassThrough();
				queueMicrotask(() => child.emit("close", 0));
				return child;
			})
			.mockImplementationOnce(() => {
				const child = new ChildProcess();
				child.stdout = new PassThrough();
				child.stderr = new PassThrough();
				queueMicrotask(() => child.emit("close", 0));
				return child;
			})
			.mockImplementationOnce(() => {
				const child = new ChildProcess();
				Object.defineProperty(child, "exitCode", { value: 1 });
				writeFileSync(join(home, "local-runtime", "server.log"), "checkpoint loading failed");
				queueMicrotask(() => child.emit("close", 1));
				return child;
			});
		expect(await laya.install()).toBe(false);
		expect(laya.detail).toContain("checkpoint loading failed");
	});
});
