import { randomUUID } from "node:crypto";
import type { ClassifierQuestion, ClassifierResult, JsonObject } from "@relay-harness/ai";
import {
	type ApprovedWorkPlan,
	validateApprovedWorkPlan,
	validateWorkProposal,
	WORKER_CONTROL_TOOLS,
	type WorkerSelection,
	type WorkProposal,
	type WorkResourceCatalog,
	type WorkTask,
} from "../../core/delegation/contracts.ts";
import { resolveDelegationLimits } from "../../core/delegation/limits.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { isSameLayaCheckpoint } from "../laya/model-identity.ts";
import { AGENTS, type AgentId } from "../laya/questions.ts";
import { DELEGATION_MODEL, delegationCheckpoint } from "./checkpoint.ts";
import { classifyWork } from "./classifier.ts";

export type WorkDecision =
	| { kind: "direct" | "revise"; decisionId: string }
	| { kind: "delegated"; decisionId: string; plan: ApprovedWorkPlan };

interface WorkCapability {
	kind: "tool" | "skill";
	name: string;
	description: string;
}

/** Evaluate bounded alternatives. No worker can be started by this operation. */
export async function decideWork(
	relay: ExtensionAPI,
	ctx: ExtensionContext,
	goal: string,
	proposal: WorkProposal,
	catalog: WorkResourceCatalog,
	signal?: AbortSignal,
): Promise<WorkDecision> {
	const current = validateWorkProposal(proposal, catalog);
	const checkpoint = delegationCheckpoint();
	if (!isSameLayaCheckpoint(catalog.checkpoint, checkpoint))
		throw new Error("Work catalog checkpoint changed; submit a new proposal");
	const limits = resolveDelegationLimits(catalog.limits);
	const decisionId = randomUUID();
	// IDs and object insertion order carry no task semantics. Keep actual IDs in the trace and plan.
	const references = new Map(current.tasks.map((task, index) => [task.taskId, `task_${index}`]));
	const tasks: JsonObject[] = current.tasks.map((task) => ({
		objective: task.objective,
		acceptanceCriteria: [...task.acceptanceCriteria],
		accessMode: task.accessMode,
		dependencies: task.dependencies.map((id) => references.get(id)!).sort(),
		inputs: [...task.inputs],
		resourceScope: [...task.resourceScope].sort(),
		expectedOutput: task.expectedOutput,
		proposedProfile: task.proposedProfile,
		limits: { durationMs: task.limits.durationMs, steps: task.limits.steps, outputBytes: task.limits.outputBytes },
		taskId: references.get(task.taskId)!,
	}));
	const context: JsonObject = {
		contextVersion: 3,
		goal,
		proposal: { tasks },
		guidance:
			"The principal proposes tasks, Laya selects work and resources, and the Harness enforces permissions and evidence. Prefer direct execution for small tasks. Independent investigations may overlap; validation and mutations require exclusive workspace access. Workers cannot delegate or complete the principal goal. Dependencies must all be selected.",
	};
	const ask = async (
		questions: Record<string, ClassifierQuestion>,
		options: { task?: WorkTask; overview?: boolean; resources?: readonly WorkCapability[] } = {},
	): Promise<ClassifierResult["answers"]> => {
		const target = options.task ? tasks[current.tasks.indexOf(options.task)] : undefined;
		const scopedContext: JsonObject = target
			? {
					contextVersion: 3,
					task: target,
					goal,
					...(options.overview ? { proposal: { tasks } } : {}),
					guidance: context.guidance,
				}
			: context;
		const answers: ClassifierResult["answers"] = {};
		const entries = Object.entries(questions);
		for (let offset = 0; offset < entries.length; offset += 8) {
			let pending = Object.fromEntries(entries.slice(offset, offset + 8));
			const decisionContext: JsonObject = {
				...scopedContext,
				...(options.resources
					? {
							capabilities: options.resources
								.filter((_resource, index) => Object.hasOwn(pending, `resource_${index}`))
								.map((resource) => ({
									kind: resource.kind,
									name: resource.name,
									description: resource.description,
								})),
						}
					: {}),
			};
			for (let attempt = 1; attempt <= 2 && Object.keys(pending).length; attempt++) {
				const result = await classifyWork(relay, ctx, decisionContext, pending, signal);
				relay.appendEntry("relay.work.decision", {
					decisionId,
					workflow: current.workflowId,
					version: current.version,
					workspaceRevision: current.workspaceRevision,
					taskIds: current.tasks.map((task) => task.taskId),
					taskId: options.task?.taskId,
					model: DELEGATION_MODEL,
					checkpoint,
					attempt,
					context: decisionContext,
					questions: pending,
					answers: result.answers,
				});
				const uncertain: Record<string, ClassifierQuestion> = {};
				for (const [id, question] of Object.entries(pending)) {
					const answer = result.answers[id];
					let confidence: number;
					if (
						question.type === "bool" &&
						answer?.type === "bool" &&
						Number.isFinite(answer.probability) &&
						answer.probability >= 0 &&
						answer.probability <= 1
					)
						confidence = Math.max(answer.probability, 1 - answer.probability);
					else if (
						question.type === "choice" &&
						answer?.type === "choice" &&
						Object.hasOwn(question.criteria, answer.choice) &&
						Number.isFinite(answer.confidence) &&
						answer.confidence >= 0 &&
						answer.confidence <= 1 &&
						Number.isFinite(answer.probabilities[answer.choice]) &&
						answer.probabilities[answer.choice] >= 0 &&
						answer.probabilities[answer.choice] <= 1
					)
						confidence = Math.min(answer.confidence, answer.probabilities[answer.choice]);
					else throw new Error(`Malformed Laya work decision: ${id}`);
					if (confidence < 0.7) {
						uncertain[id] = {
							...question,
							instructions: `Focused reassessment: ${question.instructions} Decide only from the stated objective, criteria, dependencies and available capabilities.`,
						};
					} else answers[id] = answer;
				}
				pending = uncertain;
			}
			if (Object.keys(pending).length)
				throw new Error(`Uncertain Laya work decision: ${Object.keys(pending).join(", ")}`);
		}
		return answers;
	};
	const mode = (
		await ask({
			work_mode: {
				type: "choice",
				instructions: `Does the authorized task benefit from the proposed workers, should the principal execute directly, or does the proposal require revision?`,
				criteria: {
					direct: "Small or coupled task: execute directly without workers",
					delegated: "Useful bounded worker tasks with clear acceptance criteria",
					revise: "Revise tasks, criteria, scope or dependencies before delegation",
				},
			},
		})
	).work_mode;
	if (mode?.type !== "choice") throw new Error("Missing work mode");
	if (mode.choice === "direct" || mode.choice === "revise") return { kind: mode.choice, decisionId };
	const taskQuestions: Record<string, ClassifierQuestion> = {
		concurrency: {
			type: "choice",
			instructions:
				"What is the maximum useful worker concurrency for this proposal? Exclusive tasks remain serialized by the Harness.",
			criteria: Object.fromEntries(
				Array.from({ length: limits.maxConcurrent }, (_, index) => {
					const count = index + 1;
					return [
						String(count),
						count === 1
							? "One worker at a time"
							: `At most ${count === 2 ? "two" : count === 3 ? "three" : count} independent workers`,
					];
				}),
			),
		},
	};
	for (const [index, task] of current.tasks.entries())
		taskQuestions[`task_${index}`] = {
			type: "bool",
			instructions: `Is task ${references.get(task.taskId)} necessary in the delegated plan? ${task.objective} Dependencies: ${
				task.dependencies
					.map((id) => references.get(id)!)
					.sort()
					.join(", ") || "none"
			}.`,
			criteria: { true: "Required bounded contribution", false: "Unnecessary work or better executed directly" },
		};
	const taskAnswers = await ask(taskQuestions);
	const concurrency = taskAnswers.concurrency;
	if (concurrency?.type !== "choice") throw new Error("Missing worker concurrency");
	const selections: WorkerSelection[] = [];
	for (const [index, task] of current.tasks.entries()) {
		const needed = taskAnswers[`task_${index}`];
		if (needed?.type !== "bool") throw new Error("Missing task decision");
		if (needed.probability < 0.5) continue;
		const profileAnswer = (
			await ask(
				{
					profile: {
						type: "choice",
						instructions: `Which available profile should execute the target task: ${task.objective}? Proposed: ${task.proposedProfile}.`,
						criteria: Object.fromEntries(
							Object.keys(catalog.profiles).map((name) => [
								name,
								`Tools: ${catalog.profiles[name].tools.filter((tool) => catalog.tools.includes(tool) && catalog.allowedTools.includes(tool) && !WORKER_CONTROL_TOOLS.includes(tool)).join(", ") || "none"}. ${Object.hasOwn(AGENTS, name) ? AGENTS[name as AgentId] : `Profile ${name}`}`,
							]),
						),
					},
				},
				{ task },
			)
		).profile;
		if (profileAnswer?.type !== "choice") throw new Error("Missing worker profile");
		const profile = profileAnswer.choice;
		const candidates = [
			...catalog.tools
				.filter(
					(name) =>
						catalog.allowedTools.includes(name) &&
						catalog.profiles[profile].tools.includes(name) &&
						!WORKER_CONTROL_TOOLS.includes(name),
				)
				.map((name) => ({ kind: "tool" as const, name, description: catalog.descriptions.tools[name] })),
			...catalog.skills
				.filter((name) => catalog.allowedSkills.includes(name))
				.map((name) => ({ kind: "skill" as const, name, description: catalog.descriptions.skills[name] })),
		];
		const questions: Record<string, ClassifierQuestion> = {};
		const parallel =
			task.accessMode === "investigation"
				? (
						await ask(
							{
								parallel: {
									type: "bool",
									instructions: `May investigation ${references.get(task.taskId)} safely overlap independent investigations with a stable workspace?`,
									criteria: { true: "Independent read-only work", false: "Requires serialized execution" },
								},
							},
							{ task, overview: true },
						)
					).parallel
				: undefined;
		for (const [resourceIndex, resource] of candidates.entries())
			questions[`resource_${resourceIndex}`] = {
				type: "bool",
				instructions: `Does worker ${references.get(task.taskId)} (${task.objective}) require ${resource.kind} ${resource.name}? Use the capability description and task criteria.`,
				criteria: { true: "Necessary for the task acceptance criteria", false: "Unnecessary capability" },
			};
		const answers = await ask(questions, { task, resources: candidates });
		const selection: WorkerSelection = {
			taskId: task.taskId,
			profile,
			tools: [],
			skills: [],
			executionMode: parallel?.type === "bool" && parallel.probability >= 0.7 ? "parallel" : "exclusive",
		};
		for (const [resourceIndex, resource] of candidates.entries()) {
			const answer = answers[`resource_${resourceIndex}`];
			if (answer?.type !== "bool") throw new Error("Missing worker resource decision");
			if (answer.probability >= 0.7)
				(resource.kind === "tool" ? selection.tools : selection.skills).push(resource.name);
		}
		selections.push(selection);
	}
	const plan: ApprovedWorkPlan = {
		proposal: current,
		decisionId,
		model: DELEGATION_MODEL,
		checkpoint,
		selections,
		maxConcurrent: Number(concurrency.choice),
		limits,
	};
	if (!isSameLayaCheckpoint(checkpoint, delegationCheckpoint()))
		throw new Error("Laya checkpoint changed during work selection");
	validateApprovedWorkPlan(plan, catalog);
	relay.appendEntry("relay.work.plan", { workflow: current.workflowId, decisionId, plan });
	return { kind: "delegated", decisionId, plan };
}
