import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@relay-harness/agent-core";
import {
	type ClassifierContext,
	type ClassifierResult,
	fauxAssistantMessage,
	fauxToolCall,
	type JsonObject,
	type TranscriptContext,
} from "@relay-harness/ai";
import { Type } from "typebox";
import { expect } from "vitest";
import type { WorkTask } from "../src/core/delegation/contracts.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import type { SessionManager } from "../src/core/session-manager.ts";
import { createDelegationExtension } from "../src/extensions/delegation/index.ts";
import { WORK_STATE_ENTRY, type WorkState } from "../src/extensions/delegation/state.ts";
import { delegationTestProvider } from "./delegation-test-support.ts";
import { createHarness, getToolResult, type Harness } from "./suite/harness.ts";

export const call = (name: string, args: JsonObject, id?: string) =>
	fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
export function latest(harness: Harness): WorkState {
	const entry = harness.sessionManager
		.getBranch()
		.findLast((item) => item.type === "custom" && item.customType === WORK_STATE_ENTRY);
	if (entry?.type !== "custom") throw new Error("Missing delegated state");
	return entry.data as WorkState;
}
export function scriptedClassification(context: ClassifierContext, result: ClassifierResult): ClassifierResult {
	const target = context.state.task;
	const task = target && typeof target === "object" && !Array.isArray(target) ? (target as JsonObject) : undefined;
	for (const [id, question] of Object.entries(context.questions)) {
		if (question.type === "choice") {
			const choice =
				id === "work_mode"
					? "delegated"
					: id === "concurrency"
						? "2"
						: String(task?.proposedProfile ?? "backend-engineer");
			result.answers[id] = { type: "choice", choice, confidence: 0.95, probabilities: { [choice]: 0.95 } };
		} else if (question.type === "bool") {
			const necessary =
				!id.startsWith("resource_") ||
				(task?.accessMode === "investigation"
					? question.instructions.includes("tool read?")
					: task?.accessMode === "mutation"
						? question.instructions.includes("tool write?")
						: question.instructions.includes("tool bash?"));
			result.answers[id] = { type: "bool", probability: necessary ? 0.95 : 0.05 };
		}
	}
	return result;
}
export function tasks(): WorkTask[] {
	return ["api", "ui", "implement", "verify"].map((taskId) => ({
		taskId,
		objective:
			taskId === "implement"
				? "Save the integrated result"
				: taskId === "verify"
					? "Verify the integrated result"
					: `Investigate ${taskId}`,
		acceptanceCriteria: [taskId === "verify" ? "The Node behavioral test passes" : "Report the observed result"],
		proposedProfile: taskId === "ui" ? "frontend-engineer" : "backend-engineer",
		dependencies: taskId === "implement" ? ["api", "ui"] : taskId === "verify" ? ["implement"] : [],
		inputs: [],
		expectedOutput: "Observed result and evidence",
		resourceScope: ["."],
		accessMode: taskId === "implement" ? "mutation" : taskId === "verify" ? "validation" : "investigation",
		limits: { durationMs: 10_000, steps: 20, outputBytes: 32_000 },
	}));
}

export async function createDelegationHarness(
	enabled = true,
	override = scriptedClassification,
	sessionManager?: SessionManager,
	classifierProvider?: ExtensionFactory,
) {
	let directory = "";
	const readSchema = Type.Object({ path: Type.String() });
	const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });
	const shellSchema = Type.Object({ command: Type.String() });
	const read: AgentTool<typeof readSchema> = {
		name: "read",
		label: "Read",
		description: "Read task inputs",
		parameters: readSchema,
		execute: async (_id, args) => ({
			content: [{ type: "text", text: readFileSync(join(directory, args.path), "utf8") }],
			details: {},
		}),
	};
	const write: AgentTool<typeof writeSchema> = {
		name: "write",
		label: "Write",
		description: "Save task results",
		parameters: writeSchema,
		execute: async (_id, args) => {
			writeFileSync(join(directory, args.path), args.content);
			return { content: [{ type: "text", text: "Written" }], details: {} };
		},
	};
	const bash: AgentTool<typeof shellSchema> = {
		name: "bash",
		label: "Test",
		description: "Run the Node behavioral test",
		parameters: shellSchema,
		execute: async (_id, args) => {
			if (args.command !== "node --test result.test.mjs") throw new Error("Unexpected test command");
			const text = execFileSync(process.execPath, ["--test", "result.test.mjs"], {
				cwd: directory,
				encoding: "utf8",
				windowsHide: true,
			});
			return { content: [{ type: "text", text }], details: {} };
		},
	};
	const harness = await createHarness({
		sessionManager,
		tools: [read, write, bash],
		extensionFactories: [
			classifierProvider ?? delegationTestProvider(override),
			createDelegationExtension({ enabled }),
		],
		settings: { harnessCore: { evidence: false } },
	});
	directory = harness.tempDir;
	writeFileSync(join(directory, "input.txt"), "42\n");
	writeFileSync(
		join(directory, "result.test.mjs"),
		'import { readFileSync } from "node:fs"; import { strictEqual } from "node:assert"; import { test } from "node:test"; test("integrated result", () => strictEqual(readFileSync("result.txt", "utf8"), "42\\n"));\n',
	);
	mkdirSync(join(directory, ".relay", "agents"), { recursive: true });
	for (const profile of ["backend-engineer", "frontend-engineer"])
		writeFileSync(
			join(directory, ".relay", "agents", `${profile}.md`),
			"---\ntools: [read, write, bash]\n---\nComplete the assigned task using observed inputs.\n",
		);
	await harness.session.bindExtensions({});
	return harness;
}

