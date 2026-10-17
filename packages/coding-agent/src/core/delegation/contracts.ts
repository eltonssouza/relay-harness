import type { Usage } from "@relay-harness/ai";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { isSameLayaCheckpoint, type LayaCheckpointIdentity } from "../../extensions/laya/model-identity.ts";
import {
	DEFAULT_DELEGATION_LIMITS,
	DELEGATION_LIMIT_CAPS,
	type DelegationLimits,
	resolveDelegationLimits,
} from "./limits.ts";

export const WORKER_CONTROL_TOOLS: readonly string[] = [
	"propose_work",
	"execute_work",
	"review_work",
	"complete_work",
	"create_goal",
	"update_goal",
	"get_goal",
	"native_mcp",
	"tool_search",
	"codemode",
];

const identifier = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$" });
const text = Type.String({ minLength: 1, maxLength: 16_000, pattern: "\\S" });
const names = Type.Array(text, { uniqueItems: true, maxItems: 128 });

export const workTaskSchema = Type.Object(
	{
		taskId: identifier,
		objective: text,
		acceptanceCriteria: Type.Array(text, { minItems: 1, maxItems: 32, uniqueItems: true }),
		proposedProfile: text,
		dependencies: Type.Array(identifier, { maxItems: DELEGATION_LIMIT_CAPS.maxTasks, uniqueItems: true }),
		inputs: Type.Array(text, { maxItems: 32 }),
		expectedOutput: text,
		resourceScope: Type.Array(text, { minItems: 1, maxItems: 128, uniqueItems: true }),
		accessMode: Type.Union([Type.Literal("investigation"), Type.Literal("validation"), Type.Literal("mutation")]),
		limits: Type.Object(
			{
				durationMs: Type.Integer({ minimum: 1, maximum: DELEGATION_LIMIT_CAPS.maxDurationMs }),
				steps: Type.Integer({ minimum: 1, maximum: DELEGATION_LIMIT_CAPS.maxSteps }),
				outputBytes: Type.Integer({ minimum: 1, maximum: DELEGATION_LIMIT_CAPS.maxOutputBytes }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const workProposalSchema = Type.Object(
	{
		workflowId: identifier,
		version: Type.Integer({ minimum: 1 }),
		workspaceRevision: Type.Integer({ minimum: 0 }),
		tasks: Type.Array(workTaskSchema, { minItems: 1, maxItems: DELEGATION_LIMIT_CAPS.maxTasks }),
	},
	{ additionalProperties: false },
);

export type WorkTask = Static<typeof workTaskSchema>;
export type WorkProposal = Static<typeof workProposalSchema>;

export interface WorkerSelection {
	taskId: string;
	profile: string;
	tools: string[];
	skills: string[];
	/** Validation and mutation both take the exclusive workspace lease. */
	executionMode: "parallel" | "exclusive";
}

export interface ApprovedWorkPlan {
	proposal: WorkProposal;
	decisionId: string;
	model: "relay-laya-v4";
	checkpoint: LayaCheckpointIdentity;
	selections: WorkerSelection[];
	maxConcurrent: number;
	/** Effective configuration when Laya evaluated this proposal. */
	limits: DelegationLimits;
}

export interface WorkResourceCatalog {
	checkpoint: LayaCheckpointIdentity;
	limits?: Partial<DelegationLimits>;
	profiles: Readonly<Record<string, { tools: readonly string[] }>>;
	tools: readonly string[];
	skills: readonly string[];
	descriptions: {
		tools: Readonly<Record<string, string>>;
		skills: Readonly<Record<string, string>>;
	};
	allowedTools: readonly string[];
	allowedSkills: readonly string[];
}

export interface WorkerIdentity {
	workflowId: string;

	planVersion: number;
	taskId: string;
	attempt: number;
	workerId: string;
}

export interface WorkerEvidence extends WorkerIdentity {
	id: string;
	toolCallId: string;
	tool: string;
	command?: string;
	isError: boolean;
	text: string;
	workspaceRevision: number;
	contentRef?: string;
}

export interface WorkerMetrics {
	/** Provider-reported worker model usage, separate from nested tool usage. */
	usage: Usage;
	toolUsage?: Usage;
	elapsedMs: number;
	steps: number;
	outputBytes: number;
}

export interface WorkerResult extends WorkerIdentity, Partial<WorkerMetrics> {
	summary: string;
	limitations: string[];
	evidence: WorkerEvidence[];
	workspaceRevision: number;
	/** Set by the coordinator after checking criteria, never by the worker. */
	accepted: boolean;
	stale: boolean;
}

export interface WorkerRun extends WorkerIdentity {
	key: string;
	status: "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
	contextDigest?: string;
	resources?: WorkerSelection;
	startedAt?: string;
	finishedAt?: string;
	reason?: string;
	result?: WorkerResult;
	/** Observed even when the attempt fails or is cancelled without a result. */
	metrics?: WorkerMetrics;
	/** Interrupted side effects must be reconciled before a new attempt. */
	reconciled: boolean;
}

const proposalValidator = Compile(workProposalSchema);
const namesValidator = Compile(names);

export function validateWorkProposal(value: unknown, catalog: WorkResourceCatalog): WorkProposal {
	if (!proposalValidator.Check(value)) throw new Error("Invalid work proposal structure");
	if (!isSameLayaCheckpoint(catalog.checkpoint, catalog.checkpoint)) throw new Error("Missing pinned work checkpoint");
	for (const kind of ["tools", "skills"] as const)
		for (const name of catalog[kind]) {
			const description = catalog.descriptions?.[kind]?.[name];
			if (typeof description !== "string" || !description.trim())
				throw new Error(`Missing work resource description: ${kind}/${name}`);
		}
	const limits = resolveDelegationLimits(catalog.limits);
	const proposal = structuredClone(value);
	if (proposal.tasks.length > limits.maxTasks) throw new Error(`Work proposal exceeds maxTasks: ${limits.maxTasks}`);
	const tasks = new Map<string, WorkTask>();
	for (const task of proposal.tasks) {
		if (
			task.limits.durationMs > limits.maxDurationMs ||
			task.limits.steps > limits.maxSteps ||
			task.limits.outputBytes > limits.maxOutputBytes
		)
			throw new Error(`Task exceeds configured delegation limits: ${task.taskId}`);
		if (tasks.has(task.taskId)) throw new Error(`Duplicate task ID: ${task.taskId}`);
		if (!Object.hasOwn(catalog.profiles, task.proposedProfile))
			throw new Error(`Unavailable profile: ${task.proposedProfile}`);
		tasks.set(task.taskId, task);
	}
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) throw new Error(`Dependency cycle: ${id}`);
		if (visited.has(id)) return;
		const task = tasks.get(id);
		if (!task) throw new Error(`Missing dependency: ${id}`);
		visiting.add(id);
		for (const dependency of task.dependencies) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of tasks.keys()) visit(id);
	return proposal;
}

/** Structural validation does not confer approval: the caller must record the Laya decision. */
export function validateApprovedWorkPlan(plan: ApprovedWorkPlan, catalog: WorkResourceCatalog): void {
	if (!isSameLayaCheckpoint(plan.checkpoint, catalog.checkpoint) || plan.checkpoint.version !== plan.model)
		throw new Error("The Laya work checkpoint changed or is missing; submit a new work proposal");
	if (!plan.limits || Object.keys(DEFAULT_DELEGATION_LIMITS).some((key) => !Object.hasOwn(plan.limits, key)))
		throw new Error("Approved work plan is missing its configured limits");
	const limits = resolveDelegationLimits(plan.limits);
	const currentLimits = resolveDelegationLimits(catalog.limits);
	if (
		Object.keys(limits).some(
			(key) => limits[key as keyof DelegationLimits] !== currentLimits[key as keyof DelegationLimits],
		)
	)
		throw new Error("Delegation limits changed; submit a new proposal for Laya evaluation");
	const proposal = validateWorkProposal(plan.proposal, catalog);
	if (plan.model !== "relay-laya-v4" || !plan.decisionId?.trim()) throw new Error("Missing Laya work decision");
	if (!Number.isInteger(plan.maxConcurrent) || plan.maxConcurrent < 1 || plan.maxConcurrent > limits.maxConcurrent)
		throw new Error("Invalid worker concurrency limit");
	if (!plan.selections.length || plan.selections.length > proposal.tasks.length)
		throw new Error("Invalid worker selections");
	const selected = new Set<string>();
	for (const selection of plan.selections) {
		const task = proposal.tasks.find((task) => task.taskId === selection.taskId);
		if (!task || selected.has(selection.taskId)) throw new Error(`Invalid selected task: ${selection.taskId}`);
		selected.add(selection.taskId);
		if (!Object.hasOwn(catalog.profiles, selection.profile))
			throw new Error(`Unavailable profile: ${selection.profile}`);
		if (!namesValidator.Check(selection.tools) || !namesValidator.Check(selection.skills))
			throw new Error(`Invalid resources for ${selection.taskId}`);
		const profile = catalog.profiles[selection.profile];
		for (const tool of selection.tools)
			if (
				WORKER_CONTROL_TOOLS.includes(tool) ||
				!catalog.tools.includes(tool) ||
				!catalog.allowedTools.includes(tool) ||
				!profile.tools.includes(tool)
			)
				throw new Error(`Tool outside approved scope: ${tool}`);
		for (const skill of selection.skills)
			if (!catalog.skills.includes(skill) || !catalog.allowedSkills.includes(skill))
				throw new Error(`Skill outside approved scope: ${skill}`);
		if (
			!["parallel", "exclusive"].includes(selection.executionMode) ||
			(task.accessMode !== "investigation" && selection.executionMode !== "exclusive")
		)
			throw new Error(`Task requires exclusive workspace access: ${selection.taskId}`);
	}
	for (const selection of plan.selections) {
		const task = proposal.tasks.find((task) => task.taskId === selection.taskId);
		if (task?.dependencies.some((dependency) => !selected.has(dependency)))
			throw new Error(`Selected task has an unselected dependency: ${selection.taskId}`);
	}
}

export function workerRunKey(identity: Omit<WorkerIdentity, "workerId">): string {
	return JSON.stringify([identity.workflowId, identity.planVersion, identity.taskId, identity.attempt]);
}
