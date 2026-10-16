import { setImmediate } from "node:timers/promises";
import type { AgentTool } from "@relay-harness/agent-core";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildWorkerInstructions,
	type WorkerContext,
	type WorkerInstructions,
} from "../src/core/delegation/context.ts";
import type {
	ApprovedWorkPlan,
	WorkerEvidence,
	WorkerMetrics,
	WorkerResult,
	WorkResourceCatalog,
} from "../src/core/delegation/contracts.ts";
import { DEFAULT_DELEGATION_LIMITS } from "../src/core/delegation/limits.ts";
import { runWorker } from "../src/core/delegation/runtime.ts";
import type { ExtensionAPI, ExtensionToolContext } from "../src/core/extensions/types.ts";
import { delegationCheckpoint } from "../src/extensions/delegation/checkpoint.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function fixture(): { plan: ApprovedWorkPlan; catalog: WorkResourceCatalog; contexts: WorkerContext[] } {
	const tasks = ["api", "ui"].map((taskId) => ({
		taskId,
		objective: `Investigate ${taskId} login`,
		acceptanceCriteria: [`Explain ${taskId} failure`],
		proposedProfile: "engineer",
		dependencies: [],
		inputs: [`${taskId} input`],
		expectedOutput: "Root cause",
		resourceScope: [`src/${taskId}`],
		accessMode: "investigation" as const,
		limits: { durationMs: 10_000, steps: 10, outputBytes: 16_000 },
	}));
	const plan: ApprovedWorkPlan = {
		proposal: { workflowId: "workflow-1", version: 1, workspaceRevision: 0, tasks },
		decisionId: "decision-1",
		model: "relay-laya-v4",
		checkpoint: delegationCheckpoint(),
		maxConcurrent: 3,
		limits: { ...DEFAULT_DELEGATION_LIMITS },
		selections: tasks.map((task) => ({
			taskId: task.taskId,
			profile: "engineer",
			tools: [`lookup_${task.taskId}`],
			skills: [],
			executionMode: "parallel",
		})),
	};
	return {
		plan,
		catalog: {
			checkpoint: delegationCheckpoint(),
			profiles: { engineer: { tools: ["lookup_api", "lookup_ui"] } },
			tools: ["lookup_api", "lookup_ui"],
			skills: [],
			descriptions: { tools: { lookup_api: "Inspect API", lookup_ui: "Inspect UI" }, skills: {} },
			allowedTools: ["lookup_api", "lookup_ui"],
			allowedSkills: [],
		},
		contexts: tasks.map((task, index) => ({
			identity: {
				workflowId: "workflow-1",

				planVersion: 1,
				taskId: task.taskId,
				attempt: 1,
				workerId: `worker-${task.taskId}`,
			},
			goal: "Investigate login failures",
			task,
			selection: plan.selections[index],
			decisions: ["Independent investigation before implementation"],
			dependencies: [],
			profile: { name: "engineer", path: "profiles/engineer.md", content: "Trace failures using observed behavior" },
			skills: [],
			repositoryInstructions: [{ path: "AGENTS.md", content: "Do not change files during investigation" }],
		})),
	};
}

function taskId(context: TranscriptContext): string {
	const user = context.messages.find((message) => message.role === "user");
	if (!user || user.role !== "user") throw new Error("Missing worker task");
	const content =
		typeof user.content === "string"
			? user.content
			: user.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	return (JSON.parse(content) as { identity: { taskId: string } }).identity.taskId;
}

