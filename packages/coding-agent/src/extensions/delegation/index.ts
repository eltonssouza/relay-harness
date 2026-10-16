import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { WORKER_CONTROL_TOOLS } from "../../core/delegation/contracts.ts";
import { isTestCommand } from "../../core/delegation/test-command.ts";
import { WorkspaceTracker } from "../../core/delegation/workspace.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import type { Skill } from "../../core/skills.ts";
import { DELEGATION_VALIDATED, WorkDelegation } from "./service.ts";
import { WORK_STATE_ENTRY, type WorkState } from "./state.ts";

export interface DelegationExtensionOptions {
	/** Explicit activation for offline integration tests and candidate evaluation. */
	enabled?: boolean;
}

export function createDelegationExtension(options: DelegationExtensionOptions = {}): ExtensionFactory {
	return (relay: ExtensionAPI): void => {
		const enabled = options.enabled ?? DELEGATION_VALIDATED;
		let state: WorkState | undefined;
		let prompt = "";
		let skills: Skill[] = [];
		let workspace: WorkspaceTracker | undefined;
		const calls = new Map<string, { revision: number; mutation: boolean; validation: boolean }>();
		const mutations = new Set<string>();
		const save = () => {
			if (state) relay.appendEntry(WORK_STATE_ENTRY, structuredClone(state));
		};
		const delegation = new WorkDelegation(
			relay,
			() => state,
			() => skills,
			save,
			enabled,
		);
		const inspect = (rehash = false, authorizedMutation = false): void => {
			if (!state || !workspace || mutations.size) return;
			const change = workspace.inspect(rehash);
			state.workspace = workspace.baseline();
			if (!change) return;
			state.revision++;
			if (!authorizedMutation) {
				delegation.invalidate("Workspace changed outside the current authorized operation");
				state.status = "handoff";
				state.decisionError = "Workspace changed. Inspect its effects and submit a new proposal.";
			}
			save();
		};
		const restore = async (ctx: ExtensionContext): Promise<void> => {
			await delegation.suspend();
			calls.clear();
			mutations.clear();
			workspace = undefined;
			state = undefined;
			const entry = ctx.sessionManager
				.getBranch()
				.findLast((item) => item.type === "custom" && item.customType === WORK_STATE_ENTRY);
			if (entry?.type !== "custom") return;
			const saved = entry.data as WorkState | undefined;
			if (!saved || saved.version !== 1) return;
			state = structuredClone(saved);
			if (!enabled || state.status === "completed" || state.status === "stopped") return;
			try {
				if (!state.workspace) throw new Error("Delegation workspace reference is missing; submit a new proposal");
				const sessionFile = ctx.sessionManager.getSessionFile();
				workspace = new WorkspaceTracker(ctx.cwd, state.workspace, sessionFile ? [sessionFile] : []);
				delegation.restore(ctx);
				inspect(true);
			} catch (error) {
				state.status = "handoff";
				state.decisionError = error instanceof Error ? error.message : String(error);
				save();
			}
		};
		relay.on("session_start", (_event, ctx) => restore(ctx));
		relay.on("session_tree", (_event, ctx) => restore(ctx));
		relay.on("session_shutdown", () => delegation.suspend());
		relay.on("before_agent_start", (event) => {
			if (state?.status === "completed" || state?.status === "stopped") {
				state = undefined;
				workspace = undefined;
			}
			prompt = event.prompt;
			skills = event.systemPromptOptions.skills;
			if (!enabled) return;
			return {
				message: {
					customType: "relay.work.guidance",
					content:
						"For useful independent work, propose bounded tasks with propose_work. Laya selects delegation and resources; execute_work starts only approved task IDs. Review observed results with review_work before dependencies. Complete a delegated plan with complete_work after final validation. Small tasks execute directly. There are no mandatory phases or task specification files. Never infer user approval from a worker report.",
					display: false,
				},
			};
		});
		relay.on("tool_call", (event, ctx) => {
			if (!enabled) return;
			if (event.toolName === "propose_work" && !delegation.currentWorker) {
				if (!state || state.status === "completed" || state.status === "stopped") {
					state = {
						version: 1,
						id: randomUUID(),
						goal: prompt,
						status: "active",
						revision: 0,
						evidence: [],
						continuations: 0,
					};
				}
				state.status = "active";
				state.decisionError = undefined;
				const sessionFile = ctx.sessionManager.getSessionFile();
				workspace = new WorkspaceTracker(ctx.cwd, state.workspace, sessionFile ? [sessionFile] : []);
				// A fresh decision must use the current workspace, including changes made during a handoff.
				if (workspace.inspect(true)) {
					state.revision++;
					delegation.invalidate("Workspace changed before the new proposal");
				}
				state.workspace = workspace.baseline();
				save();
			}
			if (!state || state.status === "stopped") return;
			try {
				if (event.toolName !== "propose_work") inspect(event.toolName === "complete_work");
				if (state.status === "handoff" && !["read", "grep", "find", "ls", "propose_work"].includes(event.toolName))
					throw new Error(state.decisionError ?? "Resume or stop delegation before continuing");
				if (event.toolName === "update_goal" && event.input.status === "complete" && state.status !== "completed")
					throw new Error("Complete or explicitly stop the delegated plan before completing the goal");
				delegation.beforeCall(ctx, event.toolName, event.input, event.toolCallId, event.parentToolCallId);
				if (WORKER_CONTROL_TOOLS.includes(event.toolName)) return;
				if (
					"path" in event.input &&
					typeof event.input.path === "string" &&
					["read", "write", "edit"].includes(event.toolName)
				) {
					if (workspace?.observe(event.input.path)) {
						state.revision++;
					}
					state.workspace = workspace?.baseline();
				}
				const validation =
					["bash", "powershell"].includes(event.toolName) &&
					"command" in event.input &&
					typeof event.input.command === "string" &&
					isTestCommand(event.input.command, event.toolName === "powershell" ? "powershell" : "bash");
				const mutation = !validation && !["read", "grep", "find", "ls"].includes(event.toolName);
				if (mutation) {
					state.revision++;
					state.status = "active";
					mutations.add(event.toolCallId);
				}
				calls.set(event.toolCallId, { revision: state.revision, mutation, validation });
				delegation.recordCall(event.toolCallId, state.revision);
				save();
			} catch (error) {
				delegation.endCall(event.toolCallId);
				return { block: true, reason: error instanceof Error ? error.message : String(error) };
			}
		});
		relay.on("tool_result", (event) => {
			const started = calls.get(event.toolCallId);
			mutations.delete(event.toolCallId);
			delegation.endCall(event.toolCallId);
			calls.delete(event.toolCallId);
			if (!state || !started) return;
			inspect(started.validation, started.mutation && !started.validation);
			if (delegation.currentWorker) return;
			state.evidence.push({
				id: event.toolCallId,
				tool: event.toolName,
				command: typeof event.input.command === "string" ? event.input.command : undefined,
				isError: event.isError,
				text: event.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n")
					.slice(-4000),
				revision: started.revision,
				observedAt: Date.now(),
			});
			state.evidence = state.evidence.slice(-100);
			save();
		});
		relay.on("tool_execution_end", (event) => {
			mutations.delete(event.toolCallId);
			calls.delete(event.toolCallId);
			delegation.endCall(event.toolCallId);
		});
		relay.registerTool({
			name: "complete_work",
			label: "Complete delegated work",
			exposure: enabled ? "model-only" : "hidden",
			executionMode: "sequential",
			description:
				"Complete the current delegated plan after reviewing every selected result. Mutations require observed successful test evidence from the final workspace revision. This records coordinator completion, never user approval.",
			parameters: Type.Object({ summary: Type.String({ minLength: 1 }), evidenceIds: Type.Array(Type.String()) }),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				if (!enabled || state?.status !== "active") throw new Error("No active delegated plan");
				if (!params.summary.trim()) throw new Error("Provide a completion summary");
				inspect(true);
				if (state.status !== "active") throw new Error(state.decisionError);
				delegation.assertReady(ctx);
				const proofs = params.evidenceIds.map((id) => state?.evidence.find((item) => item.id === id));
				if (proofs.some((item) => !item)) throw new Error("Evidence IDs must identify observed calls");
				const plan = state.delegation?.plan;
				if (!plan && state.delegation?.decision?.kind !== "direct") throw new Error("No completed work decision");
				if (
					plan?.selections.some(
						(selection) =>
							plan.proposal.tasks.find((task) => task.taskId === selection.taskId)?.accessMode !==
							"investigation",
					) &&
					!proofs.some(
						(item) =>
							item &&
							!item.isError &&
							item.revision === state?.revision &&
							["bash", "powershell"].includes(item.tool) &&
							isTestCommand(item.command ?? "", item.tool === "powershell" ? "powershell" : "bash") &&
							(!item.delegation ||
								state?.delegation?.runs.some(
									(run) =>
										run.workerId === item.delegation?.workerId && run.result?.accepted && !run.result.stale,
								)),
					)
				)
					throw new Error("Final successful test evidence is required after the latest mutation");
				state.status = "completed";
				save();
				return {
					content: [{ type: "text", text: params.summary }],
					details: { id: state.id, status: state.status },
				};
			},
		});
		relay.on("agent_before_settle", (event) => {
			if (!enabled || !state || state.status !== "active" || event.outcome !== "completed") return;
			inspect(true);
			if (state.status !== "active") return;
			if (++state.continuations >= 3) {
				state.status = "handoff";
				state.decisionError = "Delegated plan remains incomplete. Inspect /work and resume after reconciliation.";
				save();
				return;
			}
			save();
			return {
				entries: [
					...event.entries,
					{
						type: "custom_message",
						customType: "relay.work.continue",
						content:
							"The delegated plan is incomplete. Review observed results, execute eligible tasks and complete_work with final evidence. Do not claim completion while required work is pending.",
						display: false,
					},
				],
				continue: true,
			};
		});
		relay.registerCommand("work", {
			description: "Inspect, resume or stop the current delegated plan",
			async handler(args, ctx) {
				if (!state) {
					ctx.ui.notify("No delegated plan.");
					return;
				}
				if (args.trim() === "stop") {
					delegation.stop("User stopped delegated work");
					await delegation.suspend();
					state.status = "stopped";
					save();
				} else if (args.trim() === "resume" && enabled && state.status === "handoff") {
					state.status = "active";
					state.continuations = 0;
					save();
					relay.sendUserMessage(
						"Resume the delegated plan. Inspect interrupted effects; submit a new proposal when approvals are missing or obsolete.",
						ctx.isIdle() ? undefined : { deliverAs: "followUp" },
					);
				}
				ctx.ui.notify(JSON.stringify(state));
			},
		});
	};
}

export default createDelegationExtension();
