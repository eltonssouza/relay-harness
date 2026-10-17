import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createProvider, fauxAssistantMessage, fauxToolCall } from "@relay-harness/ai";
import { typesafeSystemOneApi } from "@relay-harness/ai/api/typesafe-system-one.lazy";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { WorkProposal, WorkResourceCatalog, WorkTask } from "../src/core/delegation/contracts.ts";
import { delegationCheckpoint } from "../src/extensions/delegation/checkpoint.ts";
import { decideWork, type WorkDecision } from "../src/extensions/delegation/decisions.ts";
import { useCandidateCheckpoint } from "./delegation-checkpoint-evaluation.ts";
import { delegationTestClassifier } from "./delegation-test-support.ts";
import { createHarness } from "./suite/harness.ts";

// Explicitly targeted local model evaluation; never included in the offline test gate.
const enabled = process.env.RELAY_EVALUATE_DELEGATION === "1";
const task = (
	taskId: string,
	objective: string,
	accessMode: WorkTask["accessMode"],
	dependencies: string[] = [],
): WorkTask => ({
	taskId,
	objective,
	accessMode,
	dependencies,
	acceptanceCriteria: [objective],
	proposedProfile: "backend-engineer",
	inputs: [],
	expectedOutput: "Findings and observed evidence",
	resourceScope: ["."],
	limits: { durationMs: 30_000, steps: 10, outputBytes: 4000 },
});
const scenarios = [
	{
		id: "small-change",
		goal: "Correct the typo 'Logni' to 'Login' in one button label; no other behavior changes",

		expected: "direct",
		tasks: [task("label", "Replace the misspelled label in src/login.tsx", "mutation")],
	},
	{
		id: "independent-investigations",
		goal: "Investigate independent failures in the API and web UI login implementations before designing a fix. Separate read-only investigations can run simultaneously",

		expected: "delegated",
		tasks: [
			task("api", "Identify the API login failure by reading src/api", "investigation"),
			task("ui", "Independently identify the web UI login failure by reading src/ui", "investigation"),
		],
	},
	{
		id: "dependent-change-validation",
		goal: "Implement the specified login fix, then validate the resulting workspace. Validation must wait for implementation and both may create files",

		expected: "delegated",
		tasks: [
			task("implement", "Implement the specified login correction", "mutation"),
			task("validate", "Run behavioral tests after implementation is accepted", "validation", ["implement"]),
		],
	},
	{
		id: "conflicting-requirements",
		goal: "Review this inconsistent proposal before execution. The same acceptance criteria cannot require both enabling and disabling authentication in the same deployment; the proposal must be revised",

		expected: "revise",
		tasks: [
			task("enable", "Require authentication enabled in the final auth.json", "mutation"),
			task("disable", "Require authentication disabled in the same final auth.json", "mutation"),
		],
	},
];

