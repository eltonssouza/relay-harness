import { getCurrentSystemMessage } from "@relay-harness/ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { formatGoal, GOAL_ENTRY, type Goal, goalInstructions, newGoal, readGoal } from "./state.ts";

export default function goalExtension(relay: ExtensionAPI): void {
	let stopBeforeTools = false;
	function save(goal: Goal | undefined, ctx: ExtensionContext): void {
		relay.appendEntry(GOAL_ENTRY, goal ?? null);
		ctx.ui.setStatus(
			"goal",
			goal
				? `goal: ${goal.status} | ${goal.tokensUsed}${goal.tokenBudget === undefined ? "" : `/${goal.tokenBudget}`} tokens`
				: undefined,
		);
	}

	function activateTools(): void {
		relay.setActiveTools([...new Set([...relay.getActiveTools(), "get_goal", "update_goal"])]);
		if (!relay.getActiveTools().includes("update_goal"))
			throw new Error("Goals require the update_goal tool. Enable it before starting or resuming a goal.");
	}

	function create(objective: string, tokenBudget: number | undefined, ctx: ExtensionContext): Goal {
		const current = readGoal(ctx.sessionManager);
		if (current && current.status !== "complete")
			throw new Error("An unfinished goal exists. Use /goal clear before replacing it.");
		const goal = newGoal(objective, tokenBudget);
		activateTools();
		save(goal, ctx);
		return goal;
	}

	relay.registerTool({
		name: "create_goal",
		label: "Create goal",
		description:
			"Create a persistent goal for this conversation ONLY when explicitly requested by the user. Include verification, constraints, and scope in the objective. Set token_budget only if requested. Unfinished goals cannot be replaced.",
		parameters: Type.Object({
			objective: Type.String({ minLength: 1 }),
			token_budget: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
		exposure: "deferred",
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const goal = create(params.objective, params.token_budget, ctx);
			return { content: [{ type: "text", text: formatGoal(goal) }], details: goal };
		},
	});
	relay.registerTool({
		name: "get_goal",
		label: "Get goal",
		description: "Read this conversation's goal, status, token usage, budget, and progress report.",
		parameters: Type.Object({}),
		exposure: "deferred",
		executionMode: "sequential",
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const goal = readGoal(ctx.sessionManager);
			return { content: [{ type: "text", text: formatGoal(goal) }], details: goal ?? null };
		},
	});
	relay.registerTool({
		name: "update_goal",
		label: "Update goal",
		description:
			"Record progress (active), verified completion (complete), or a blocker requiring user input (blocked). A report is required: evidence for completion, attempts/blocker/needed input for blocking. Cannot pause, resume, change budget, or update an inactive goal.",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("active"), Type.Literal("complete"), Type.Literal("blocked")]),
			report: Type.String({ minLength: 1 }),
		}),
		exposure: "deferred",
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const current = readGoal(ctx.sessionManager);
			if (!current || current.status !== "active") throw new Error("No active goal to update.");
			if (!params.report.trim()) throw new Error("Provide a non-empty evidence or progress report.");
			const goal: Goal = { ...current, status: params.status, report: params.report.trim() };
			save(goal, ctx);
			if (goal.status !== "active") ctx.ui.notify(formatGoal(goal));
			return { content: [{ type: "text", text: formatGoal(goal) }], details: goal };
		},
	});

	relay.registerCommand("goal", {
		description: "Create, inspect, pause, resume, or clear this conversation's persistent goal",
		getArgumentCompletions: (prefix) =>
			["pause", "resume", "clear", "--tokens"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			try {
				const action = args.trim();
				if (action === "clear") {
					save(undefined, ctx);
					if (!ctx.isIdle()) {
						stopBeforeTools = true;
						ctx.abort();
					}
					ctx.ui.notify("Goal cleared.");
					return;
				}
				const current = readGoal(ctx.sessionManager);
				if (!action) {
					ctx.ui.notify(formatGoal(current));
					return;
				}
				if (action === "pause" || action === "resume") {
					if (!current) throw new Error("No goal to control.");
					if (current.status === "complete") throw new Error("This goal is complete. Create a new goal.");
					if (current.status === "budget_exhausted")
						throw new Error("Token budget exhausted. Clear the goal and create a new one with a new budget.");
					if (action === "resume" && current.status === "active") {
						ctx.ui.notify(formatGoal(current));
						return;
					}
					const goal: Goal = { ...current, status: action === "pause" ? "paused" : "active" };
					if (action === "resume") activateTools();
					save(goal, ctx);
					if (action === "pause") {
						if (!ctx.isIdle()) {
							stopBeforeTools = true;
							ctx.abort();
						}
					} else {
						relay.sendUserMessage(
							`Resume the goal: ${goal.objective}`,
							ctx.isIdle() ? undefined : { deliverAs: "followUp" },
						);
					}
					ctx.ui.notify(formatGoal(goal));
					return;
				}
				const match = /^--tokens\s+(\S+)\s+([\s\S]+)$/.exec(action);
				if (action.startsWith("--") && !match)
					throw new Error("Usage: /goal [--tokens <positive integer>] <objective>");
				const goal = create(match ? match[2] : action, match ? Number(match[1]) : undefined, ctx);
				ctx.ui.notify(formatGoal(goal));
				relay.sendUserMessage(
					`Work toward this goal: ${goal.objective}`,
					ctx.isIdle() ? undefined : { deliverAs: "followUp" },
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	function restore(ctx: ExtensionContext): void {
		stopBeforeTools = false;
		const goal = readGoal(ctx.sessionManager);
		ctx.ui.setStatus("goal", goal ? `goal: ${goal.status} | ${goal.tokensUsed} tokens` : undefined);
		if (goal?.status === "active") {
			try {
				activateTools();
			} catch (error) {
				save({ ...goal, status: "paused", report: error instanceof Error ? error.message : String(error) }, ctx);
			}
		}
	}
	relay.on("session_start", (_event, ctx) => restore(ctx));
	relay.on("session_tree", (_event, ctx) => restore(ctx));
	relay.on("context_with_system", (event, ctx) => {
		const goal = readGoal(ctx.sessionManager);
		const section = goal
			? `<goal>\n${goal.status === "active" ? goalInstructions(goal) : `${formatGoal(goal)}\nThis goal is inactive. Do not continue it or change its status without the user's explicit request.`}\n</goal>`
			: null;
		if ((getCurrentSystemMessage(event.messages)?.sections?.goal ?? null) === section) return;
		return {
			messages: [
				...event.messages,
				{ role: "system", content: "", sections: { goal: section }, timestamp: Date.now() },
			],
		};
	});

	function recordTokens(tokens: number, ctx: ExtensionContext): void {
		const goal = readGoal(ctx.sessionManager);
		if (!goal || goal.status !== "active" || !Number.isFinite(tokens) || tokens < 0) return;
		const next = { ...goal, tokensUsed: goal.tokensUsed + tokens };
		if (next.tokenBudget !== undefined && next.tokensUsed >= next.tokenBudget) {
			stopBeforeTools = true;
			next.status = "budget_exhausted";
			next.report = "Token budget exhausted; goal completion has not been verified.";
			ctx.ui.notify(formatGoal(next), "warning");
		}
		save(next, ctx);
	}
	relay.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant" || event.message.role === "toolResult") {
			recordTokens(event.message.usage?.totalTokens ?? 0, ctx);
		}
	});
	relay.on("session_compact", (event, ctx) => recordTokens(event.compactionEntry.usage?.totalTokens ?? 0, ctx));
	relay.on("before_agent_start", () => {
		stopBeforeTools = false;
	});
	relay.on("tool_call", () =>
		stopBeforeTools ? { block: true, terminate: true, reason: "Goal execution stopped." } : undefined,
	);
	relay.on("turn_start", (_event, ctx) => {
		const goal = readGoal(ctx.sessionManager);
		if (goal?.status === "active") save({ ...goal, turns: goal.turns + 1 }, ctx);
	});
	relay.on("turn_end", (_event, ctx) => {
		// Stop at a response boundary, including responses that would otherwise call more tools.
		if (stopBeforeTools) ctx.abort();
	});
	relay.on("agent_before_settle", (event, ctx) => {
		const goal = readGoal(ctx.sessionManager);
		if (!goal || goal.status !== "active" || event.outcome !== "completed") return;
		if (!relay.getActiveTools().includes("update_goal")) {
			save(
				{
					...goal,
					status: "paused",
					report: "The update_goal tool is unavailable. Enable it and use /goal resume.",
				},
				ctx,
			);
			ctx.ui.notify("Goal paused: update_goal is unavailable.", "warning");
			return;
		}
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: "relay.goal.continue",
					content:
						"The goal is still active. Inspect the evidence and take the next valid step. Use update_goal to record verified completion or explain a blocker requiring user input.",
					display: false,
				},
			],
			continue: true,
		};
	});
	relay.on("agent_settled", (_event, ctx) => {
		const goal = readGoal(ctx.sessionManager);
		if (!goal || goal.status !== "active") return;
		const last = ctx.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (
			last?.type === "message" &&
			last.message.role === "assistant" &&
			["aborted", "error"].includes(last.message.stopReason)
		) {
			save(
				{
					...goal,
					status: "paused",
					report: last.message.errorMessage || "Execution interrupted. Use /goal resume to continue.",
				},
				ctx,
			);
			ctx.ui.notify(
				"Goal paused after an interruption or provider failure. Use /goal resume to continue.",
				"warning",
			);
		}
	});
}
