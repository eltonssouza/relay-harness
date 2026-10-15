import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@relay-harness/agent-core";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import xpExtension from "../src/extensions/xp/index.ts";
import type { XpState } from "../src/extensions/xp/workflow.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { xpTestProvider } from "./xp-test-support.ts";

const call = (name: string, args: JsonObject, id?: string) =>
	fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
const checkpoint = (summary: string, extra: JsonObject = {}) =>
	call("xp_checkpoint", { summary, evidenceIds: [], ...extra });
const latest = (harness: Harness) => {
	const entry = harness.sessionManager
		.getBranch()
		.findLast((item) => item.type === "custom" && item.customType === "xp.state");
	return entry?.type === "custom" ? (entry.data as XpState) : undefined;
};

describe("XP resource execution", () => {
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
	async function setup(
		provider = xpTestProvider(),
		tools: AgentTool[] = [],
		extension?: (relay: ExtensionAPI) => void,
	) {
		const harness = await createHarness({
			tools,
			settings: { harnessCore: { evidence: false } },
			extensionFactories: [provider, ...(extension ? [extension] : []), xpExtension],
		});
		harnesses.push(harness);
		await harness.session.modelRuntime.refresh({ allowNetwork: false });
		await harness.session.bindExtensions({});
		return harness;
	}
	it("selects profiles and visible skills dynamically and loads only selected instructions", async () => {
		let directory = "";
		const provider = xpTestProvider((context, result) => {
			for (const [id, question] of Object.entries(context.questions)) {
				if (id === "agent")
					result.answers[id] = {
						type: "choice",
						choice: "quality-assurance",
						confidence: 0.95,
						probabilities: { "quality-assurance": 0.95 },
					};
				if (question.instructions.includes("agent software-architect?"))
					result.answers[id] = { type: "bool", probability: 0.95 };
				if (question.instructions.includes("skill unnecessary?"))
					result.answers[id] = { type: "bool", probability: 0.05 };
			}
			return result;
		});
		const harness = await setup(provider, [], (relay) => {
			relay.on("before_agent_start", (event) => {
				event.systemPromptOptions.skills = loadSkillsFromDir({ dir: directory, source: "path" }).skills;
			});
		});
		directory = join(harness.tempDir, "skills");
		mkdirSync(directory);
		writeFileSync(
			join(directory, "selected.md"),
			"---\nname: selected\ndescription: Review acceptance criteria\n---\nSELECTED_INSTRUCTIONS\n",
		);
		writeFileSync(
			join(directory, "unnecessary.md"),
			"---\nname: unnecessary\ndescription: Unrelated operation\n---\nUNNECESSARY_INSTRUCTIONS\n",
		);
		writeFileSync(
			join(directory, "disabled.md"),
			"---\nname: disabled\ndescription: Manual invocation only\ndisable-model-invocation: true\n---\nDISABLED_INSTRUCTIONS\n",
		);
		harness.setResponses([
			call("xp_intent", { kind: "task", testsRequired: false }),
			checkpoint("Requirements", { skills: ["selected"] }),
			fauxAssistantMessage("Interrupted", { stopReason: "aborted" }),
		]);
		await harness.session.prompt("Review documentation");
		await harness.session.waitForIdle();
		expect(latest(harness)?.phasePlans?.planning).toMatchObject({
			agents: ["quality-assurance", "software-architect"],
			skills: ["selected"],
		});
		const output = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => part.text))
			.join("\n");
		expect(output).toContain("SELECTED_INSTRUCTIONS");
		expect(output).not.toContain("UNNECESSARY_INSTRUCTIONS");
		expect(output).not.toContain("DISABLED_INSTRUCTIONS");
		const path = latest(harness)?.specificationPath;
		if (!path) throw new Error("Missing specification");
		expect(readFileSync(join(harness.tempDir, path), "utf8")).toContain("Skills selected: selected");
	});
	it("prevents execution of unselected tools and permits reconsideration without phase advancement", async () => {
		const schema = Type.Object({});
		let invocations = 0;
		let select = false;
		const tool: AgentTool<typeof schema> = {
			name: "inspect",
			label: "Inspect",
			description: "Inspect the workspace",
			parameters: schema,
			execute: async () => {
				invocations++;
				return { content: [{ type: "text", text: "Observed" }], details: {} };
			},
		};
		const harness = await setup(
			xpTestProvider((context, result) => {
				for (const [id, question] of Object.entries(context.questions))
					if (question.instructions.includes("tool inspect?"))
						result.answers[id] = { type: "bool", probability: select ? 0.95 : 0.05 };
				return result;
			}),
			[tool],
		);
		harness.setResponses([
			call("xp_intent", { kind: "task", testsRequired: false }),
			call("inspect", {}, "denied"),
			fauxAssistantMessage("Interrupted", { stopReason: "aborted" }),
		]);
		await harness.session.prompt("Inspect the workspace");
		await harness.session.waitForIdle();
		expect(invocations).toBe(0);
		expect(latest(harness)?.phase).toBe("planning");
		select = true;
		harness.setResponses([
			call("xp_intent", { kind: "task", continueTask: true }),
			checkpoint("Need inspection", { reconsiderResources: true }),
			call("inspect", {}, "observed"),
			fauxAssistantMessage("Interrupted", { stopReason: "aborted" }),
		]);
		await harness.session.prompt("Continue with inspection");
		await harness.session.waitForIdle();
		expect(invocations).toBe(1);
		expect(latest(harness)).toMatchObject({
			phase: "planning",
			evidence: [expect.objectContaining({ id: "observed", tool: "inspect", phase: "planning" })],
		});
	});
	it("does not treat /xp resume as an answer to a pending business decision", async () => {
		const harness = await setup();
		harness.setResponses([
			call("xp_intent", { kind: "task", testsRequired: false }),
			checkpoint("Missing business choice", {
				intervention: { reason: "business_decision", question: "Include archived records?" },
			}),
			fauxAssistantMessage("Waiting"),
		]);
		await harness.session.prompt("Document the export policy");
		await harness.session.waitForIdle();
		const count = harness.faux.state.callCount;
		await harness.session.prompt("/xp resume");
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(count);
		expect(latest(harness)).toMatchObject({
			phase: "planning",
			status: "handoff",
			intervention: { reason: "business_decision" },
		});
	});
	it("preserves the phase report if transition classification fails", async () => {
		const harness = await setup(
			xpTestProvider((context, result) =>
				context.questions.next_action
					? { ...result, stopReason: "error", errorMessage: "transition down" }
					: result,
			),
		);
		harness.setResponses([
			call("xp_intent", { kind: "task", testsRequired: false }),
			checkpoint("Unverified report"),
			fauxAssistantMessage("Unavailable"),
		]);
		await harness.session.prompt("Update docs");
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({ phase: "planning", status: "handoff" });
		expect(latest(harness)?.specificationReports?.planning).toBeUndefined();
	});
	it("requires tests after an executable edit even when intent initially marked the task non-executable", async () => {
		const schema = Type.Object({ path: Type.String(), content: Type.String() });
		const write: AgentTool<typeof schema> = {
			name: "write",
			label: "Write",
			description: "Write a file",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "Written" }], details: {} }),
		};
		const harness = await setup(xpTestProvider(), [write]);
		harness.setResponses([
			call("xp_intent", { kind: "task", testsRequired: false }),
			checkpoint("Requirements"),
			checkpoint("Design"),
			checkpoint("Review strategy"),
			call("write", { path: "src/behavior.ts", content: "export const value = 1;" }),
			checkpoint("Cannot finish Coding without tests"),
			fauxAssistantMessage("Interrupted", { stopReason: "aborted" }),
		]);
		await harness.session.prompt("Update the task");
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({ phase: "coding", status: "active", testsRequired: true });
		expect(latest(harness)?.listeningReported).not.toBe(true);
	});
});
