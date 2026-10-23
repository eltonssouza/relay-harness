import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessmentFromAnswers } from "../src/extensions/laya/assessment.ts";
import type { LayaAnswer } from "../src/extensions/laya/native-onnx.ts";
import {
	LAYA_NATIVE_MANIFEST,
	LayaDecisionRuntime,
	type LayaNativeManifest,
} from "../src/extensions/laya/native-runtime.ts";
import { OnnxLayaServer, toClassifierAnswers } from "../src/extensions/laya/onnx-server.ts";

const FILES: Record<string, string> = { "config.json": '{"a":1}', "onnx/laya.onnx": "weights" };

function manifest(): LayaNativeManifest {
	return {
		...LAYA_NATIVE_MANIFEST,
		revision: "test-revision",
		files: Object.entries(FILES).map(([path, content]) => ({
			path,
			asset: `remote/${path}`,
			size: Buffer.byteLength(content),
			sha256: createHash("sha256").update(content).digest("hex"),
		})),
	};
}

const ANSWERS: Record<string, LayaAnswer> = {
	ok: { type: "noul", noul: 0.8, confidence: 0.8, answer_confidence: 0.8, action: { act_probability: 1 } },
};

function fakeRuntime(dir: string, m: LayaNativeManifest) {
	return new LayaDecisionRuntime({
		dir,
		manifest: m,
		load: async () => ({ classify: async () => ANSWERS, close: async () => {} }),
	});
}

describe("OnnxLayaServer", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "relay-laya-onnx-"));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	function fetchServing(content: (asset: string) => string | undefined, seen: string[] = []): typeof fetch {
		return (async (input: string | URL | Request) => {
			const url = String(input);
			seen.push(url);
			const asset = url.split("/resolve/test-revision/")[1] ?? "";
			const body = content(asset);
			return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
		}) as typeof fetch;
	}

	it("downloads the pinned files once, verifies them and then works offline", async () => {
		const seen: string[] = [];
		const progress: string[] = [];
		const server = new OnnxLayaServer({
			home,
			manifest: manifest(),
			fetch: fetchServing((asset) => FILES[asset.replace("remote/", "")], seen),
			createRuntime: fakeRuntime,
		});
		expect(await server.install((message) => progress.push(message))).toBe(true);
		expect(seen).toEqual([
			"https://huggingface.co/eltonssouza/relay-laya/resolve/test-revision/remote/config.json",
			"https://huggingface.co/eltonssouza/relay-laya/resolve/test-revision/remote/onnx/laya.onnx",
		]);
		expect(readFileSync(join(server.dir, "onnx/laya.onnx"), "utf8")).toBe("weights");
		expect(progress.at(-1)).toBe("verifying the Laya ONNX model");
		expect(await server.isUp()).toBe(true);
		expect(await server.classify("fix it", { ok: { type: "bool", instructions: "ok?" } })).toEqual(ANSWERS);
		await server.stop();
		expect(await server.isUp()).toBe(false);

		const offline = new OnnxLayaServer({
			home,
			manifest: manifest(),
			fetch: (async () => {
				throw new Error("network must not be used");
			}) as typeof fetch,
			createRuntime: fakeRuntime,
		});
		expect(await offline.install()).toBe(true);
		expect(offline.describe()).toContain("ONNX Runtime");
	});

	it("rejects a tampered download, removes the partial file and reports the failure", async () => {
		const server = new OnnxLayaServer({
			home,
			manifest: manifest(),
			fetch: fetchServing((asset) =>
				asset.endsWith("laya.onnx") ? "WEIGHTS" : FILES[asset.replace("remote/", "")],
			),
			createRuntime: fakeRuntime,
		});
		expect(await server.install()).toBe(false);
		expect(server.state).toBe("failed");
		expect(server.describe()).toContain("SHA-256");
		expect(existsSync(join(server.dir, "onnx/laya.onnx"))).toBe(false);
		expect(existsSync(join(server.dir, "onnx/laya.onnx.part"))).toBe(false);
		await expect(server.classify("x", {})).rejects.toMatchObject({ code: "load" });
	});

	it("fails without crashing when the repository is unreachable", async () => {
		const server = new OnnxLayaServer({
			home,
			manifest: manifest(),
			fetch: fetchServing(() => undefined),
			createRuntime: fakeRuntime,
		});
		expect(await server.install()).toBe(false);
		expect(server.describe()).toContain("HTTP 404");
	});
});

describe("toClassifierAnswers", () => {
	it("matches what the System One client returns, so assessments are identical", () => {
		const reference = JSON.parse(
			readFileSync(join(__dirname, "fixtures", "aci-laya-parity-reference.json"), "utf8"),
		) as { cases: Array<{ answers: Record<string, LayaAnswer> }> };
		const converted = toClassifierAnswers(reference.cases[0]?.answers ?? {});
		expect(converted.task_type).toMatchObject({ type: "choice", choice: "question" });
		expect(converted.requires_write).toMatchObject({ type: "bool" });
		expect(converted.complexity).toMatchObject({ type: "score" });
		for (const item of reference.cases)
			expect(() => assessmentFromAnswers(toClassifierAnswers(item.answers))).not.toThrow();
		expect(assessmentFromAnswers(converted)).toMatchObject({ source: "laya", task: { type: "question" } });
	});
});