describe.skipIf(!enabled)("real relay-laya-v4 delegation evaluation", () => {
	it("evaluates the production questions on representative proposals and preserves all traces", async () => {
		vi.stubEnv("RELAY_OFFLINE", undefined);
		useCandidateCheckpoint();
		const baseUrl = process.env.LAYA_BASE_URL ?? "http://127.0.0.1:8737/v1";
		const healthResponse = await fetch(new URL("/health", baseUrl));
		if (!healthResponse.ok) throw new Error("The local evaluation checkpoint is unavailable");
		const checkpointIdentity: unknown = await healthResponse.json();
		const catalog: WorkResourceCatalog = {
			checkpoint: delegationCheckpoint(),
			profiles: {
				"backend-engineer": { tools: ["read", "write", "powershell"] },
				"frontend-engineer": { tools: ["read", "write"] },
			},
			tools: ["read", "write", "powershell"],
			skills: [],
			descriptions: {
				tools: {
					read: "Read file contents",
					write: "Write file contents",
					powershell: "Execute commands and behavioral tests",
				},
				skills: {},
			},
			allowedTools: ["read", "write", "powershell"],
			allowedSkills: [],
		};
		const rows: Array<{
			id: string;
			expected: string;
			observed?: string;
			passed: boolean;
			elapsedMs: number;
			error?: string;
			decision?: WorkDecision;
			traces: unknown[];
		}> = [];
		let selected = scenarios[0];
		let observed: WorkDecision | undefined;
		let error: string | undefined;
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(relay) =>
					relay.registerProvider(
						createProvider({
							id: "laya",
							models: [{ ...delegationTestClassifier, baseUrl }],
							auth: {
								apiKey: {
									name: "Local evaluation",
									resolve: async () => ({ auth: { apiKey: "local", baseUrl } }),
								},
							},
							classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
						}),
					),
				(relay) =>
					relay.registerTool({
						name: "evaluate_work",
						label: "Evaluate",
						description: "Evaluate a bounded work proposal using the local checkpoint",
						parameters: Type.Object({}),
						execute: async (_id, _args, signal, _onUpdate, ctx) => {
							const proposal: WorkProposal = {
								workflowId: "evaluation",

								version: 1,
								workspaceRevision: 0,
								tasks: selected.tasks,
							};
							try {
								observed = await decideWork(relay, ctx, selected.goal, proposal, catalog, signal);
							} catch (failure) {
								error = failure instanceof Error ? failure.message : String(failure);
							}
							return {
								content: [{ type: "text", text: observed?.kind ?? error ?? "No decision" }],
								details: {},
							};
						},
					}),
			],
		});
		try {
			await harness.session.bindExtensions({});
			for (const scenario of scenarios) {
				selected = scenario;
				observed = undefined;
				error = undefined;
				const firstEntry = harness.sessionManager.getBranch().length;
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("evaluate_work", {}), { stopReason: "toolUse" }),
					fauxAssistantMessage("Evaluation recorded"),
				]);
				const started = performance.now();
				await harness.session.prompt(scenario.goal);
				const decision = observed as WorkDecision | undefined;
				const traces = harness.sessionManager
					.getBranch()
					.slice(firstEntry)
					.flatMap((entry) =>
						entry.type === "custom" && entry.customType === "relay.work.decision" ? [entry.data] : [],
					);
				const resourcesPassed =
					decision?.kind !== "delegated" ||
					scenario.tasks.every((task) => {
						const selection = decision.plan.selections.find((selection) => selection.taskId === task.taskId);
						if (!selection) return false;
						if (task.accessMode === "investigation")
							return (
								selection.tools.includes("read") &&
								selection.tools.every((tool) => tool === "read") &&
								selection.profile === (task.taskId === "ui" ? "frontend-engineer" : "backend-engineer")
							);
						return (
							selection.executionMode === "exclusive" &&
							selection.tools.includes(task.accessMode === "mutation" ? "write" : "powershell")
						);
					});
				const passed =
					resourcesPassed &&
					decision?.kind === scenario.expected &&
					(scenario.id !== "independent-investigations" ||
						(decision.kind === "delegated" &&
							decision.plan.maxConcurrent >= 2 &&
							decision.plan.selections.length === 2 &&
							decision.plan.selections.every((selection) => selection.executionMode === "parallel")));
				rows.push({
					id: scenario.id,
					expected: scenario.expected,
					observed: decision?.kind,
					passed,
					elapsedMs: performance.now() - started,
					error,
					decision,
					traces,
				});
			}
			const destination = resolve(
				process.env.RELAY_DELEGATION_EVAL_OUTPUT ??
					"../../development/laya-subagentes/phase-independent-checkpoint-evaluation.json",
			);
			mkdirSync(resolve(destination, ".."), { recursive: true });
			writeFileSync(
				destination,
				`${JSON.stringify({ version: 2, evaluatedAt: new Date().toISOString(), model: "relay-laya-v4", checkpointIdentity, baseUrl, passed: rows.every((row) => row.passed), paidProviderCalls: 0, workerExecution: "Covered separately by suite/delegation.test.ts using the faux provider and real Node tests", rows }, null, 2)}\n`,
			);
			expect(
				rows
					.filter((row) => !row.passed)
					.map((row) => ({ id: row.id, expected: row.expected, observed: row.observed, error: row.error })),
			).toEqual([]);
		} finally {
			harness.cleanup();
			vi.unstubAllEnvs();
			vi.restoreAllMocks();
		}
	}, 600_000);
});
