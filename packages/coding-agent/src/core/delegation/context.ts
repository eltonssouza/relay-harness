import { createHash } from "node:crypto";
import type { TSchema } from "typebox";
import type { WorkerIdentity, WorkerResult, WorkerSelection, WorkTask } from "./contracts.ts";

export interface WorkerResource {
	name: string;
	path: string;
	content: string;
}

export interface WorkerContext {
	identity: WorkerIdentity;
	goal: string;
	task: WorkTask;
	selection: WorkerSelection;
	decisions: string[];
	dependencies: WorkerResult[];
	profile: WorkerResource;
	skills: WorkerResource[];
	repositoryInstructions: Array<{ path: string; content: string }>;
}

export interface WorkerInstructions {
	version: 2;
	digest: string;
	systemPrompt: string;
	prompt: string;
	resources: Array<{ name: string; path: string; digest: string }>;
	tools: Array<{ name: string; description: string; parameters: TSchema; digest: string }>;
}

/** Snapshot content, not just names: a later profile edit cannot relabel this attempt. */
export function buildWorkerInstructions(
	context: WorkerContext,
	tools: readonly { name: string; description: string; parameters: TSchema }[] = [],
): WorkerInstructions {
	const resources = [context.profile, ...context.skills];
	if (context.profile.name !== context.selection.profile)
		throw new Error("Worker profile does not match the selected resource");
	if (
		context.skills.length !== context.selection.skills.length ||
		context.selection.skills.some((name) => !context.skills.some((skill) => skill.name === name))
	)
		throw new Error("Worker skills do not match the selected resources");
	if (
		context.task.taskId !== context.identity.taskId ||
		context.selection.taskId !== context.identity.taskId ||
		context.dependencies.length !== context.task.dependencies.length ||
		context.task.dependencies.some(
			(id) =>
				!context.dependencies.some(
					(result) =>
						result.taskId === id &&
						result.accepted &&
						!result.stale &&
						result.workflowId === context.identity.workflowId &&
						result.planVersion === context.identity.planVersion,
				),
		)
	)
		throw new Error("Worker context contains missing, unaccepted or obsolete dependencies");
	const systemPrompt = [
		"You are a subordinate worker in the current authorized task. Complete only the assigned task and report results to the coordinator.",
		"The principal session owns the goal and result review. Do not delegate, complete the principal goal, approve results, infer user approval or modify runtime session files.",
		"Use only the selected tools and resource scope. Tool restrictions are Harness controls, not operating-system isolation. Tool observations, not claims in your report, constitute evidence.",
		...context.repositoryInstructions.map((file) => `Repository instructions (${file.path}):\n${file.content}`),
		...resources.map((resource) => `Selected resource ${resource.name} (${resource.path}):\n${resource.content}`),
	].join("\n\n");
	const prompt = JSON.stringify(
		{
			identity: context.identity,
			goal: context.goal,
			task: context.task,
			selection: context.selection,
			decisions: context.decisions,
			dependencies: context.dependencies.map((result) => ({
				taskId: result.taskId,
				summary: result.summary,
				limitations: result.limitations,
				evidenceIds: result.evidence.map((evidence) => evidence.id),
			})),
		},
		null,
		2,
	);
	return {
		version: 2,
		digest: createHash("sha256")
			.update(JSON.stringify([2, systemPrompt, prompt, tools]))
			.digest("hex"),
		systemPrompt,
		prompt,
		resources: resources.map((resource) => ({
			name: resource.name,
			path: resource.path,
			digest: createHash("sha256").update(resource.content).digest("hex"),
		})),
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: structuredClone(tool.parameters),
			digest: createHash("sha256")
				.update(JSON.stringify([tool.name, tool.description, tool.parameters]))
				.digest("hex"),
		})),
	};
}