export async function runDelegationScenario(harness: Harness): Promise<void> {
	let arrivals = 0;
	let release = () => {};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const investigate = async (context: TranscriptContext) => {
		if (++arrivals === 2) release();
		await barrier;
		expect(JSON.stringify(context)).not.toContain('"name":"propose_work"');
		return call("read", { path: "input.txt" }, "same-child-id");
	};
	harness.setResponses([
		call("propose_work", { tasks: tasks() }),
		call("execute_work", { taskIds: ["api", "ui"] }),
		investigate,
		investigate,
		fauxAssistantMessage("API requires 42."),
		fauxAssistantMessage("UI requires 42."),
		call("review_work", { taskId: "api", accepted: true, reason: "Observed input matches criteria" }),
		call("review_work", { taskId: "ui", accepted: true, reason: "Observed input matches criteria" }),
		call("execute_work", { taskIds: ["implement"] }),
		call("write", { path: "result.txt", content: "42\n" }),
		fauxAssistantMessage("Saved the integrated result."),
		call("review_work", { taskId: "implement", accepted: true, reason: "Observed write satisfies criteria" }),
		call("complete_work", { summary: "Too early", evidenceIds: [] }, "early"),
		call("execute_work", { taskIds: ["verify"] }),
		call("bash", { command: "node --test result.test.mjs" }),
		fauxAssistantMessage("The behavioral test passed."),
		call("review_work", { taskId: "verify", accepted: true, reason: "Observed Node test passed" }),
		() =>
			call("complete_work", {
				summary: "Integrated and verified",
				evidenceIds: latest(harness)
					.evidence.filter((item) => item.tool === "bash")
					.map((item) => item.id),
			}),
		fauxAssistantMessage("Integrated result delivered."),
	]);
	await harness.session.prompt("Investigate the API and UI independently, save their agreed result and test it.");
	expect(arrivals).toBe(2);
	expect(
		latest(harness).status,
		JSON.stringify(harness.session.messages.filter((item) => item.role === "toolResult" && item.isError)),
	).toBe("completed");
	expect(latest(harness).delegation?.runs).toHaveLength(4);
	expect(latest(harness).delegation?.runs.every((run) => run.result?.accepted)).toBe(true);
	expect(new Set(latest(harness).evidence.map((item) => item.id)).size).toBe(latest(harness).evidence.length);
	expect(
		harness.session.messages.find((item) => item.role === "toolResult" && item.toolCallId === "early"),
	).toMatchObject({ isError: true });
	expect(getToolResult(harness, "complete_work").isError).toBe(false);
	expect(readFileSync(join(harness.tempDir, "result.txt"), "utf8")).toBe("42\n");
	expect(existsSync(join(harness.tempDir, ".relay", "specs"))).toBe(false);
	expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
}

export async function runDelegationRecovery(harness: Harness): Promise<void> {
	const proposed = tasks()
		.filter((task) => task.taskId === "implement" || task.taskId === "verify")
		.map((task) => ({ ...task, dependencies: task.taskId === "implement" ? [] : ["implement"] }));
	harness.setResponses([
		call("propose_work", { tasks: proposed }),
		call("execute_work", { taskIds: ["implement"] }),
		call("write", { path: "result.txt", content: "42\n" }),
		fauxAssistantMessage("Interrupted after writing", { stopReason: "aborted" }),
		fauxAssistantMessage("Principal interrupted", { stopReason: "error", errorMessage: "Fixture interruption" }),
	]);
	await harness.session.prompt("Save and verify the integrated result.");
	expect(latest(harness).delegation?.runs[0]).toMatchObject({ status: "interrupted", reconciled: false });
	expect(readFileSync(join(harness.tempDir, "result.txt"), "utf8")).toBe("42\n");
	await harness.session.bindExtensions({});
	harness.setResponses([
		call(
			"review_work",
			{ taskId: "implement", accepted: false, reason: "Premature reconciliation", reconcile: true },
			"premature",
		),
		call("read", { path: "result.txt" }, "inspection"),
		call("review_work", {
			taskId: "implement",
			accepted: false,
			reason: "Inspected the persisted write",
			reconcile: true,
			evidenceIds: ["inspection"],
		}),
		call("execute_work", { taskIds: ["implement"] }),
		fauxAssistantMessage("The principal inspection verified the existing result; no write repeated."),
		call("review_work", { taskId: "implement", accepted: true, reason: "Existing output satisfies the criteria" }),
		call("execute_work", { taskIds: ["verify"] }),
		call("bash", { command: "node --test result.test.mjs" }),
		fauxAssistantMessage("The recovered output passed its behavioral test."),
		call("review_work", { taskId: "verify", accepted: true, reason: "Observed behavioral test passed" }),
		() =>
			call("complete_work", {
				summary: "Recovered and verified",
				evidenceIds: latest(harness)
					.evidence.filter((item) => item.tool === "bash")
					.map((item) => item.id),
			}),
		fauxAssistantMessage("Recovered result delivered."),
	]);
	await harness.session.prompt("Continue the same task after inspecting its interrupted effects.");
	expect(latest(harness).status).toBe("completed");
	expect(latest(harness).delegation?.runs.map((run) => run.status)).toEqual(["interrupted", "completed", "completed"]);
	expect(harness.eventsOfType("tool_execution_start").filter((event) => event.toolName === "write")).toHaveLength(1);
	expect(
		harness.session.messages.find((item) => item.role === "toolResult" && item.toolCallId === "premature"),
	).toMatchObject({ isError: true });
}
