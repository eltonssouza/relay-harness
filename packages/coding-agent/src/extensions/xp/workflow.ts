import type { DecisionObservation } from "@relay-harness/agent-core";
import type { AgentId } from "../laya/questions.ts";

export const XP_PHASES = ["planning", "design", "testing", "coding", "listening"] as const;
export type XpPhase = (typeof XP_PHASES)[number];

export const XP_PHASE_GUIDANCE: Record<XpPhase, string> = {
	planning:
		"Define the smallest useful slice, acceptance criteria, constraints and unknowns. Use refine-backlog if refinement is needed.",
	design:
		"Choose a simple design tied to the acceptance criteria. State boundaries, contracts and risks. Use decide-architecture or design-service as needed.",
	testing:
		"Derive test cases and a validation strategy from the acceptance criteria. For native tasks, record a concrete testPlan to execute during Coding, or report an observed behavioral test failure. Manual /xp workflows require the observed failure. Use implement-feature-tdd or automate-tests when applicable.",
	coding:
		"Implement the minimum solution and the planned tests, verify the acceptance criteria, then refactor while tests stay green. Report a successful test call ID after the latest mutation. Use implement-feature-tdd and quality-baseline when applicable.",
	listening:
		"Evaluate the result, fresh validation evidence, errors and available feedback. Report adjustments and lessons without inventing feedback. Native tasks finish after validation; do not wait for acceptance. Only explicit manual /xp workflows wait for /xp accept. Incorporate changed requirements in a new planning cycle.",
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
	/** Native tasks are started by request intent, not by a slash command. */
	automatic?: boolean;
	/** Delivery and validation were reported during the Listening phase. */
	listeningReported?: boolean;
	/** Optional specialists selected for this task; other phases use the default role. */
	agents?: Partial<Record<XpPhase, AgentId>>;
	/** Skills the executor reports actually applying in each phase. */
	phaseSkills?: Partial<Record<XpPhase, string[]>>;
	/** Acceptance-derived validation to implement and execute during Coding. */
	testPlan?: string;
	/** A justified question awaiting user input; does not complete the current phase. */
	intervention?: { reason: string; question: string };
	/** Project-relative single source of truth for native task decisions. */
	specificationPath?: string;
	/** Phases whose report has been recorded in the specification. */
	specificationPhases?: XpPhase[];
	/** Structured phase reports stored in the single specification artifact. */
	specificationReports?: Partial<Record<XpPhase, string>>;
	/** Digest of the last artifact written by the workflow; external edits require review. */
	specificationDigest?: string;
	/** An external artifact change requires a revised Design report, not human approval. */
	specificationReviewRequired?: boolean;
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
	const phaseIndex = XP_PHASES.indexOf(state.phase);
	const recorded = new Set(state.specificationPhases);
	let ready =
		summary.trim().length > 0 &&
		(!state.automatic ||
			(Boolean(state.specificationPath) &&
				XP_PHASES.slice(0, phaseIndex + 1).every((phase) => recorded.has(phase))));
	if (state.testsRequired && state.phase === "testing") {
		ready &&=
			Boolean(state.automatic && state.testPlan?.trim()) ||
			proofs.some(
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
	const goalReached = ready && state.phase === "listening" && (state.automatic === true || state.accepted);
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
		state.listeningReported = false;
		state.specificationPhases = [];
		state.specificationReports = {};
		state.phaseSkills = {};
		state.testPlan = undefined;
		state.revision++;
	} else if (action === "finish") state.status = "completed";
	else if (action === "escalate") state.status = "handoff";
}
