import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LayaAnswer } from "../src/extensions/laya/native-onnx.ts";
import {
	LAYA_NATIVE_MANIFEST,
	type LayaClassifierLike,
	LayaDecisionRuntime,
	type LayaNativeManifest,
	LayaRuntimeError,
	verifyNativeModel,
} from "../src/extensions/laya/native-runtime.ts";

const QUESTIONS = { ok: { type: "bool" as const, instructions: "ok?" } };
const ANSWER: Record<string, LayaAnswer> = {
	ok: { type: "noul", noul: 0.9, confidence: 0.9, answer_confidence: 0.9, action: { act_probability: 1 } },
};
const verified = async () => {};

function fakeClassifier(classify: LayaClassifierLike["classify"] = async () => ANSWER) {
	const calls = { load: 0, classify: 0, close: 0, active: 0, maxActive: 0 };
	const classifier: LayaClassifierLike = {
		classify: async (request, questions) => {
			calls.classify++;
			calls.active++;
			calls.maxActive = Math.max(calls.maxActive, calls.active);
			try {
				return await classify(request, questions);
			} finally {
				calls.active--;
			}
		},
		close: async () => {
			calls.close++;
		},
	};
	const load = async () => {
		calls.load++;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return classifier;
	};
	return { calls, load };
}

async function rejection(promise: Promise<unknown>): Promise<LayaRuntimeError> {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(LayaRuntimeError);
	return error as LayaRuntimeError;
}

describe("LayaDecisionRuntime", () => {
	it("loads once for concurrent cold-start callers and serializes inference", async () => {
		const { calls, load } = fakeClassifier(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return ANSWER;
		});
		const runtime = new LayaDecisionRuntime({ dir: "unused", load, verify: verified });
		expect(runtime.health().state).toBe("idle");
		const results = await Promise.all([1, 2, 3].map((n) => runtime.predict(`request ${n}`, QUESTIONS)));
		expect(results).toEqual([ANSWER, ANSWER, ANSWER]);
		expect(calls.load).toBe(1);
		expect(calls.maxActive).toBe(1);
		expect(runtime.health()).toMatchObject({
			state: "ready",
			circuit: "closed",
			revision: LAYA_NATIVE_MANIFEST.revision,
		});
		expect(await runtime.predictBatch(["a", "b"], QUESTIONS)).toHaveLength(2);
	});

	it("fails closed on a corrupt or missing checkpoint and does not keep retrying the load", async () => {
		const { calls, load } = fakeClassifier();
		const runtime = new LayaDecisionRuntime({
			dir: "unused",
			load,
			verify: async () => {
				throw new LayaRuntimeError("corrupt", "bad hash");
			},
		});
		expect((await rejection(runtime.predict("x", QUESTIONS))).code).toBe("corrupt");
		expect((await rejection(runtime.predict("x", QUESTIONS))).code).toBe("corrupt");
		expect(calls.load).toBe(0);
		expect(runtime.health()).toMatchObject({ state: "failed", error: { code: "corrupt" } });
	});

	it("wraps unexpected load errors", async () => {
		const runtime = new LayaDecisionRuntime({
			dir: "unused",
			verify: verified,
			load: async () => {
				throw new Error("onnx session failed");
			},
		});
		const error = await rejection(runtime.initialize());
		expect(error.code).toBe("load");
		expect(error.message).toContain("onnx session failed");
	});

	it("times out a slow request without blocking the next one forever", async () => {
		let slow = true;
		const { load } = fakeClassifier(async () => {
			if (slow) {
				slow = false;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			return ANSWER;
		});
		const runtime = new LayaDecisionRuntime({ dir: "unused", load, verify: verified, timeoutMs: 50 });
		expect((await rejection(runtime.predict("slow", QUESTIONS))).code).toBe("timeout");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(await runtime.predict("fast", QUESTIONS)).toEqual(ANSWER);
		expect(runtime.health().consecutiveFailures).toBe(0);
	});

	it("honours cancellation before and during a request without counting it as a failure", async () => {
		const { calls, load } = fakeClassifier(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return ANSWER;
		});
		const runtime = new LayaDecisionRuntime({ dir: "unused", load, verify: verified, failureThreshold: 1 });
		expect((await rejection(runtime.predict("x", QUESTIONS, AbortSignal.abort()))).code).toBe("aborted");
		const controller = new AbortController();
		const pending = runtime.predict("x", QUESTIONS, controller.signal);
		setTimeout(() => controller.abort(), 10);
		expect((await rejection(pending)).code).toBe("aborted");
		expect(runtime.health()).toMatchObject({ circuit: "closed", consecutiveFailures: 0 });
		expect(calls.load).toBe(1);
	});

	it("opens the circuit after repeated failures and lets a request through after the cooldown", async () => {
		let now = 1_000;
		let failing = true;
		const { calls, load } = fakeClassifier(async () => {
			if (failing) throw new Error("boom");
			return ANSWER;
		});
		const runtime = new LayaDecisionRuntime({
			dir: "unused",
			load,
			verify: verified,
			failureThreshold: 2,
			cooldownMs: 500,
			now: () => now,
		});
		expect((await rejection(runtime.predict("x", QUESTIONS))).code).toBe("inference");
		expect((await rejection(runtime.predict("x", QUESTIONS))).code).toBe("inference");
		expect(runtime.health().circuit).toBe("open");
		expect((await rejection(runtime.predict("x", QUESTIONS))).code).toBe("circuit_open");
		expect(calls.classify).toBe(2);
		now += 500;
		failing = false;
		expect(await runtime.predict("x", QUESTIONS)).toEqual(ANSWER);
		expect(runtime.health()).toMatchObject({ circuit: "closed", consecutiveFailures: 0 });
	});

	it("waits for the in-flight request on dispose, releases the model and rejects later calls", async () => {
		const { calls, load } = fakeClassifier(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return ANSWER;
		});
		const runtime = new LayaDecisionRuntime({ dir: "unused", load, verify: verified });
		const pending = runtime.predict("x", QUESTIONS);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await runtime.dispose();
		expect(await pending).toEqual(ANSWER);
		expect(calls.close).toBe(1);
		expect((await rejection(runtime.predict("x", QUESTIONS))).code).toBe("disposed");
		await runtime.dispose();
		expect(calls.close).toBe(1);
	});
});

