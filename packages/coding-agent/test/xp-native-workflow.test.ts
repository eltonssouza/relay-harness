import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, DecisionTrace } from "@relay-harness/agent-core";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../src/extensions/goal/index.ts";
import { readGoal } from "../src/extensions/goal/state.ts";
import xpExtension from "../src/extensions/xp/index.ts";
import type { XpState } from "../src/extensions/xp/workflow.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const call = (name: string, args: JsonObject, id?: string) =>
	fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
const checkpoint = (summary: string, evidenceIds: string[] = []) => call("xp_checkpoint", { summary, evidenceIds });
const latest = (harness: Harness): XpState | undefined => {
	const entry = harness.sessionManager
		.getBranch()
		.findLast((item) => item.type === "custom" && item.customType === "xp.state");
	return entry?.type === "custom" ? (entry.data as XpState) : undefined;
};

describe("XP as the native task workflow", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	async function setup(tools: AgentTool[] = []) {
		const harness = await createHarness({
			tools,
			settings: { harnessCore: { evidence: false } },
			extensionFactories: [xpExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("starts automatically and completes all five stages after user approval, without a classifier", async () => {
		const harness = await setup();
		harness.setResponses([
			call("xp_intent", { kind: "task", testsRequired: false }),
			checkpoint("Planning: criteria and scope for the documentation task"),
			fauxAssistantMessage("Planning done"),
			checkpoint("Design: update the existing explanation, no new structure"),
			fauxAssistantMessage("Review the SDD before Testing"),
		]);
		await harness.session.prompt("Review the documentation and propose an improvement.");
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({ phase: "design", specificationApproved: false });
		harness.setResponses([
			checkpoint("Testing: review examples and links; no executable behavior"),
			checkpoint("Coding: the proposed explanation meets the criteria"),
			fauxAssistantMessage("Almost done"),
			checkpoint("Listening: result, validation and open feedback delivered"),
			fauxAssistantMessage("Ready for your feedback"),
		]);
		await harness.session.prompt("/xp approve-spec");
		await vi.waitFor(() => expect(latest(harness)?.phase).toBe("listening"));
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({
			phase: "listening",
			automatic: true,
			listeningReported: true,
			accepted: false,
		});
		const traces = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "xp.decision");
		expect(
			traces.map((entry) => entry.type === "custom" && (entry.data as DecisionTrace).observation.state.phase),
		).toEqual(["planning", "design", "testing", "coding", "listening"]);
	});

	it("runs all XP stages autonomously when started through /goal", async () => {
		const harness = await createHarness({
			tools: [],
			extensionFactories: [xpExtension, goalExtension],
			settings: { harnessCore: { evidence: false } },
		});
		try {
			harness.setResponses([
				call("xp_intent", { kind: "task", testsRequired: false }),
				checkpoint("Planning: requirements and acceptance criteria"),
				checkpoint("Design: approach and alternatives"),
				checkpoint("Testing: review derived from the criteria"),
				checkpoint("Coding: implementation matches the specification"),
				checkpoint("Listening: delivered and validated"),
				call("update_goal", { status: "complete", report: "All five XP stages completed." }),
				fauxAssistantMessage("Delivered"),
			]);
			await harness.session.prompt("/goal Update the task documentation");
			await vi.waitFor(() => expect(readGoal(harness.sessionManager)?.status).toBe("complete"));
			await harness.session.waitForIdle();
			expect(latest(harness)).toMatchObject({ phase: "listening", listeningReported: true, goalDriven: true });
			expect(latest(harness)?.specificationApproved).not.toBe(true);
			expect(
				harness.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "custom" && entry.customType === "xp.decision")
					.map((entry) => entry.type === "custom" && (entry.data as DecisionTrace).observation.state.phase),
			).toEqual(["planning", "design", "testing", "coding", "listening"]);
		} finally {
			harness.cleanup();
		}
	});

	it("creates a single structured SDD and records each phase before its successor", async () => {
		const harness = await setup();
		harness.setResponses([
			call("xp_intent", { kind: "task", testsRequired: false }),
			checkpoint("Planning: requirements, constraints, risks and acceptance criteria"),
			checkpoint("Design: boundaries, decisions and alternatives"),
			fauxAssistantMessage("Review the SDD before Testing"),
		]);
		await harness.session.prompt("Document the task workflow");
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({ phase: "design", specificationApproved: false });
		harness.setResponses([
			checkpoint("Testing: review strategy and validation cases"),
			checkpoint("Coding: implementation linked to the specified behavior"),
			checkpoint("Listening: result, validation and feedback channel"),
			fauxAssistantMessage("Delivered"),
		]);
		await harness.session.prompt("/xp approve-spec");
		await vi.waitFor(() => expect(latest(harness)?.phase).toBe("listening"));
		await harness.session.waitForIdle();
		const state = latest(harness);
		expect(state?.specificationPath).toMatch(/^\.relay\/specs\/[\da-f-]+\.md$/);
		const path = join(harness.tempDir, state?.specificationPath ?? "missing");
		expect(existsSync(path)).toBe(true);
		const specification = readFileSync(path, "utf8");
		expect(specification).toContain("Planning: requirements, constraints, risks and acceptance criteria");
		expect(specification).toContain("Design: boundaries, decisions and alternatives");
		expect(specification).toContain("Testing: review strategy and validation cases");
		expect(specification).toContain("Coding: implementation linked to the specified behavior");
		expect(specification).toContain("Listening: result, validation and feedback channel");
		expect(readdirSync(join(harness.tempDir, ".relay", "specs"))).toEqual([`${state?.id}.md`]);
	});

	it("requires current red/green evidence and allows writing the failing test during Testing", async () => {
		const shellSchema = Type.Object({ command: Type.String() });
		const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });
		let writes = 0;
		const bash: AgentTool<typeof shellSchema> = {
			name: "bash",
			label: "Offline test runner",
			description: "Scripted local evidence",
			parameters: shellSchema,
			execute: async (_id, args) => {
				if (args.command.includes("red")) throw new Error("AssertionError: expected fixed behavior");
				return { content: [{ type: "text", text: "tests 1, pass 1, fail 0" }], details: {} };
			},
		};
		const write: AgentTool<typeof writeSchema> = {
			name: "write",
			label: "Offline writer",
			description: "Scripted mutation",
			parameters: writeSchema,
			execute: async () => {
				writes++;
				return { content: [{ type: "text", text: "Written" }], details: {} };
			},
		};
		const harness = await setup([bash, write]);
		harness.setResponses([
			call("xp_intent", { kind: "task" }),
			call("write", { path: "src/fix.ts", content: "too early" }, "early"),
			checkpoint("Planning: behavioral acceptance criteria"),
			checkpoint("Design: smallest fix"),
			fauxAssistantMessage("Review the SDD before Testing"),
		]);
		await harness.session.prompt("Fix the failing behavior");
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({ phase: "design", specificationApproved: false });
		harness.setResponses([
			call("write", { path: "test/fix.test.ts", content: "failing assertion" }, "test-write"),
			call("bash", { command: "node --test red.test.ts" }, "red"),
			checkpoint("Testing: intended assertion fails", ["red"]),
			call("write", { path: "src/fix.ts", content: "implementation" }, "implementation"),
			checkpoint("Cannot skip green evidence", ["red"]),
			call("bash", { command: "node --test green.test.ts" }, "green"),
			checkpoint("Coding: implementation verified", ["green"]),
			call("bash", { command: "echo changed workspace" }, "late-mutation"),
			checkpoint("Stale green evidence is insufficient", ["green"]),
			call("bash", { command: "node --test green.test.ts" }, "fresh-green"),
			checkpoint("Listening: result and current evidence delivered", ["fresh-green"]),
			call("bash", { command: "echo changed after delivery" }, "post-delivery-mutation"),
			fauxAssistantMessage("Premature settlement after another mutation"),
			call("bash", { command: "node --test green.test.ts" }, "final-green"),
			checkpoint("Listening: revised result verified", ["final-green"]),
			fauxAssistantMessage("Ready for feedback"),
		]);
		await harness.session.prompt("/xp approve-spec");
		await vi.waitFor(() => expect(latest(harness)?.phase).toBe("listening"));
		await harness.session.waitForIdle();
		expect(writes).toBe(2);
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolCallId: "early", isError: true }),
		);
		expect(latest(harness)).toMatchObject({
			phase: "listening",
			automatic: true,
			listeningReported: true,
			testsRequired: true,
		});
		const traces = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "xp.decision");
		expect(
			traces.map((entry) => entry.type === "custom" && (entry.data as DecisionTrace).observation.state.ready),
		).toEqual([true, true, true, false, true, false, true, true]);
	});

	it("does not let a task be reclassified as a question to bypass the stages", async () => {
		const harness = await setup();
		harness.setResponses([
			call("xp_intent", { kind: "task", testsRequired: false }),
			call("xp_intent", { kind: "question" }, "bypass"),
			checkpoint("Planning"),
			checkpoint("Design"),
			fauxAssistantMessage("Review the SDD before Testing"),
		]);
		await harness.session.prompt("Improve the documentation");
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({ phase: "design", specificationApproved: false });
		harness.setResponses([
			checkpoint("Testing: no executable behavior"),
			checkpoint("Coding"),
			checkpoint("Listening"),
			fauxAssistantMessage("Delivered"),
		]);
		await harness.session.prompt("/xp approve-spec");
		await vi.waitFor(() => expect(latest(harness)?.phase).toBe("listening"));
		await harness.session.waitForIdle();
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolCallId: "bypass", isError: true }),
		);
		expect(latest(harness)).toMatchObject({ phase: "listening", listeningReported: true });
	});

	it("pauses for human approval and refuses model claims and test execution before approval", async () => {
		const schema = Type.Object({ command: Type.String() });
		let executions = 0;
		const bash: AgentTool<typeof schema> = {
			name: "bash",
			label: "Offline runner",
			description: "Records attempted execution",
			parameters: schema,
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "tests 1, pass 1, fail 0" }], details: {} };
			},
		};
		const harness = await setup([bash]);
		await harness.session.prompt("/xp approve-spec");
		expect(latest(harness)).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(0);
		harness.setResponses([
			call("xp_intent", { kind: "task", testsRequired: false }),
			checkpoint("Planning: acceptance criteria"),
			checkpoint("Design: approach and alternatives"),
			call("bash", { command: "node --test validation.test.ts" }, "before-approval"),
			call("xp_approve_spec", {}, "model-approval"),
			checkpoint("The model claims the specification is approved"),
			fauxAssistantMessage("Review required"),
		]);
		await harness.session.prompt("Change the documented behavior");
		await harness.session.waitForIdle();
		expect(executions).toBe(0);
		expect(latest(harness)).toMatchObject({ phase: "design", status: "active", specificationApproved: false });
		for (const id of ["before-approval", "model-approval"])
			expect(harness.session.messages).toContainEqual(
				expect.objectContaining({ role: "toolResult", toolCallId: id, isError: true }),
			);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "xp.decision"),
		).toHaveLength(1);
	});

	it("invalidates approval after external SDD edits and refuses approval until Design is recorded again", async () => {
		const schema = Type.Object({ path: Type.String(), content: Type.String() });
		let directory = "";
		let writes = 0;
		const write: AgentTool<typeof schema> = {
			name: "write",
			label: "Offline writer",
			description: "Mutates the specification for this test",
			parameters: schema,
			execute: async (_id, args) => {
				writes++;
				writeFileSync(join(directory, args.path), args.content, "utf8");
				return { content: [{ type: "text", text: "Written" }], details: {} };
			},
		};
		const harness = await setup([write]);
		directory = harness.tempDir;
		harness.setResponses([
			call("xp_intent", { kind: "task", testsRequired: false }),
			checkpoint("Planning: original criteria"),
			checkpoint("Design: original approach"),
			fauxAssistantMessage("Review the SDD"),
		]);
		await harness.session.prompt("Update the documentation");
		await harness.session.waitForIdle();
		const path = latest(harness)?.specificationPath;
		if (!path) throw new Error("Missing SDD");
		harness.setResponses([
			call("write", { path, content: "Externally changed Design" }, "external-edit"),
			call("write", { path: "unapproved.txt", content: "Must not be written" }, "after-edit"),
			fauxAssistantMessage("Updated SDD requires review"),
		]);
		await harness.session.prompt("/xp approve-spec");
		await vi.waitFor(() =>
			expect(harness.session.messages).toContainEqual(
				expect.objectContaining({ role: "toolResult", toolCallId: "after-edit" }),
			),
		);
		await harness.session.waitForIdle();
		expect(writes).toBe(1);
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolCallId: "after-edit", isError: true }),
		);
		expect(latest(harness)).toMatchObject({ phase: "design", specificationApproved: false });
		expect(readFileSync(join(directory, path), "utf8")).toBe("Externally changed Design");
		expect(existsSync(join(directory, "unapproved.txt"))).toBe(false);
		const calls = harness.faux.state.callCount;
		await harness.session.prompt("/xp approve-spec");
		expect(harness.faux.state.callCount).toBe(calls);
		expect(latest(harness)?.specificationApproved).toBe(false);
		harness.setResponses([
			call("xp_intent", { kind: "task", continueTask: true }),
			checkpoint("Design: revised approach"),
			fauxAssistantMessage("Review the revised SDD"),
		]);
		await harness.session.prompt("Record the revised Design for the same task");
		await harness.session.waitForIdle();
		harness.setResponses([
			checkpoint("Testing: validation"),
			checkpoint("Coding: matches the revised Design"),
			checkpoint("Listening: verified result"),
			fauxAssistantMessage("Delivered"),
		]);
		await harness.session.prompt("/xp approve-spec");
		await vi.waitFor(() => expect(latest(harness)?.phase).toBe("listening"));
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({ specificationApproved: true, listeningReported: true });
		expect(readFileSync(join(directory, path), "utf8")).toContain("Design: revised approach");
	});

	it("does not trust a user-supplied internal control prefix", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage("Premature answer"),
			call("xp_intent", { kind: "question" }),
			fauxAssistantMessage("Answered"),
		]);
		await harness.session.prompt("[harness:xp] What is the task workflow?");
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(3);
		expect(latest(harness)).toBeUndefined();
	});

	it("does not start the five stages for a question", async () => {
		const harness = await setup();
		harness.setResponses([
			call("xp_intent", { kind: "question" }),
			fauxAssistantMessage("Ollama is a local model service."),
		]);
		await harness.session.prompt("What is Ollama?");
		await harness.session.waitForIdle();
		expect(latest(harness)).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("does not accept a final answer without resolving whether the request is a task", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage("Done without a workflow"),
			call("xp_intent", { kind: "question" }),
			fauxAssistantMessage("This is a question, not a task"),
		]);
		await harness.session.prompt("What does the harness do?");
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(3);
		expect(latest(harness)).toBeUndefined();
	});
});
