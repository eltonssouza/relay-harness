import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";

export const GOAL_ENTRY = "relay.goal";

const goalSchema = Type.Object({
	objective: Type.String({ minLength: 1 }),
	status: Type.Union([
		Type.Literal("active"),
		Type.Literal("paused"),
		Type.Literal("complete"),
		Type.Literal("blocked"),
		Type.Literal("budget_exhausted"),
	]),
	tokenBudget: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
	tokensUsed: Type.Number({ minimum: 0 }),
	turns: Type.Integer({ minimum: 0 }),
	report: Type.Optional(Type.String()),
});

export type Goal = Static<typeof goalSchema>;

/** Read the active branch, including entries outside the compacted model context. */
export function readGoal(sessionManager: ReadonlySessionManager): Goal | undefined {
	const entry = sessionManager
		.getBranch()
		.findLast((entry) => entry.type === "custom" && entry.customType === GOAL_ENTRY);
	if (!entry || entry.type !== "custom" || entry.data === null) return undefined;
	if (!Check(goalSchema, entry.data)) throw new Error("Invalid saved goal state. Use /goal clear to remove it.");
	return entry.data;
}

export function newGoal(objective: string, tokenBudget?: number): Goal {
	if (!objective.trim()) throw new Error("A goal needs a non-empty objective.");
	if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new Error("Token budget must be a positive safe integer.");
	}
	return {
		objective: objective.trim(),
		status: "active",
		tokensUsed: 0,
		turns: 0,
		...(tokenBudget === undefined ? {} : { tokenBudget }),
	};
}

export function formatGoal(goal: Goal | undefined): string {
	if (!goal) return "No goal. Usage: /goal [--tokens <budget>] <objective> | pause | resume | clear";
	return `Goal (${goal.status}): ${goal.objective}\nTokens: ${goal.tokensUsed}${goal.tokenBudget === undefined ? " (no budget)" : ` / ${goal.tokenBudget}`} | Turns: ${goal.turns}${goal.report ? `\n${goal.report}` : ""}`;
}

export function goalInstructions(goal: Goal): string {
	return `${formatGoal(goal)}
This goal belongs to this conversation. Follow the user's latest instructions while preserving its objective, verification criteria, scope, and constraints.
Continue investigating, acting, and verifying until the goal is achieved. A normal final answer does not complete a goal.
Use update_goal with status complete only after verifying every completion criterion; report the concrete evidence. Never claim success merely because effort or budget is running out.
If no valid next step remains or you need user input, use update_goal with status blocked and report attempts, evidence, the blocker, and what is needed to continue.
Only the user can pause, resume, or clear a goal. Never create or replace one without an explicit user request.
The token budget, if present, is checked after responses and may be exceeded by the last request. Report final usage on completion.`;
}
