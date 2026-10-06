import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAYA_MODEL_MANIFEST } from "../src/extensions/laya/model-manifest.ts";
import {
	downloadModel,
	type ExecFunction,
	findPython,
	type LayaModelManifest,
	layaPaths,
	missingModelFiles,
	runtimeStatus,
	SERVE_SCRIPT,
} from "../src/extensions/laya/runtime.ts";
import { isLocalUrl, LayaServer } from "../src/extensions/laya/server.ts";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

const manifest: LayaModelManifest = {
	version: "v-test",
	layaPackage: "laya[serve]==0.0.0",
	baseUrl: "https://example.test/releases/",
	files: [
		{ path: "model.safetensors", asset: "model.safetensors", size: 5, sha256: sha256("model") },
		{ path: "tokenizer/tokenizer.json", asset: "tokenizer__tokenizer.json", size: 4, sha256: sha256("tok1") },
	],
};

const assets: Record<string, string> = { "model.safetensors": "model", "tokenizer__tokenizer.json": "tok1" };

function fakeFetch(served: Record<string, string>, requested: string[] = []): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0]) => {
		const name = new URL(String(input)).pathname.split("/").at(-1) ?? "";
		requested.push(name);
		return name in served ? new Response(served[name]) : new Response("missing", { status: 404 });
	}) as typeof fetch;
}

describe("laya runtime", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "relay-laya-runtime-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("downloads every file into its path and verifies the hash", async () => {
		const paths = layaPaths(home, manifest);
		expect(missingModelFiles(manifest, paths)).toHaveLength(2);

		await downloadModel(manifest, paths, { fetch: fakeFetch(assets) });

		expect(readFileSync(join(paths.model, "model.safetensors"), "utf8")).toBe("model");
		expect(readFileSync(join(paths.model, "tokenizer", "tokenizer.json"), "utf8")).toBe("tok1");
		expect(missingModelFiles(manifest, paths)).toEqual([]);
	});

	it("rejects a file whose hash differs and leaves nothing behind", async () => {
		const paths = layaPaths(home, manifest);
		// Same size as the manifest, different content: only the hash catches it.
		await expect(
			downloadModel(manifest, paths, { fetch: fakeFetch({ ...assets, "model.safetensors": "MODEL" }) }),
		).rejects.toThrow(/does not match the manifest/);
		expect(existsSync(join(paths.model, "model.safetensors"))).toBe(false);
		expect(existsSync(join(paths.model, "model.safetensors.part"))).toBe(false);
	});

	it("fails on an HTTP error", async () => {
		await expect(downloadModel(manifest, layaPaths(home, manifest), { fetch: fakeFetch({}) })).rejects.toThrow(
			/HTTP 404/,
		);
	});

	it("downloads only what is missing or has the wrong size", async () => {
		const paths = layaPaths(home, manifest);
		mkdirSync(paths.model, { recursive: true });
		writeFileSync(join(paths.model, "model.safetensors"), "model");
		const requested: string[] = [];

		await downloadModel(manifest, paths, { fetch: fakeFetch(assets, requested) });
		expect(requested).toEqual(["tokenizer__tokenizer.json"]);

		writeFileSync(join(paths.model, "model.safetensors"), "tru");
		requested.length = 0;
		await downloadModel(manifest, paths, { fetch: fakeFetch(assets, requested) });
		expect(requested).toEqual(["model.safetensors"]);
	});

	it("reports the runtime status", async () => {
		const paths = layaPaths(home, manifest);
		expect(runtimeStatus(manifest, paths)).toBe("missing-environment");
		mkdirSync(join(paths.venvPython, ".."), { recursive: true });
		writeFileSync(paths.venvPython, "");
		writeFileSync(paths.serveScript, SERVE_SCRIPT);
		expect(runtimeStatus(manifest, paths)).toBe("missing-model");
		await downloadModel(manifest, paths, { fetch: fakeFetch(assets) });
		expect(runtimeStatus(manifest, paths)).toBe("ready");
	});

	it("picks the first Python between 3.10 and 3.13", async () => {
		const versions: Record<string, string> = { python3: "3.9", python: "3.14", py: "3.12" };
		const exec: ExecFunction = async (command) =>
			command in versions
				? { stdout: `3 ${versions[command].split(".")[1]}\n`, stderr: "", code: 0 }
				: { stdout: "", stderr: "", code: 1 };
		expect(await findPython(exec)).toEqual(["py", ["-3"]]);
		expect(await findPython(exec, "python3")).toBeUndefined();
		const failing: ExecFunction = async () => {
			throw new Error("not found");
		};
		expect(await findPython(failing)).toBeUndefined();
	});

	it("ships a manifest that matches the model layout the server loads", () => {
		const paths = LAYA_MODEL_MANIFEST.files.map((file) => file.path);
		expect(paths).toEqual(
			expect.arrayContaining([
				"model.safetensors",
				"rl_agent_config.json",
				"encoder/config.json",
				"tokenizer/tokenizer.json",
			]),
		);
		for (const file of LAYA_MODEL_MANIFEST.files) {
			expect(file.asset).toBe(file.path);
			expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(LAYA_MODEL_MANIFEST.baseUrl).toMatch(/^https:\/\/.+\/$/);
	});

	it("starts servers only on this machine and reuses one that is already listening", async () => {
		expect(isLocalUrl("http://127.0.0.1:8000/v1")).toBe(true);
		expect(isLocalUrl("http://localhost:8000/v1")).toBe(true);
		expect(isLocalUrl("https://laya.example.com/v1")).toBe(false);

		let healthChecks = 0;
		const listening = (async () => {
			healthChecks++;
			return new Response(JSON.stringify({ ok: true }));
		}) as typeof fetch;
		const server = new LayaServer({
			paths: layaPaths(home, manifest),
			manifest,
			baseUrl: () => "http://127.0.0.1:8000/v1",
			fetch: listening,
		});
		// Nothing is installed, yet an answering server counts: the user may run their own.
		expect(await server.ensureRunning()).toBe(true);
		expect(server.running).toBe(false);
		expect(healthChecks).toBe(1);

		const down = new LayaServer({
			paths: layaPaths(home, manifest),
			manifest,
			baseUrl: () => "http://127.0.0.1:8000/v1",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as typeof fetch,
		});
		// Not installed and not answering: nothing to start.
		expect(await down.ensureRunning()).toBe(false);
	});
});
