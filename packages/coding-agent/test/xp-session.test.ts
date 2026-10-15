import { cpSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@relay-harness/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import xpExtension from "../src/extensions/xp/index.ts";
import type { XpState } from "../src/extensions/xp/workflow.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { xpTestProvider } from "./xp-test-support.ts";

const call = (name: string, args: JsonObject) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const intent = (continueTask = false) => call("xp_intent", { kind: "task", testsRequired: false, continueTask });
const checkpoint = (summary: string) => call("xp_checkpoint", { summary, evidenceIds: [] });
const latest = (harness: Harness): XpState | undefined => {
	const entry = harness.sessionManager
		.getBranch()
		.findLast((item) => item.type === "custom" && item.customType === "xp.state");
	return entry?.type === "custom" ? (entry.data as XpState) : undefined;
};

describe("Laya-directed XP sessions", () => {
	const harnesses: Harness[] = [];
	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(JSON.stringify({ ok: true, version: "relay-laya-v4" })),
		);
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});
	async function setup(provider = xpTestProvider(), sessionManager?: Harness["sessionManager"]) {
		const harness = await createHarness({
			tools: [],
			sessionManager,
			settings: { harnessCore: { evidence: false } },
			extensionFactories: [provider, xpExtension],
		});
		harnesses.push(harness);
		await harness.session.modelRuntime.refresh({ allowNetwork: false });
		await harness.session.bindExtensions({});
		return harness;
	}
	it("runs an explicit /xp task through all five phases without user acceptance", async () => {
		const harness = await setup();
		harness.setResponses([
			intent(),
			checkpoint("Requirements"),
			fauxAssistantMessage("Planning complete"),
			checkpoint("Design"),
			checkpoint("Review strategy"),
			checkpoint("Implemented"),
			checkpoint("Verified"),
			fauxAssistantMessage("Delivered"),
		]);
		await harness.session.prompt("/xp start Document the task workflow");
		await vi.waitFor(() => expect(latest(harness)?.status).toBe("completed"));
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({ phase: "listening", accepted: false, listeningReported: true });
		const traces = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "xp.decision");
		expect(traces).toHaveLength(5);
		for (const trace of traces) expect(trace).toMatchObject({ data: { source: "laya", model: "relay-laya-v4" } });
	});
	it("preserves state and refuses deterministic fallback when the classifier fails", async () => {
		let failed = true;
		const provider = xpTestProvider((_context, result) =>
			failed ? { ...result, stopReason: "error", errorMessage: "classifier down" } : result,
		);
		const harness = await setup(provider);
		harness.setResponses([intent(), fauxAssistantMessage("Unavailable")]);
		await harness.session.prompt("Document the task workflow");
		await harness.session.waitForIdle();
		const id = latest(harness)?.id;
		expect(latest(harness)).toMatchObject({ phase: "planning", status: "handoff", decisionError: "classifier down" });
		expect(latest(harness)?.specificationPhases).toBeUndefined();
		failed = false;
		harness.setResponses([
			intent(true),
			checkpoint("Requirements"),
			checkpoint("Design"),
			checkpoint("Review"),
			checkpoint("Implementation"),
			checkpoint("Verified"),
			fauxAssistantMessage("Delivered"),
		]);
		await harness.session.prompt("/xp resume");
		await vi.waitFor(() => expect(latest(harness)?.status).toBe("completed"));
		await harness.session.waitForIdle();
		expect(latest(harness)?.id).toBe(id);
	});
	it.each(["relay-laya-v3", undefined])("refuses a server reporting checkpoint %s", async (version) => {
		vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ ok: true, version })));
		const harness = await setup();
		harness.setResponses([intent(), fauxAssistantMessage("Wrong checkpoint")]);
		await harness.session.prompt("Update documentation");
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({
			phase: "planning",
			status: "handoff",
			decisionError: expect.stringContaining("requires relay-laya-v4"),
		});
	});
	it("hands off on malformed resource answers without assigning a default role", async () => {
		const harness = await setup(xpTestProvider((_context, result) => ({ ...result, answers: {} })));
		harness.setResponses([intent(), fauxAssistantMessage("Invalid answer")]);
		await harness.session.prompt("Update documentation");
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({ phase: "planning", status: "handoff" });
		expect(latest(harness)?.phasePlans?.planning).toBeUndefined();
	});
	it("keeps the Harness evidence gate when Laya tries to finish early", async () => {
		const harness = await setup(
			xpTestProvider((context, result) =>
				context.questions.next_action
					? {
							...result,
							answers: {
								next_action: { type: "choice", choice: "finish", confidence: 1, probabilities: { finish: 1 } },
								goal_reached: { type: "bool", probability: 1 },
							},
						}
					: result,
			),
		);
		harness.setResponses([
			intent(),
			checkpoint("Not finished"),
			checkpoint("Still not finished"),
			checkpoint("Third invalid decision"),
			fauxAssistantMessage("Incomplete"),
		]);
		await harness.session.prompt("Update documentation");
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({ phase: "planning", status: "handoff", refusals: 3 });
		expect(latest(harness)?.listeningReported).not.toBe(true);
	});
	it("restores an interrupted phase and reselects resources in the new session", async () => {
		const original = await setup();
		original.setResponses([
			intent(),
			checkpoint("Requirements"),
			fauxAssistantMessage("Interrupted", { stopReason: "aborted" }),
		]);
		await original.session.prompt("Update documentation");
		await original.session.waitForIdle();
		expect(latest(original)).toMatchObject({ phase: "design", status: "active" });
		const resumed = await setup(xpTestProvider(), original.sessionManager);
		cpSync(join(original.tempDir, ".relay"), join(resumed.tempDir, ".relay"), { recursive: true });
		resumed.setResponses([
			intent(true),
			checkpoint("Design"),
			checkpoint("Review"),
			checkpoint("Implementation"),
			checkpoint("Verified"),
			fauxAssistantMessage("Delivered"),
		]);
		await resumed.session.prompt("Continue");
		await resumed.session.waitForIdle();
		expect(latest(resumed)).toMatchObject({ id: latest(original)?.id, status: "completed" });
	});
	it.each(["aborted", "error"] as const)("does not restart an %s response", async (stopReason) => {
		const harness = await setup();
		harness.setResponses([intent(), fauxAssistantMessage("Interrupted", { stopReason })]);
		await harness.session.prompt("Update documentation");
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2);
		expect(latest(harness)).toMatchObject({ phase: "planning", status: "active", continuationsWithoutCheckpoint: 0 });
	});
	it("starts a fresh workflow instead of reusing legacy deterministic phases", async () => {
		const original = await setup();
		original.sessionManager.appendCustomEntry("xp.state", {
			version: 1,
			id: "legacy",
			phase: "listening",
			status: "active",
			listeningReported: true,
		});
		const resumed = await setup(xpTestProvider(), original.sessionManager);
		resumed.setResponses([intent(true), fauxAssistantMessage("Interrupted", { stopReason: "aborted" })]);
		await resumed.session.prompt("Continue");
		await resumed.session.waitForIdle();
		expect(latest(resumed)).toMatchObject({ version: 2, phase: "planning", status: "active" });
		expect(latest(resumed)?.listeningReported).toBeUndefined();
		expect(latest(resumed)?.id).not.toBe("legacy");
	});
});
