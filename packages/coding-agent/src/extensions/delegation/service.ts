import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Usage } from "@relay-harness/ai";
import { Type } from "typebox";
import type { WorkerContext, WorkerInstructions } from "../../core/delegation/context.ts";
import {
	type ApprovedWorkPlan,
	validateApprovedWorkPlan,
	validateWorkProposal,
	WORKER_CONTROL_TOOLS,
	type WorkerRun,
	type WorkerSelection,
	type WorkResourceCatalog,
	workTaskSchema,
} from "../../core/delegation/contracts.ts";
import { DELEGATION_LIMIT_CAPS, type DelegationLimits, resolveDelegationLimits } from "../../core/delegation/limits.ts";
import { runWorker } from "../../core/delegation/runtime.ts";
import type { WorkExecutionReport } from "../../core/delegation/scheduler.ts";
import { DelegationScheduler, WorkspaceLeases } from "../../core/delegation/scheduler.ts";
import { checkWorkerScope } from "../../core/delegation/scope.ts";
import { type DelegationEvent, DelegationStore } from "../../core/delegation/store.ts";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "../../core/extensions/types.ts";
import { refreshRegisteredSkills, type Skill } from "../../core/skills.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { isVirtualModel } from "../../core/virtual-models.ts";
import { type AgentProfile, loadStructuredAgentProfile } from "../engineering/index.ts";
import { isSameLayaCheckpoint } from "../laya/model-identity.ts";
import { AGENT_IDS } from "../laya/questions.ts";
import { delegationCheckpoint } from "./checkpoint.ts";
import { decideWork } from "./decisions.ts";
import type { WorkState } from "./state.ts";

type EventPayload = {
	[K in DelegationEvent["type"]]: Omit<Extract<DelegationEvent, { type: K }>, "id" | "timestamp" | "workflowId">;
}[DelegationEvent["type"]];

interface ApprovalResourceVersions {
	version: 1;
	profiles: WorkerInstructions["resources"];
	skills: Array<WorkerInstructions["resources"][number] & { description: string }>;
	tools: WorkerInstructions["tools"];
	limits: DelegationLimits;
}

interface DelegationResources {
	catalog: WorkResourceCatalog;
	profiles: AgentProfile[];
	skills: Skill[];
	toolDefinitions: Array<Pick<ToolInfo, "name" | "description" | "parameters">>;
}

export const DELEGATION_VALIDATED = false;

/** The principal owns these operations; children receive neither this service nor control tools. */
export class WorkDelegation {
	readonly leases = new WorkspaceLeases();
	private readonly worker = new AsyncLocalStorage<WorkerRun>();
	private readonly relay: ExtensionAPI;
	private readonly getState: () => WorkState | undefined;
	private readonly getSkills: () => readonly Skill[];
	private readonly save: () => void;
	private readonly enabled: boolean;
	private store?: DelegationStore;
	private owner?: WorkState;
	private scheduler?: DelegationScheduler;
	private execution?: Promise<WorkExecutionReport>;
	private readonly revisions = new Map<string, number>();
	private readonly principalLeases = new Map<string, { release: () => void; calls: Set<string> }>();
	private readonly principalCalls = new Map<string, string>();
	private readonly resourceVersions = new Map<string, Pick<WorkerInstructions, "resources" | "tools">>();
	private readonly approvalVersions = new Map<string, ApprovalResourceVersions>();

	constructor(
		relay: ExtensionAPI,
		getState: () => WorkState | undefined,
		getSkills: () => readonly Skill[],
		save: () => void,
		enabled: boolean,
	) {
		this.relay = relay;
		this.getState = getState;
		this.getSkills = getSkills;
		this.save = save;
		this.enabled = enabled;
		this.registerTools();
	}

	get currentWorker(): WorkerRun | undefined {
		return this.worker.getStore();
	}

	assertReady(ctx: ExtensionContext): void {
		const state = this.getState();
		if (state?.status === "active" && state.delegation?.plan) this.currentLimits();
		const delegated = state?.delegation;
		const plan = delegated?.plan;
		if (state && delegated?.proposal && !plan && delegated.decision?.kind !== "direct")
			throw new Error("The current work proposal requires a new valid Laya decision before completion");
		if (!state || !plan) return;
		this.checkApprovalVersions(ctx, plan);
		const pending = plan.selections.filter((selection) => {
			const run = delegated.runs.findLast(
				(run) => run.taskId === selection.taskId && run.planVersion === plan.proposal.version,
			);
			return delegated.cancelled || run?.status !== "completed" || !run.result?.accepted || run.result.stale;
		});
		if (pending.length)
			throw new Error(
				`Required delegated work must be completed and accepted: ${pending.map((task) => task.taskId).join(", ")}`,
			);
	}