describe("subordinate SDK workers", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	async function setup(
		execute: (ctx: ExtensionToolContext, signal?: AbortSignal) => Promise<WorkerResult[]>,
		blocked?: string,
	) {
		const calls: string[] = [];
		const observedHooks: string[] = [];
		const tools: AgentTool[] = ["api", "ui"].map((id) => ({
			name: `lookup_${id}`,
			label: `Lookup ${id}`,
			description: `Inspect ${id}`,
			parameters: Type.Object({}),
			execute: async () => {
				calls.push(id);
				return { content: [{ type: "text", text: `${id} observation` }], details: {} };
			},
		}));
		const extension = (relay: ExtensionAPI) => {
			relay.on("tool_call", (event) => {
				if (!event.toolName.startsWith("lookup_")) return;
				observedHooks.push(event.toolName);
				if (event.toolName === blocked) return { block: true, reason: "Denied by principal permission hook" };
			});
			relay.registerTool({
				name: "launch_workers",
				label: "Launch workers",
				description: "Test subordinate sessions",
				parameters: Type.Object({}),
				exposure: "model-only",
				execute: async (_id, _args, signal, _onUpdate, ctx) => ({
					content: [{ type: "text", text: JSON.stringify(await execute(ctx, signal)) }],
					details: {},
				}),
			});
		};
		const harness = await createHarness({
			tools,
			settings: { harnessCore: { evidence: false } },
			extensionFactories: [extension],
		});
		harnesses.push(harness);
		return { harness, calls, observedHooks };
	}

	it("runs two isolated sessions concurrently through the principal tool pipeline", async () => {
		const { plan, catalog, contexts } = fixture();
		const evidence: WorkerEvidence[] = [];
		const instructions: WorkerInstructions[] = [];
		let results: WorkerResult[] = [];
		let harness: Harness;
		const created = await setup(async (parent, signal) => {
			results = await Promise.all(
				contexts.map((context) =>
					runWorker({
						cwd: harness.tempDir,
						model: harness.getModel(),
						modelRuntime: harness.session.modelRuntime,
						parent,
						plan,
						catalog,
						context,
						signal,
						getWorkspaceRevision: () => 0,
						checkCall: () => {},
						onEvidence: (item) => {
							evidence.push(item);
						},
						onStarted: (snapshot) => {
							instructions.push(snapshot);
						},
					}),
				),
			);
			return results;
		});
		harness = created.harness;
		let arrived = 0;
		let release: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const investigate = async (context: TranscriptContext) => {
			if (++arrived === 2) release();
			await barrier;
			const id = taskId(context);
			const transcript = JSON.stringify(context);
			expect(transcript).toContain(`lookup_${id}`);
			expect(transcript).not.toContain(`lookup_${id === "api" ? "ui" : "api"}`);
			expect(transcript).not.toContain("launch_workers");
			return fauxAssistantMessage(fauxToolCall(`lookup_${id}`, {}, { id: "same-child-call-id" }), {
				stopReason: "toolUse",
			});
		};
		const report = (context: TranscriptContext) => fauxAssistantMessage(`${taskId(context)} root cause`);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("launch_workers", {}), { stopReason: "toolUse" }),
			investigate,
			investigate,
			report,
			report,
			fauxAssistantMessage("Integrated"),
		]);
		await harness.session.prompt("Investigate login");
		expect(arrived).toBe(2);
		expect(created.calls.sort()).toEqual(["api", "ui"]);
		expect(created.observedHooks.sort()).toEqual(["lookup_api", "lookup_ui"]);
		expect(results.map((result) => result.summary).sort()).toEqual(["api root cause", "ui root cause"]);
		expect(results.every((result) => !result.accepted && !result.stale)).toBe(true);
		expect(evidence).toHaveLength(2);
		expect(new Set(evidence.map((item) => item.id)).size).toBe(2);
		expect(new Set(evidence.map((item) => item.toolCallId)).size).toBe(2);
		expect(instructions).toHaveLength(2);
		expect(instructions[0].digest).not.toBe(instructions[1].digest);
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(harness.session.getActiveToolNames().sort()).toEqual(["launch_workers", "lookup_api", "lookup_ui"]);
		expect(
			harness.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "xp.state"),
		).toBe(false);
	});

	it("preserves principal permission denials as observed errors", async () => {
		const { plan, catalog, contexts } = fixture();
		let result: WorkerResult | undefined;
		let harness: Harness;
		const created = await setup(async (parent, signal) => {
			result = await runWorker({
				cwd: harness.tempDir,
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
				parent,
				plan,
				catalog,
				context: contexts[0],
				signal,
				getWorkspaceRevision: () => 0,
				checkCall: () => {},
				onEvidence: () => {},
			});
			return [result];
		}, "lookup_api");
		harness = created.harness;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("launch_workers", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("lookup_api", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Could not inspect API"),
			fauxAssistantMessage("Reported limitation"),
		]);
		await harness.session.prompt("Investigate");
		expect(created.calls).toEqual([]);
		expect(created.observedHooks).toEqual(["lookup_api"]);
		expect(result?.evidence[0]).toMatchObject({
			isError: true,
			text: expect.stringContaining("Denied by principal"),
		});
		expect(result?.limitations).toHaveLength(1);
	});

	it("does not turn worker test claims into evidence or permit recursive XP", async () => {
		const { plan, catalog, contexts } = fixture();
		let result: WorkerResult | undefined;
		let harness: Harness;
		const created = await setup(async (parent, signal) => {
			result = await runWorker({
				cwd: harness.tempDir,
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
				parent,
				plan,
				catalog,
				context: contexts[0],
				signal,
				getWorkspaceRevision: () => 0,
				checkCall: () => {},
				onEvidence: () => {},
			});
			return [result];
		});
		harness = created.harness;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("launch_workers", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("complete_work", { summary: "Done", evidenceIds: [] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("All tests passed"),
			fauxAssistantMessage("Reviewed"),
		]);
		await harness.session.prompt("Investigate");
		expect(result?.summary).toBe("All tests passed");
		expect(result?.limitations).toEqual(["One or more observed tool calls failed"]);
		expect(result?.evidence).toMatchObject([{ tool: "complete_work", isError: true }]);
		expect(result?.accepted).toBe(false);
		expect(created.observedHooks).toEqual([]);
	});

	it.each(["completed", "persistence-failure", "cancelled"] as const)(
		"settles asynchronous local rejection observations before metrics and outcome (%s)",
		async (outcome) => {
			const { plan, catalog, contexts } = fixture();
			const controller = new AbortController();
			const events: string[] = [];
			let release: () => void = () => {};
			const persistence = new Promise<void>((resolve) => {
				release = resolve;
			});
			let observationReady: () => void = () => {};
			const observing = new Promise<void>((resolve) => {
				observationReady = resolve;
			});
			let result: WorkerResult | undefined;
			let harness: Harness;
			const created = await setup(async (parent) => {
				result = await runWorker({
					cwd: harness.tempDir,
					model: harness.getModel(),
					modelRuntime: harness.session.modelRuntime,
					parent,
					plan,
					catalog,
					context: contexts[0],
					signal: controller.signal,
					getWorkspaceRevision: () => 0,
					checkCall: () => {},
					onEvidence: async () => {
						events.push("observation-started");
						observationReady();
						await persistence;
						if (outcome === "persistence-failure") throw new Error("Observation persistence failed");
						events.push("observation-persisted");
					},
					onFinished: () => {
						events.push("metrics");
					},
				});
				return [result];
			});
			harness = created.harness;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("launch_workers", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("complete_work", { summary: "Done", evidenceIds: [] }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Worker report"),
				fauxAssistantMessage("Coordinator report"),
			]);
			const execution = harness.session.prompt("Inspect the service");
			try {
				await observing;
				await setImmediate();
				expect(events).toEqual(["observation-started"]);
				expect(result).toBeUndefined();
				if (outcome === "cancelled") controller.abort();
			} finally {
				release();
				await execution;
			}
			expect(events).toEqual(
				outcome === "persistence-failure"
					? ["observation-started", "metrics"]
					: ["observation-started", "observation-persisted", "metrics"],
			);
			const toolResult = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "launch_workers",
			);
			expect(toolResult).toMatchObject({ isError: outcome !== "completed" });
			expect(Boolean(result)).toBe(outcome === "completed");
			expect(created.calls).toEqual([]);
		},
	);

	it("counts local tool rejection content against the worker output budget", async () => {
		const { plan, catalog, contexts } = fixture();
		const rejectedCall = fauxAssistantMessage(fauxToolCall("unavailable_".repeat(20), {}), { stopReason: "toolUse" });
		const budget = Buffer.byteLength(JSON.stringify(rejectedCall.content)) + 80;
		contexts[0].task.limits.outputBytes = budget;
		let metrics: WorkerMetrics | undefined;
		let result: WorkerResult | undefined;
		let harness: Harness;
		const created = await setup(async (parent, signal) => {
			result = await runWorker({
				cwd: harness.tempDir,
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
				parent,
				plan,
				catalog,
				context: contexts[0],
				signal,
				getWorkspaceRevision: () => 0,
				checkCall: () => {},
				onEvidence: () => {},
				onFinished: (observed) => {
					metrics = observed;
				},
			});
			return [result];
		});
		harness = created.harness;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("launch_workers", {}), { stopReason: "toolUse" }),
			rejectedCall,
			fauxAssistantMessage("Done"),
			fauxAssistantMessage("Coordinator report"),
		]);
		await harness.session.prompt("Inspect the service");
		expect(result).toBeUndefined();
		expect(metrics?.outputBytes).toBeGreaterThan(budget);
		expect(
			harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "launch_workers",
			),
		).toMatchObject({
			isError: true,
			content: [{ type: "text", text: expect.stringContaining("Worker output limit exceeded") }],
		});
		expect(created.calls).toEqual([]);
	});

	it("cancels both workers and does not execute their pending tools", async () => {
		const { plan, catalog, contexts } = fixture();
		const controller = new AbortController();
		let outcomes: PromiseSettledResult<WorkerResult>[] = [];
		let harness: Harness;
		const created = await setup(async (parent) => {
			outcomes = await Promise.allSettled(
				contexts.map((context) =>
					runWorker({
						cwd: harness.tempDir,
						model: harness.getModel(),
						modelRuntime: harness.session.modelRuntime,
						parent,
						plan,
						catalog,
						context,
						signal: controller.signal,
						getWorkspaceRevision: () => 0,
						checkCall: () => {},
						onEvidence: () => {},
					}),
				),
			);
			return [];
		});
		harness = created.harness;
		let arrived = 0;
		let release: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const response = async (context: TranscriptContext) => {
			if (++arrived === 2) {
				controller.abort();
				release();
			}
			await barrier;
			return fauxAssistantMessage(fauxToolCall(`lookup_${taskId(context)}`, {}), { stopReason: "toolUse" });
		};
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("launch_workers", {}), { stopReason: "toolUse" }),
			response,
			response,
			fauxAssistantMessage("Cancelled"),
		]);
		await harness.session.prompt("Investigate");
		expect(arrived).toBe(2);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
		expect(created.calls).toEqual([]);
		expect(created.observedHooks).toEqual([]);
	});

	it("versions instruction content and rejects unaccepted dependencies", () => {
		const { contexts } = fixture();
		const context = contexts[0];
		const old = buildWorkerInstructions(context);
		context.profile.content += "\nNew guidance";
		const updated = buildWorkerInstructions(context);
		expect(updated.digest).not.toBe(old.digest);
		expect(updated.resources[0].digest).not.toBe(old.resources[0].digest);
		const tool = { name: "read", description: "Read files", parameters: Type.Object({ path: Type.String() }) };
		const toolVersion = buildWorkerInstructions(context, [tool]);
		tool.description = "Read files with updated guidance";
		expect(buildWorkerInstructions(context, [tool]).tools[0].digest).not.toBe(toolVersion.tools[0].digest);
		expect(toolVersion.tools[0].description).toBe("Read files");
		tool.parameters = Type.Object({ path: Type.String({ minLength: 1 }) });
		expect(buildWorkerInstructions(context, [tool]).digest).not.toBe(toolVersion.digest);
		expect(toolVersion.tools[0].parameters).toEqual(Type.Object({ path: Type.String() }));
		context.task.dependencies = ["ui"];
		expect(() => buildWorkerInstructions(context)).toThrow("dependencies");
	});

	it("honors cancellation while persisting the start event without starting another response", async () => {
		const { plan, catalog, contexts } = fixture();
		const controller = new AbortController();
		let harness: Harness;
		const created = await setup(async (parent) => {
			await runWorker({
				cwd: harness.tempDir,
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
				parent,
				plan,
				catalog,
				context: contexts[0],
				signal: controller.signal,
				getWorkspaceRevision: () => 0,
				checkCall: () => {},
				onEvidence: () => {},
				onStarted: async () => {
					controller.abort();
				},
			});
			throw new Error("Cancelled worker unexpectedly completed");
		});
		harness = created.harness;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("launch_workers", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Cancellation reported"),
		]);
		await harness.session.prompt("Investigate");
		expect(harness.faux.state.callCount).toBe(2);
		expect(created.calls).toEqual([]);
		expect(
			harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "launch_workers",
			),
		).toMatchObject({ isError: true });
	});
});
