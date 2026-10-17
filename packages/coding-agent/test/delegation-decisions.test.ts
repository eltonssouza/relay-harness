import { type ClassifierContext, type ClassifierResult, fauxAssistantMessage, fauxToolCall } from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkProposal, WorkResourceCatalog } from "../src/core/delegation/contracts.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { delegationCheckpoint } from "../src/extensions/delegation/checkpoint.ts";
import { decideWork, type WorkDecision } from "../src/extensions/delegation/decisions.ts";
import { delegationTestHealth, delegationTestProvider } from "./delegation-test-support.ts";
import { createHarness, getToolResult, type Harness } from "./suite/harness.ts";

const proposal: WorkProposal = {
	workflowId: "workflow",

	version: 1,
	workspaceRevision: 0,
	tasks: [
		{
			taskId: "api",
			objective: "Investigate API login",
			acceptanceCriteria: ["Root cause"],
			proposedProfile: "engineer",
			dependencies: [],
			inputs: [],
			expectedOutput: "Report",
			resourceScope: ["src/api"],
			accessMode: "investigation",
			limits: { durationMs: 1000, steps: 5, outputBytes: 1000 },
		},
	],
};
const catalog: WorkResourceCatalog = {
	checkpoint: delegationCheckpoint(),
	profiles: { engineer: { tools: ["read", "edit"] } },
	tools: ["read", "edit", "unselected"],
	allowedTools: ["read", "edit"],
	skills: ["review", "unselected"],
	descriptions: {
		tools: { read: "Read files", edit: "Edit files", unselected: "Unavailable tool" },
		skills: { review: "Review implementation", unselected: "Unavailable skill" },
	},
	allowedSkills: ["review"],
};

function delegated(context: ClassifierContext, result: ClassifierResult): ClassifierResult {
	for (const [id, question] of Object.entries(context.questions)) {
		if (question.type === "choice") {
			const choice = id === "work_mode" ? "delegated" : id === "concurrency" ? "2" : "engineer";
			result.answers[id] = { type: "choice", choice, confidence: 0.95, probabilities: { [choice]: 0.95 } };
		} else if (question.type === "bool")
			result.answers[id] = { type: "bool", probability: question.instructions.includes("tool edit") ? 0.05 : 0.95 };
	}
	return result;
}