describe("verifyNativeModel", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	function manifestFor(content: string): LayaNativeManifest {
		return {
			...LAYA_NATIVE_MANIFEST,
			files: [
				{
					path: "config.json",
					asset: "config.json",
					size: Buffer.byteLength(content),
					sha256: createHash("sha256").update(content).digest("hex"),
				},
			],
		};
	}

	it("accepts files whose size and SHA-256 match, offline", async () => {
		dir = mkdtempSync(join(tmpdir(), "relay-laya-native-"));
		writeFileSync(join(dir, "config.json"), "{}");
		await expect(verifyNativeModel(dir, manifestFor("{}"))).resolves.toBeUndefined();
	});

	it("rejects missing, truncated and tampered files", async () => {
		dir = mkdtempSync(join(tmpdir(), "relay-laya-native-"));
		expect((await rejection(verifyNativeModel(dir, manifestFor("{}")))).code).toBe("missing");
		writeFileSync(join(dir, "config.json"), "{ }");
		expect((await rejection(verifyNativeModel(dir, manifestFor("{}")))).code).toBe("corrupt");
		writeFileSync(join(dir, "config.json"), "[]");
		const error = await rejection(verifyNativeModel(dir, manifestFor("{}")));
		expect(error.code).toBe("corrupt");
		expect(error.message).toContain("SHA-256");
	});
});

// Integrity of the real published snapshot (1.3 GB); opt-in like the parity test.
const parityDir = process.env.RELAY_LAYA_PARITY_DIR;
describe.skipIf(!parityDir)("LAYA_NATIVE_MANIFEST against the local snapshot", () => {
	it("matches every published file", { timeout: 300_000 }, async () => {
		await expect(verifyNativeModel(parityDir as string, LAYA_NATIVE_MANIFEST)).resolves.toBeUndefined();
	});
});