	private currentLimits(): DelegationLimits {
		const limits = resolveDelegationLimits(this.relay.getSettings().delegation);
		const plan = this.store?.snapshot().plan;
		if (
			plan &&
			Object.keys(limits).some(
				(key) => plan.limits?.[key as keyof DelegationLimits] !== limits[key as keyof DelegationLimits],
			)
		)
			this.invalidate("Delegation limits changed; a new Laya work decision is required");
		return limits;
	}

	private resources(ctx: ExtensionContext): DelegationResources {
		const state = this.getState();
		if (!state || state.status !== "active") throw new Error("Start or resume the delegation task first");
		const toolDefinitions = this.relay
			.getAllTools()
			.filter(
				(tool) =>
					!["hidden", "model-only"].includes(tool.exposure ?? "direct") &&
					!WORKER_CONTROL_TOOLS.includes(tool.name),
			)
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: structuredClone(tool.parameters),
			}));
		const tools = toolDefinitions.map((tool) => tool.name);
		const profiles = AGENT_IDS.flatMap((id) => {
			const profile = loadStructuredAgentProfile(id, ctx);
			return profile ? [profile] : [];
		});
		const skills = refreshRegisteredSkills(this.getSkills()).filter((skill) => !skill.disableModelInvocation);
		return {
			profiles,
			skills,
			toolDefinitions,
			catalog: {
				checkpoint: delegationCheckpoint(),
				limits: this.currentLimits(),
				profiles: Object.fromEntries(profiles.map((profile) => [profile.name, { tools: profile.tools ?? tools }])),
				tools,
				skills: skills.map((skill) => skill.name),
				descriptions: {
					tools: Object.fromEntries(toolDefinitions.map((tool) => [tool.name, tool.description])),
					skills: Object.fromEntries(skills.map((skill) => [skill.name, skill.description])),
				},
				allowedTools: tools,
				allowedSkills: skills.map((skill) => skill.name),
			},
		};
	}

	private ensure(ctx: ExtensionContext): DelegationStore {
		const state = this.getState();
		if (!state) throw new Error("No delegation task");
		if (this.store && this.owner === state) return this.store;
		this.scheduler?.cancel();
		const events: DelegationEvent[] = [];
		this.approvalVersions.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "relay.work.resources") {
				const data = entry.data as
					| { workflow?: string; decisionId?: string; versions?: ApprovalResourceVersions }
					| undefined;
				if (data?.workflow === state.id) {
					if (!data.decisionId || data.versions?.version !== 1)
						throw new Error("Unsupported approved resource versions; submit a new work proposal");
					this.approvalVersions.set(data.decisionId, structuredClone(data.versions));
				}
			}
			if (entry.type !== "custom" || entry.customType !== "relay.work.event") continue;
			const data = entry.data as { version?: number; event?: DelegationEvent } | undefined;
			if (data?.event?.workflowId !== state.id) continue;
			if (data.version !== 1) throw new Error("Unsupported delegation event version; start a new delegation task");
			events.push(data.event);
		}
		const store = new DelegationStore(
			state.id,
			(event) => {
				if (this.getState() !== state) throw new Error("The principal delegation task changed");
				this.relay.appendEntry("relay.work.event", { version: 1, event });
			},
			events,
		);
		this.owner = state;
		this.store = store;
		this.resourceVersions.clear();
		for (const event of events) {
			if (event.type !== "instructions") continue;
			const run = store.snapshot().runs.find((run) => run.key === event.key);
			if (run) this.resourceVersions.set(run.workerId, event.instructions);
		}
		store.subscribe((snapshot) => {
			if (this.getState() !== state) return;
			state.delegation = snapshot;
			this.save();
		});
		state.delegation = store.snapshot();
		return store;
	}

	private captureApprovalVersions(
		ctx: ExtensionContext,
		plan?: ApprovedWorkPlan,
		resources = this.resources(ctx),
	): ApprovalResourceVersions {
		const { catalog, profiles, skills, toolDefinitions } = resources;
		return {
			version: 1,
			limits: resolveDelegationLimits(catalog.limits),
			profiles: profiles
				.filter((profile) => !plan || plan.selections.some((selection) => selection.profile === profile.name))
				.map((profile) => ({
					name: profile.name,
					path: profile.path,
					digest: createHash("sha256").update(profile.content).digest("hex"),
				})),
			skills: skills
				.filter(
					(skill) =>
						catalog.skills.includes(skill.name) &&
						catalog.allowedSkills.includes(skill.name) &&
						(!plan || plan.selections.some((selection) => selection.skills.includes(skill.name))),
				)
				.map((skill) => ({
					name: skill.name,
					path: skill.filePath,
					description: skill.description,
					digest: createHash("sha256")
						.update(`Base directory: ${skill.baseDir}\n${readFileSync(skill.filePath, "utf8")}`)
						.digest("hex"),
				})),
			tools: toolDefinitions
				.filter(
					(tool) =>
						catalog.tools.includes(tool.name) &&
						catalog.allowedTools.includes(tool.name) &&
						(!plan || plan.selections.some((selection) => selection.tools.includes(tool.name))),
				)
				.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: structuredClone(tool.parameters),
					digest: createHash("sha256")
						.update(JSON.stringify([tool.name, tool.description, tool.parameters]))
						.digest("hex"),
				})),
		};
	}

	private selectedApprovalVersions(
		versions: ApprovalResourceVersions,
		plan: ApprovedWorkPlan,
	): ApprovalResourceVersions {
		return {
			...versions,
			profiles: versions.profiles.filter((profile) =>
				plan.selections.some((selection) => selection.profile === profile.name),
			),
			skills: versions.skills.filter((skill) =>
				plan.selections.some((selection) => selection.skills.includes(skill.name)),
			),
			tools: versions.tools.filter((tool) =>
				plan.selections.some((selection) => selection.tools.includes(tool.name)),
			),
		};
	}

	private approvalDigest(versions: ApprovalResourceVersions): string {
		return createHash("sha256")
			.update(
				JSON.stringify([
					versions.limits,
					versions.profiles
						.map((resource) => JSON.stringify([resource.name, resource.path, resource.digest]))
						.sort(),
					versions.skills
						.map((resource) =>
							JSON.stringify([resource.name, resource.path, resource.description, resource.digest]),
						)
						.sort(),
					versions.tools.map((tool) => JSON.stringify([tool.name, tool.digest])).sort(),
				]),
			)
			.digest("hex");
	}

	private checkApprovalVersions(ctx: ExtensionContext, plan: ApprovedWorkPlan): ApprovalResourceVersions {
		try {
			if (!isSameLayaCheckpoint(plan.checkpoint, delegationCheckpoint()))
				throw new Error("The approved Laya checkpoint changed or is missing; submit a new work proposal");
			const expected = this.approvalVersions.get(plan.decisionId);
			if (!expected) throw new Error("The approved resource versions are missing; submit a new work proposal");
			if (this.approvalDigest(expected) !== this.approvalDigest(this.captureApprovalVersions(ctx, plan)))
				throw new Error("Resources changed since Laya approval; submit a new work proposal");
			return expected;
		} catch (error) {
			this.invalidate("The resources bound to the Laya approval changed or became unavailable");
			throw error;
		}
	}

	private checkLoadedVersions(
		ctx: ExtensionContext,
		plan: ApprovedWorkPlan,
		selection: WorkerSelection,
		instructions: WorkerInstructions,
	): void {
		const expected = this.checkApprovalVersions(ctx, plan);
		const resources = [
			...expected.profiles.filter((profile) => profile.name === selection.profile),
			...expected.skills.filter((skill) => selection.skills.includes(skill.name)),
		];
		const tools = expected.tools.filter((tool) => selection.tools.includes(tool.name));
		if (
			resources.length !== instructions.resources.length ||
			tools.length !== instructions.tools.length ||
			resources.some(
				(resource) =>
					!instructions.resources.some(
						(loaded) =>
							loaded.name === resource.name &&
							loaded.path === resource.path &&
							loaded.digest === resource.digest,
					),
			) ||
			tools.some(
				(tool) => !instructions.tools.some((loaded) => loaded.name === tool.name && loaded.digest === tool.digest),
			)
		) {
			this.invalidate("Loaded worker instructions differ from the Laya-approved resources");
			throw new Error("Worker instructions do not match the approved resource versions");
		}
	}

	private record(payload: EventPayload): void {
		if (!this.store || !this.owner) throw new Error("Delegation is not initialized");
		this.store.record({
			...payload,
			id: randomUUID(),
			workflowId: this.owner.id,
			timestamp: new Date().toISOString(),
		});
	}

	restore(ctx: ExtensionContext): void {
		this.scheduler?.cancel();
		this.store = undefined;
		this.owner = undefined;
		const state = this.getState();
		if (!state) return;
		const store = this.ensure(ctx);
		store.recover((run) => ({
			type: "run",
			run,
			id: randomUUID(),
			workflowId: state.id,
			timestamp: new Date().toISOString(),
		}));
		for (const run of store.snapshot().runs) {
			if (
				run.status === "completed" &&
				run.result?.accepted &&
				!run.result.stale &&
				run.planVersion === store.snapshot().plan?.proposal.version
			)
				this.record({
					type: "review",
					key: run.key,
					accepted: false,
					reason: "Recovered result requires coordinator revalidation against the workspace",
				});
		}
	}

	invalidate(reason: string): void {
		this.scheduler?.cancel();
		if (this.store && this.owner === this.getState()) this.record({ type: "invalidate", reason });
	}

	stop(reason: string): void {
		this.scheduler?.cancel();
		if (this.store && this.owner === this.getState() && !this.store.snapshot().cancelled)
			this.record({ type: "cancel", reason });
	}

	async suspend(): Promise<void> {
		this.scheduler?.cancel();
		await this.execution;
		for (const lease of this.principalLeases.values()) lease.release();
		this.principalLeases.clear();
		this.principalCalls.clear();
		this.revisions.clear();
	}

	beforeCall(ctx: ExtensionContext, name: string, args: unknown, callId: string, parentCallId?: string): void {
		if (this.getState()?.status === "active" && this.store?.snapshot().plan) this.currentLimits();
		const run = this.currentWorker;
		if (run) {
			const state = this.getState();
			const plan = this.store?.snapshot().plan;
			if (
				!state ||
				state.status !== "active" ||
				!plan ||
				plan.proposal.version !== run.planVersion ||
				state.id !== run.workflowId
			)
				throw new Error("Worker plan is obsolete");
			this.checkApprovalVersions(ctx, plan);
			this.checkResourceVersions(ctx, run);
			validateApprovedWorkPlan(plan, this.resources(ctx).catalog);
			const selection = plan.selections.find((selection) => selection.taskId === run.taskId);
			const task = plan.proposal.tasks.find((task) => task.taskId === run.taskId);
			if (!task || !selection?.tools.includes(name) || WORKER_CONTROL_TOOLS.includes(name))
				throw new Error("Tool is outside this worker's selected resources");
			const sessionFile = ctx.sessionManager.getSessionFile();
			checkWorkerScope(ctx.cwd, task, name, args, [
				...(state.workspace?.controlFiles ?? []),
				...(sessionFile ? [sessionFile] : []),
			]);
		} else if (!WORKER_CONTROL_TOOLS.includes(name)) {
			const exclusive = !["read", "grep", "find", "ls"].includes(name);
			const ancestor = parentCallId && this.principalCalls.get(parentCallId);
			const lease = ancestor ? this.principalLeases.get(ancestor) : undefined;
			if (ancestor && lease) {
				if (!this.leases.borrow(ancestor, exclusive))
					throw new Error("Nested mutation conflicts with active workspace readers");
				lease.calls.add(callId);
				this.principalCalls.set(callId, ancestor);
				return;
			}
			const release = this.leases.acquire(callId, exclusive);
			if (!release)
				throw new Error("Workspace is leased by active workers; integrate their results before modifying it");
			this.principalLeases.set(callId, { release, calls: new Set([callId]) });
			this.principalCalls.set(callId, callId);
		}
	}

	private checkResourceVersions(ctx: ExtensionContext, run: WorkerRun): void {
		try {
			this.assertResourceVersions(ctx, run);
		} catch (error) {
			this.invalidate("Worker profile, skill or tool instructions changed or became unavailable");
			throw error;
		}
	}

	private assertResourceVersions(ctx: ExtensionContext, run: WorkerRun): void {
		const expected = this.resourceVersions.get(run.workerId);
		if (!expected) throw new Error("Worker instruction versions are unavailable");
		const profile = AGENT_IDS.filter((id) => expected.resources.some((resource) => resource.name === id)).flatMap(
			(id) => {
				const profile = loadStructuredAgentProfile(id, ctx);
				return profile ? [profile] : [];
			},
		);
		const resources = [
			...profile,
			...this.getSkills()
				.filter((skill) => expected.resources.some((resource) => resource.name === skill.name))
				.map((skill) => ({
					name: skill.name,
					path: skill.filePath,
					content: `Base directory: ${skill.baseDir}\n${readFileSync(skill.filePath, "utf8")}`,
				})),
		];
		const changed =
			expected.resources.some(
				(old) =>
					!resources.some(
						(current) =>
							current.name === old.name &&
							current.path === old.path &&
							createHash("sha256").update(current.content).digest("hex") === old.digest,
					),
			) ||
			expected.tools.some(
				(old) =>
					!this.relay.getAllTools().some(
						(tool) =>
							tool.name === old.name &&
							createHash("sha256")
								.update(JSON.stringify([tool.name, tool.description, tool.parameters]))
								.digest("hex") === old.digest,
					),
			);
		if (changed) {
			throw new Error("Worker resources changed; submit a new proposal for Laya evaluation");
		}
	}

	recordCall(callId: string, revision: number): void {
		if (this.currentWorker) this.revisions.set(callId, revision);
	}

	endCall(callId: string): void {
		const owner = this.principalCalls.get(callId);
		this.principalCalls.delete(callId);
		if (!owner) return;
		const lease = this.principalLeases.get(owner);
		lease?.calls.delete(callId);
		if (lease && !lease.calls.size) {
			lease.release();
			this.principalLeases.delete(owner);
		}
	}

	private registerTools(): void {
		this.relay.registerTool({
			name: "propose_work",
			label: "Propose delegated work",
			exposure: this.enabled ? "model-only" : "hidden",
			executionMode: "sequential",
			description:
				"Propose bounded tasks for the authorized request. Laya evaluates delegation and resources; this operation never starts workers. Changed work requires a new proposal.",
			parameters: Type.Object({
				tasks: Type.Array(workTaskSchema, { minItems: 1, maxItems: DELEGATION_LIMIT_CAPS.maxTasks }),
			}),
			execute: async (_id, params, signal, _onUpdate, ctx) => {
				if (!this.enabled)
					throw new Error("Automatic delegation awaits validation of the relay-laya-v5 checkpoint");
				const state = this.getState();
				if (!state || state.status !== "active") throw new Error("No active delegation task");
				const store = this.ensure(ctx);
				const resources = this.resources(ctx);
				const { catalog } = resources;
				const proposal = validateWorkProposal(
					{
						workflowId: state.id,
						version: (store.snapshot().proposal?.version ?? 0) + 1,
						workspaceRevision: state.revision,
						tasks: params.tasks,
					},
					catalog,
				);
				this.record({ type: "proposal", proposal });
				try {
					const availableVersions = this.captureApprovalVersions(ctx, undefined, resources);
					const decision = await decideWork(this.relay, ctx, state.goal, proposal, catalog, signal);
					if (
						this.getState() !== state ||
						state.revision !== proposal.workspaceRevision ||
						state.status !== "active"
					)
						throw new Error("Task changed while Laya evaluated the proposal");
					if (decision.kind === "delegated") {
						const versions = this.selectedApprovalVersions(availableVersions, decision.plan);
						if (
							this.approvalDigest(versions) !==
							this.approvalDigest(this.captureApprovalVersions(ctx, decision.plan))
						) {
							this.invalidate("Selected resources changed while Laya evaluated the proposal");
							return {
								content: [
									{
										type: "text",
										text: "Resources changed during Laya evaluation. Reconsider resources and submit a new proposal before executing work.",
									},
								],
								details: {},
								isError: true,
							};
						}
						validateApprovedWorkPlan(decision.plan, this.resources(ctx).catalog);
						this.relay.appendEntry("relay.work.resources", {
							workflow: state.id,
							decisionId: decision.decisionId,
							versions,
						});
						this.approvalVersions.set(decision.decisionId, structuredClone(versions));
						this.record({ type: "approved", plan: decision.plan });
					} else this.record({ type: "decision", kind: decision.kind, decisionId: decision.decisionId });
					return { content: [{ type: "text", text: JSON.stringify(decision) }], details: {} };
				} catch (error) {
					if (this.getState() === state) {
						state.status = "handoff";
						state.decisionError = error instanceof Error ? error.message : String(error);
						this.save();
					}
					throw error;
				}
			},
		});
		this.relay.registerTool({
			name: "execute_work",
			label: "Execute delegated work",
			exposure: this.enabled ? "model-only" : "hidden",
			executionMode: "sequential",
			description:
				"Execute only task IDs from the current Laya-approved proposal. Returns worker reports and observed evidence. Review and accept each result with review_work before dependent tasks or completion.",
			parameters: Type.Object({
				taskIds: Type.Array(Type.String(), {
					minItems: 1,
					maxItems: DELEGATION_LIMIT_CAPS.maxTasks,
					uniqueItems: true,
				}),
			}),
			execute: async (_id, params, signal, _onUpdate, ctx) => {
				if (!this.enabled) throw new Error("Delegation checkpoint validation is pending");
				if (this.execution) throw new Error("A worker batch is already executing");
				const state = this.getState();
				const store = this.ensure(ctx);
				const plan = store.snapshot().plan;
				if (!state || state.status !== "active" || !plan || !ctx.model)
					throw new Error("No current approved worker plan");
				this.checkApprovalVersions(ctx, plan);
				validateApprovedWorkPlan(plan, this.resources(ctx).catalog);
				const assistant = ctx.sessionManager
					.getBranch()
					.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
				const physical =
					assistant?.type === "message" && assistant.message.role === "assistant"
						? ctx.modelRegistry.find(assistant.message.provider, assistant.message.model)
						: undefined;
				const model = isVirtualModel(ctx.model) ? physical : ctx.model;
				if (!model || isVirtualModel(model))
					throw new Error(
						"The principal's physical model is unavailable; worker execution cannot select a substitute",
					);
				const previousRuns = new Set(store.snapshot().runs.map((run) => run.key));
				this.scheduler = new DelegationScheduler(store, this.leases, (task, selection, run, workerSignal) =>
					this.worker.run(run, async () => {
						this.checkApprovalVersions(ctx, plan);
						const { catalog, profiles } = this.resources(ctx);
						const profile = profiles.find((profile) => profile.name === selection.profile);
						if (!profile || !ctx.model) throw new Error("Selected worker profile or model is unavailable");
						const context: WorkerContext = {
							identity: {
								workflowId: run.workflowId,
								planVersion: run.planVersion,
								taskId: run.taskId,
								attempt: run.attempt,
								workerId: run.workerId,
							},
							goal: state.goal,
							task,
							selection,
							profile: { name: profile.name, path: profile.path, content: profile.content },
							decisions: [],
							dependencies: task.dependencies.flatMap((id) => {
								const result = store
									.snapshot()
									.runs.findLast(
										(run) => run.taskId === id && run.planVersion === plan.proposal.version,
									)?.result;
								return result ? [result] : [];
							}),
							skills: selection.skills.map((name) => {
								const skill = this.getSkills().find((skill) => skill.name === name);
								if (!skill) throw new Error(`Selected skill unavailable: ${name}`);
								return {
									name,
									path: skill.filePath,
									content: `Base directory: ${skill.baseDir}\n${readFileSync(skill.filePath, "utf8")}`,
								};
							}),
							repositoryInstructions: [{ path: "principal-system-prompt", content: ctx.getSystemPrompt() }],
						};
						return runWorker({
							cwd: ctx.cwd,
							model,
							modelRuntime: ctx.modelRegistry.modelRuntime,
							parent: ctx,
							plan,
							catalog,
							context,
							signal: workerSignal,
							getWorkspaceRevision: () => state.revision,
							getToolRevision: (id) => this.revisions.get(id),
							checkCall: (name, args) => this.beforeCall(ctx, name, args, run.workerId),
							onStarted: (instructions) => {
								this.checkLoadedVersions(ctx, plan, selection, instructions);
								this.record({ type: "instructions", key: run.key, instructions });
								this.resourceVersions.set(run.workerId, instructions);
							},
							onFinished: (metrics) => this.record({ type: "metrics", key: run.key, metrics }),
							onEvidence: (evidence, fullText) => {
								const contentId = randomUUID();
								if (evidence.text !== fullText) {
									evidence.contentRef = `session:relay.work.content:${contentId}`;
									this.relay.appendEntry("relay.work.content", {
										id: contentId,
										workflow: state.id,
										workerId: run.workerId,
										text: fullText,
									});
								}
								this.record({ type: "evidence", evidence });
								this.revisions.delete(evidence.toolCallId);
								state.evidence.push({
									id: evidence.id,
									tool: evidence.tool,
									command: evidence.command,
									isError: evidence.isError,
									text: evidence.text,
									revision: evidence.workspaceRevision,

									delegation: {
										workflowId: run.workflowId,
										planVersion: run.planVersion,
										taskId: run.taskId,
										attempt: run.attempt,
										workerId: run.workerId,
									},
									contentRef: evidence.contentRef,
								});
								state.evidence = state.evidence.slice(-100);
								this.save();
							},
						});
					}),
				);
				const execution = this.scheduler.run(params.taskIds, signal);
				this.execution = execution;
				let report: WorkExecutionReport;
				try {
					report = await execution;
				} finally {
					if (this.execution === execution) this.execution = undefined;
				}
				this.relay.sendMessage({
					customType: "relay.work.progress",
					content: report.runs
						.map(
							(run) =>
								`${run.taskId}: ${run.status}; profile ${run.resources?.profile ?? "unavailable"}; worker ${run.workerId}; attempt ${run.attempt}; context ${run.contextDigest ?? "not started"}`,
						)
						.join("\n"),
					display: true,
				});
				let usage: Usage | undefined;
				for (const run of report.runs) {
					if (previousRuns.has(run.key) || !run.metrics) continue;
					usage = usage ? combineUsage(usage, run.metrics.usage) : run.metrics.usage;
				}
				// The principal's nested-call recorder already adds tool usage; include only worker models here.
				return { content: [{ type: "text", text: JSON.stringify(report) }], details: {}, usage };
			},
		});
		this.relay.registerTool({
			name: "review_work",
			label: "Review delegated work",
			exposure: this.enabled ? "model-only" : "hidden",
			executionMode: "sequential",
			description:
				"Coordinator review of an observed worker result against its acceptance criteria. Reconcile unsuccessful attempts only after inspecting their effects. Tool arguments never record user approval.",
			parameters: Type.Object({
				taskId: Type.String(),
				accepted: Type.Boolean(),
				reason: Type.String({ minLength: 1 }),
				reconcile: Type.Optional(Type.Boolean()),
				evidenceIds: Type.Optional(Type.Array(Type.String())),
			}),
			execute: async (_id, params, _signal, _onUpdate, ctx) => {
				const state = this.getState();
				const store = this.ensure(ctx);
				const plan = store.snapshot().plan;
				const run = store
					.snapshot()
					.runs.findLast((run) => run.taskId === params.taskId && run.planVersion === plan?.proposal.version);
				if (!state || state.status !== "active" || !run) throw new Error("No worker attempt from the current plan");
				if (params.reconcile) {
					if (
						!params.evidenceIds?.some((id) =>
							state.evidence.some(
								(item) =>
									item.id === id &&
									!item.isError &&
									["read", "grep", "find", "ls"].includes(item.tool) &&
									!item.delegation &&
									item.revision === state.revision &&
									item.observedAt !== undefined &&
									item.observedAt >= Date.parse(run.finishedAt ?? ""),
							),
						)
					)
						throw new Error("Inspect interrupted effects with principal file tools before reconciliation");
					this.record({ type: "reconciled", key: run.key, reason: params.reason });
				} else {
					if (!plan) throw new Error("The worker plan is unavailable");
					this.checkApprovalVersions(ctx, plan);
					this.checkResourceVersions(ctx, run);
					validateApprovedWorkPlan(plan, this.resources(ctx).catalog);
					this.record({ type: "review", key: run.key, accepted: params.accepted, reason: params.reason });
				}
				return {
					content: [
						{ type: "text", text: JSON.stringify(store.snapshot().runs.find((item) => item.key === run.key)) },
					],
					details: {},
				};
			},
		});
	}
}
