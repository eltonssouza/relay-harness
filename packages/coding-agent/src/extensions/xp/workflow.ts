import type { DecisionObservation } from "@relay-harness/agent-core";

export const XP_PHASES = ["planning", "design", "testing", "coding", "listening"] as const;
export type XpPhase = (typeof XP_PHASES)[number];

export const XP_PHASE_GUIDANCE: Record<XpPhase, string> = {
	planning: "Define the smallest useful slice, acceptance criteria, constraints and unknowns. Use refine-backlog.",
	design:
		"Choose a simple design tied to the acceptance criteria. State boundaries, contracts and risks. Use decide-architecture or design-service as needed.",
	testing:
		"Write and run a focused test that fails for the intended behavioral assertion. Report the actual failing test call ID. Use implement-feature-tdd and automate-tests.",
	coding:
		"Implement the minimum solution, rerun the affected tests, then refactor while tests stay green. Report a successful test call ID after the latest mutation. Use implement-feature-tdd and quality-baseline.",
	listening:
		"Present the result and evidence to the user. Wait for feedback; /xp accept verifies acceptance. Incorporate changed requirements in a new planning cycle.",
};

export interface XpEvidence {
	id: string;
	tool: string;
	command?: string;
	isError: boolean;
	text: string;
	revision: number;
}

export interface XpState {
	version: 1;
	id: string;
	goal: string;
	phase: XpPhase;
	status: "active" | "handoff" | "completed" | "stopped";
	steps: number;
	refusals: number;
	/** Completed runs without a checkpoint; prevents unbounded automatic retries. */
	continuationsWithoutCheckpoint?: number;
	revision: number;
	accepted: boolean;
	testsRequired: boolean;
	evidence: XpEvidence[];
	lastDecision?: string;
	repeats?: number;
}

/** Identify test executions conservatively. A successful unrelated shell command is not test proof. */
export function isTestEvidence(evidence: XpEvidence): boolean {
	return (
		["bash", "powershell"].includes(evidence.tool) &&
		/(?:\bvitest\b|\bpytest\b|\bjest\b|\bplaywright\s+test\b|\bnode\b[^\n]*--test\b|\btest\.sh\b|\bnpm(?:\.cmd)?\s+(?:test|run\s+test(?::[\w-]+)?)\b|\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b)/i.test(
			evidence.command ?? "",
		)
	);
}

export function xpObservation(state: XpState, summary: string, evidenceIds: readonly string[]): DecisionObservation {
	const evidence = evidenceIds.map((id) => state.evidence.find((item) => item.id === id));
	if (evidence.some((item) => !item)) throw new Error("Evidence must reference tool call IDs observed in this XP run");
	const proofs = evidence.filter((item): item is XpEvidence => item !== undefined);
	let ready = summary.trim().length > 0;
	if (state.testsRequired && state.phase === "testing") {
		ready &&= proofs.some(
			(item) =>
				isTestEvidence(item) &&
				item.isError &&
				item.revision === state.revision &&
				/AssertionError|assertion|expected|not ok|\bFAIL\b/i.test(item.text) &&
				!/SyntaxError|Cannot find module|command not found|MODULE_NOT_FOUND/i.test(item.text),
		);
	}
	if (state.testsRequired && (state.phase === "coding" || state.phase === "listening")) {
		ready &&= proofs.some((item) => isTestEvidence(item) && !item.isError && item.revision === state.revision);
	}
	const goalReached = ready && state.phase === "listening" && state.accepted;
	return {
		state: {
			goal: state.goal.slice(0, 500),
			phase: state.phase,
			guidance: XP_PHASE_GUIDANCE[state.phase],
			summary: summary.slice(0, 800),
			ready,
			accepted: state.accepted,
			revision: state.revision,
			evidence: proofs.slice(-5).map((item) => ({
				id: item.id,
				tool: item.tool,
				command: (item.command ?? "").slice(0, 200),
				isError: item.isError,
				text: item.text.slice(-240),
				revision: item.revision,
			})),
		},
		actions: {
			continue_phase: { description: "Continue the current phase; evidence or work is incomplete.", risk: "read" },
			...(ready && state.phase !== "listening"
				? {
						advance: {
							description: "The phase is demonstrably complete; advance to the next XP phase.",
							risk: "write" as const,
						},
					}
				: {}),
			...(state.phase === "coding" || state.phase === "listening"
				? {
						replan: {
							description: "Requirements or design must change; return to planning and invalidate acceptance.",
							risk: "write" as const,
						},
					}
				: {}),
		},
		goalReached,
	};
}

export function applyXpAction(state: XpState, action: string): void {
	if (action === "advance" && state.phase !== "listening") state.phase = XP_PHASES[XP_PHASES.indexOf(state.phase) + 1];
	else if (action === "replan") {
		state.phase = "planning";
		state.accepted = false;
		state.revision++;
	} else if (action === "finish") state.status = "completed";
	else if (action === "escalate") state.status = "handoff";
}