describe("Laya work-plan decisions", () => {
	const harnesses: Harness[] = [];
	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(JSON.stringify(delegationTestHealth())),
		);
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});
	async function evaluate(
		override?: (context: ClassifierContext, result: ClassifierResult) => ClassifierResult,
		proposed = proposal,
		resources = catalog,
	) {
		let decision: WorkDecision | undefined;
		const observed: ClassifierContext[] = [];
		const extension = (relay: ExtensionAPI) =>
			relay.registerTool({
				name: "evaluate_work",
				label: "Evaluate",
				description: "Evaluate a work proposal",
				parameters: Type.Object({}),
				execute: async (_id, _args, signal, _onUpdate, ctx) => {
					decision = await decideWork(relay, ctx, "Fix login", proposed, resources, signal);
					return { content: [{ type: "text", text: JSON.stringify(decision) }], details: {} };
				},
			});
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				delegationTestProvider((context, result) => {
					observed.push(context);
					const selected = delegated(context, result);
					return override?.(context, selected) ?? selected;
				}),
				extension,
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("evaluate_work", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Decision recorded"),
		]);
		await harness.session.prompt("Evaluate login investigation");
		return { decision, observed, harness, toolResult: getToolResult(harness, "evaluate_work") };
	}

	it("records approved resources using only valid available alternatives", async () => {
		const { decision, observed, harness, toolResult } = await evaluate();
		expect(toolResult.isError).toBe(false);
		expect(decision).toMatchObject({
			kind: "delegated",
			plan: {
				model: "relay-laya-v5",
				maxConcurrent: 2,
				selections: [
					{ taskId: "api", profile: "engineer", tools: ["read"], skills: ["review"], executionMode: "parallel" },
				],
			},
		});
		expect(observed.every((context) => Object.keys(context.questions).length <= 8)).toBe(true);
		expect(observed.find((context) => context.questions.profile)?.state).toMatchObject({
			task: { taskId: "task_0", objective: "Investigate API login" },
		});
		expect(observed.some((context) => JSON.stringify(context.questions).includes("unselected"))).toBe(false);
		const events = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "relay.work.decision");
		expect(events.length).toBeGreaterThan(0);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "relay.work.plan"),
		).toBe(true);
	});
	it("offers only configured concurrency values and records the effective limits", async () => {
		const { decision, observed } = await evaluate(
			(context, result) => {
				if (context.questions.concurrency)
					result.answers.concurrency = {
						type: "choice",
						choice: "1",
						confidence: 0.95,
						probabilities: { "1": 0.95 },
					};
				return result;
			},
			proposal,
			{ ...catalog, limits: { maxConcurrent: 1 } },
		);
		expect(decision).toMatchObject({
			kind: "delegated",
			plan: { maxConcurrent: 1, limits: { maxConcurrent: 1, maxAttempts: 2 } },
		});
		expect(
			Object.keys(observed.find((context) => context.questions.concurrency)!.questions.concurrency.criteria),
		).toEqual(["1"]);
	});
	it("keeps classification independent of opaque identities and object property order", async () => {
		const original = structuredClone(proposal);
		original.tasks[0].inputs = ["Observed response: 500"];
		original.tasks[0].resourceScope = ["src/z", "src/a"];
		original.tasks.push({
			...structuredClone(original.tasks[0]),
			taskId: "ui",
			objective: "Trace web rendering",
			dependencies: ["api"],
		});
		const renamed: WorkProposal = {
			tasks: original.tasks.map((task, index) => ({
				limits: {
					outputBytes: task.limits.outputBytes,
					steps: task.limits.steps,
					durationMs: task.limits.durationMs,
				},
				accessMode: task.accessMode,
				resourceScope: [...task.resourceScope].reverse(),
				expectedOutput: task.expectedOutput,
				inputs: [...task.inputs],
				dependencies: index ? ["opaque-first"] : [],
				proposedProfile: task.proposedProfile,
				acceptanceCriteria: [...task.acceptanceCriteria],
				objective: task.objective,
				taskId: index ? "opaque-second" : "opaque-first",
			})),
			workspaceRevision: 99,
			version: 13,
			workflowId: "unrelated-workflow",
		};
		const first = await evaluate(undefined, original);
		const second = await evaluate(undefined, renamed);
		expect(first.toolResult.isError).toBe(false);
		expect(second.toolResult.isError).toBe(false);
		expect(second.observed).toEqual(first.observed);
		expect(second.observed.map((context) => JSON.stringify(context))).toEqual(
			first.observed.map((context) => JSON.stringify(context)),
		);
		const initial = first.observed[0].state;
		expect(initial).toMatchObject({
			contextVersion: 3,
			proposal: {
				tasks: [
					{ ...original.tasks[0], taskId: "task_0", resourceScope: ["src/a", "src/z"] },
					{ ...original.tasks[1], taskId: "task_1", dependencies: ["task_0"], resourceScope: ["src/a", "src/z"] },
				],
			},
		});
		const profileContext = first.observed.find((context) => context.questions.profile)!.state;
		expect(profileContext).not.toHaveProperty("proposal");
		expect(first.observed.find((context) => context.questions.parallel)!.state).toHaveProperty("proposal");
		expect(second.decision).toMatchObject({
			kind: "delegated",
			plan: { proposal: renamed, selections: [{ taskId: "opaque-first" }, { taskId: "opaque-second" }] },
		});
		const trace = second.harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom" && entry.customType === "relay.work.decision");
		expect(trace).toMatchObject({
			data: {
				workflow: renamed.workflowId,
				version: 13,
				workspaceRevision: 99,
				taskIds: ["opaque-first", "opaque-second"],
			},
		});
	});
	it("supplies descriptions of opaque capabilities only in their relevant decision batch", async () => {
		const names = Array.from({ length: 10 }, (_, index) => `cap_${index}`);
		const resources: WorkResourceCatalog = {
			checkpoint: delegationCheckpoint(),
			profiles: { engineer: { tools: names } },
			tools: [...names, "hidden"],
			skills: ["practice"],
			allowedTools: names,
			allowedSkills: ["practice"],
			descriptions: {
				tools: Object.fromEntries([...names, "hidden"].map((name) => [name, `Observed capability of ${name}`])),
				skills: { practice: "Review acceptance evidence" },
			},
		};
		const { observed, toolResult } = await evaluate(undefined, proposal, resources);
		expect(toolResult.isError).toBe(false);
		const batches = observed.filter((context) =>
			Object.keys(context.questions).some((id) => id.startsWith("resource_")),
		);
		expect(batches).toHaveLength(2);
		expect(batches[0].state.capabilities).toEqual(
			names.slice(0, 8).map((name) => ({ kind: "tool", name, description: resources.descriptions.tools[name] })),
		);
		expect(batches[1].state.capabilities).toEqual([
			...names.slice(8).map((name) => ({ kind: "tool", name, description: resources.descriptions.tools[name] })),
			{ kind: "skill", name: "practice", description: "Review acceptance evidence" },
		]);
		expect(JSON.stringify(observed)).not.toContain("hidden");
	});
	it.each([undefined, "", "   "])(
		"rejects a missing or blank description before classification: %j",
		async (description) => {
			const descriptions = { tools: { ...catalog.descriptions.tools }, skills: { ...catalog.descriptions.skills } };
			if (description === undefined) delete descriptions.tools.read;
			else descriptions.tools.read = description;
			const { decision, observed, toolResult } = await evaluate(undefined, proposal, { ...catalog, descriptions });
			expect(decision).toBeUndefined();
			expect(observed).toEqual([]);
			expect(toolResult).toMatchObject({
				isError: true,
				content: [{ text: expect.stringContaining("Missing work resource description: tools/read") }],
			});
		},
	);
	it("exposes effective tool capabilities for known profiles before Laya selects one", async () => {
		const proposed = structuredClone(proposal);
		proposed.tasks[0].proposedProfile = "backend-engineer";
		proposed.tasks[0].accessMode = "validation";
		const { observed, toolResult } = await evaluate(
			(context, result) => {
				if (context.questions.profile)
					result.answers.profile = {
						type: "choice",
						choice: "backend-engineer",
						confidence: 0.95,
						probabilities: { "backend-engineer": 0.95 },
					};
				return result;
			},
			proposed,
			{
				checkpoint: delegationCheckpoint(),
				profiles: {
					"backend-engineer": { tools: ["read", "powershell", "complete_work", "unselected", "absent"] },
					"frontend-engineer": { tools: ["read", "write"] },
				},
				tools: ["read", "write", "powershell", "complete_work", "unselected"],
				descriptions: {
					tools: {
						read: "Read files",
						write: "Write files",
						powershell: "Run commands",
						complete_work: "Complete delegated work",
						unselected: "Unavailable tool",
					},
					skills: {},
				},
				allowedTools: ["read", "powershell", "complete_work", "absent"],
				skills: [],
				allowedSkills: [],
			},
		);
		expect(toolResult.isError).toBe(false);
		const question = observed.find((context) => context.questions.profile)!.questions.profile;
		expect(question.criteria).toMatchObject({
			"backend-engineer": expect.stringContaining("Tools: read, powershell."),
			"frontend-engineer": expect.stringContaining("Tools: read."),
		});
		expect(JSON.stringify(question.criteria)).not.toMatch(/complete_work|unselected|write|absent/);
	});
	it("does not clamp a Laya concurrency answer outside the configured alternatives", async () => {
		const { decision, toolResult } = await evaluate(undefined, proposal, {
			...catalog,
			limits: { maxConcurrent: 1 },
		});
		expect(decision).toBeUndefined();
		expect(toolResult).toMatchObject({
			isError: true,
			content: [{ text: expect.stringContaining("Malformed Laya work decision: concurrency") }],
		});
	});
	it.each(["direct", "revise"])("does not authorize workers when Laya chooses %s", async (mode) => {
		const { decision, observed, harness } = await evaluate((context, result) => {
			if (context.questions.work_mode)
				result.answers.work_mode = {
					type: "choice",
					choice: mode,
					confidence: 0.95,
					probabilities: { [mode]: 0.95 },
				};
			return result;
		});
		expect(decision).toMatchObject({ kind: mode });
		expect(observed).toHaveLength(1);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "relay.work.plan"),
		).toBe(false);
	});
	it("reassesses uncertainty once with focused criteria", async () => {
		let assessments = 0;
		const { decision, observed } = await evaluate((context, result) => {
			if (context.questions.parallel && ++assessments === 1)
				result.answers.parallel = { type: "bool", probability: 0.5 };
			return result;
		});
		expect(decision?.kind).toBe("delegated");
		expect(assessments).toBe(2);
		expect(
			observed.filter((context) => context.questions.parallel).at(-1)?.questions.parallel.instructions,
		).toContain("Focused reassessment");
	});
	it("preserves the proposal without approval on persistent uncertainty", async () => {
		const original = structuredClone(proposal);
		const { decision, toolResult, harness } = await evaluate((context, result) => {
			if (context.questions.parallel) result.answers.parallel = { type: "bool", probability: 0.5 };
			return result;
		});
		expect(decision).toBeUndefined();
		expect(toolResult).toMatchObject({
			isError: true,
			content: [{ type: "text", text: expect.stringContaining("Uncertain Laya") }],
		});
		expect(proposal).toEqual(original);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "relay.work.plan"),
		).toBe(false);
	});
	it("rejects malformed decisions without a substitute decision", async () => {
		const { decision, toolResult, observed } = await evaluate((_context, result) => ({ ...result, answers: {} }));
		expect(decision).toBeUndefined();
		expect(toolResult.isError).toBe(true);
		expect(observed).toHaveLength(1);
	});
	it("rejects a server using another checkpoint before classification", async () => {
		vi.mocked(fetch).mockImplementation(
			async () => new Response(JSON.stringify({ ok: true, version: "relay-laya-v3" })),
		);
		const { decision, toolResult, observed } = await evaluate();
		expect(decision).toBeUndefined();
		expect(toolResult).toMatchObject({
			isError: true,
			content: [{ type: "text", text: expect.stringContaining("relay-laya-v5") }],
		});
		expect(observed).toHaveLength(0);
	});
	it("rejects selecting a dependent task while omitting its prerequisite", async () => {
		const proposed = structuredClone(proposal);
		proposed.tasks.push({ ...structuredClone(proposal.tasks[0]), taskId: "ui", dependencies: ["api"] });
		const { decision, toolResult } = await evaluate((context, result) => {
			if (context.questions.task_0) result.answers.task_0 = { type: "bool", probability: 0.05 };
			return result;
		}, proposed);
		expect(decision).toBeUndefined();
		expect(toolResult).toMatchObject({
			isError: true,
			content: [{ type: "text", text: expect.stringContaining("unselected dependency") }],
		});
	});
	it("never asks to parallelize validation even if Laya selects several workers", async () => {
		const proposed = structuredClone(proposal);
		proposed.tasks[0].accessMode = "validation";
		const { decision, observed } = await evaluate(undefined, proposed);
		expect(decision).toMatchObject({ kind: "delegated", plan: { selections: [{ executionMode: "exclusive" }] } });
		expect(observed.some((context) => context.questions.parallel)).toBe(false);
	});
});
