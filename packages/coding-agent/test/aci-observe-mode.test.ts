import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@relay-harness/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import layaExtension, { ACI_OBSERVE_ENTRY } from "../src/extensions/laya/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("ACI observe mode (adaptiveCognition)", () => {
	const harnesses: Harness[] = [];
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "relay-aci-"));
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function run(adaptiveCognition?: { enabled?: boolean; mode?: "observe" }) {
		const harness = await createHarness({
			settings: { harnessCore: { evidence: false }, ...(adaptiveCognition ? { adaptiveCognition } : {}) },
			extensionFactories: [(relay) => layaExtension(relay)],
		});
		harnesses.push(harness);
		const model = harness.session.model;
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("fix the failing login test");
		const observed = harness.session.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "custom" && entry.customType === ACI_OBSERVE_ENTRY ? [entry.data] : []));
		const assistants = harness.session.messages.filter((m) => m.role === "assistant");
		return { observed, model, after: harness.session.model, assistants };
	}

	it("is disabled by default and records nothing", async () => {
		const { observed, model, after } = await run();
		expect(observed).toEqual([]);
		expect(after).toBe(model);
	});

	it("records the heuristic decision without changing the selected model or the response", async () => {
		const off = await run({ enabled: false });
		const on = await run({ enabled: true, mode: "observe" });
		expect(off.observed).toEqual([]);
		expect(on.after).toBe(on.model);
		expect(on.assistants.map((m) => m.model)).toEqual(off.assistants.map((m) => m.model));
		expect(on.observed).toEqual([
			expect.objectContaining({
				mode: "observe",
				source: "heuristic",
				// Same classification as the golden fixture; the tier differs there only because the fixture uses
				// minConfidence 0.6 (insufficient_confidence escalation), while settings default to 0.5.
				taskType: "test",
				requiredTier: "strong",
				rules: ["authentication"],
				escalations: [],
				effort: expect.any(String),
				thinkingLevel: expect.any(String),
			}),
		]);
	});
});
