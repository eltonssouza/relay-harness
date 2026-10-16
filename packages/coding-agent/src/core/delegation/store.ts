import type { WorkerInstructions } from "./context.ts";
import type {
	ApprovedWorkPlan,
	WorkerEvidence,
	WorkerMetrics,
	WorkerResult,
	WorkerRun,
	WorkProposal,
} from "./contracts.ts";
import { workerRunKey } from "./contracts.ts";

export interface DelegationState {
	version: 1;
	workflowId: string;
	proposal?: WorkProposal;
	plan?: ApprovedWorkPlan;
	decision?: { kind: "direct" | "revise" | "delegated"; decisionId: string };
	runs: WorkerRun[];
	evidence: WorkerEvidence[];
	cancelled: boolean;
	/** Stable IDs make replay idempotent. */
	eventIds: string[];
}

export type DelegationEvent = { id: string; workflowId: string; timestamp: string } & (
	| { type: "proposal"; proposal: WorkProposal }
	| { type: "approved"; plan: ApprovedWorkPlan }
	| { type: "decision"; kind: "direct" | "revise"; decisionId: string }
	| { type: "run"; run: WorkerRun }
	| { type: "instructions"; key: string; instructions: WorkerInstructions }
	| { type: "evidence"; evidence: WorkerEvidence }
	| { type: "metrics"; key: string; metrics: WorkerMetrics }
	| { type: "result"; key: string; result: WorkerResult }
	| { type: "review"; key: string; accepted: boolean; reason: string }
	| { type: "reconciled"; key: string; reason: string }
	| { type: "invalidate"; reason: string }
	| { type: "cancel"; reason: string }
);

/** Persist first, then apply. A failed append never authorizes starting a worker. */
export class DelegationStore {
	private state: DelegationState;
	private readonly append: (event: DelegationEvent) => void;
	private readonly listeners = new Set<(state: DelegationState) => void>();

	constructor(workflowId: string, append: (event: DelegationEvent) => void, events: readonly DelegationEvent[] = []) {
		this.state = { version: 1, workflowId, runs: [], evidence: [], cancelled: false, eventIds: [] };
		this.append = append;
		for (const event of events) this.apply(event);
	}

	snapshot(): DelegationState {
		return structuredClone(this.state);
	}

	subscribe(listener: (state: DelegationState) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	record(event: DelegationEvent): void {
		const candidate = new DelegationStore(this.state.workflowId, () => {});
		candidate.state = structuredClone(this.state);
		candidate.apply(event);
		if (this.state.eventIds.includes(event.id)) return;
		this.append(structuredClone(event));
		this.state = candidate.state;
		for (const listener of this.listeners) listener(this.snapshot());
	}

	private apply(event: DelegationEvent): void {
		if (event.workflowId !== this.state.workflowId) throw new Error("Delegation event belongs to another workflow");
		if (this.state.eventIds.includes(event.id)) return;
		if (!event.id.trim() || !Number.isFinite(Date.parse(event.timestamp)))
			throw new Error("Invalid delegation event identity");
		const state = this.state;
		if (event.type === "proposal") {
			if (state.cancelled) throw new Error("Cancelled delegation cannot receive another proposal");
			if (event.proposal.workflowId !== state.workflowId || event.proposal.version <= (state.proposal?.version ?? 0))
				throw new Error("Work proposals require a new version in the same workflow");
			if (state.runs.some((run) => run.status === "running"))
				throw new Error("Cancel obsolete workers before replacing their plan");
			this.invalidate("Proposal superseded");
			state.proposal = structuredClone(event.proposal);
			delete state.plan;
			delete state.decision;
		} else if (event.type === "approved") {
			if (state.cancelled || JSON.stringify(event.plan.proposal) !== JSON.stringify(state.proposal))
				throw new Error("Approval does not match the current proposal");
			if (state.plan || state.decision) throw new Error("Proposal already has a recorded decision");
			state.plan = structuredClone(event.plan);
			state.decision = { kind: "delegated", decisionId: event.plan.decisionId };
		} else if (event.type === "decision") {
			if (state.cancelled || !state.proposal || state.plan || state.decision || !event.decisionId.trim())
				throw new Error("Decision requires an unevaluated current proposal");
			state.decision = { kind: event.kind, decisionId: event.decisionId };
		} else if (event.type === "run") {
			const run = event.run;
			if (run.key !== workerRunKey(run) || run.workflowId !== state.workflowId)
				throw new Error("Invalid worker execution key");
			const existing = state.runs.find((item) => item.key === run.key);
			if (existing) {
				if (existing.status !== "running" || !["failed", "cancelled", "interrupted"].includes(run.status))
					throw new Error("Worker attempt cannot be restarted or overwritten");
				if (existing.workerId !== run.workerId) throw new Error("Worker attempt identity changed");
				Object.assign(existing, structuredClone(run));
			} else {
				if (
					state.cancelled ||
					!state.plan ||
					run.status !== "running" ||
					run.planVersion !== state.plan.proposal.version ||
					!state.plan.selections.some((selection) => selection.taskId === run.taskId) ||
					!Number.isInteger(run.attempt) ||
					run.attempt < 1 ||
					state.runs.some((item) => item.workerId === run.workerId)
				)
					throw new Error("Worker run is outside the current approved plan");
				state.runs.push(structuredClone(run));
			}
		} else if (event.type === "instructions") {
			const run = state.runs.find((run) => run.key === event.key);
			if (event.instructions.version !== 2)
				throw new Error("Unsupported worker instruction version; start a new delegation task");
			if (!run || run.status !== "running" || run.contextDigest)
				throw new Error("Instructions require a newly started worker attempt");
			run.contextDigest = event.instructions.digest;
		} else if (event.type === "evidence") {
			const run = state.runs.find((run) => run.key === workerRunKey(event.evidence));
			// Stop scheduling immediately, but retain in-flight outcomes until final metrics close observation.
			if (
				!run ||
				run.metrics ||
				!["running", "cancelled"].includes(run.status) ||
				run.workerId !== event.evidence.workerId
			)
				throw new Error("Worker observations are closed or the attempt is unknown");
			if (state.evidence.some((item) => item.id === event.evidence.id))
				throw new Error("Duplicate worker evidence ID");
			state.evidence.push(structuredClone(event.evidence));
		} else if (event.type === "metrics") {
			const run = state.runs.find((run) => run.key === event.key);
			if (!run || run.metrics) throw new Error("Metrics require an observed attempt without final metrics");
			run.metrics = structuredClone(event.metrics);
		} else if (event.type === "result") {
			const run = state.runs.find((run) => run.key === event.key);
			if (
				!run ||
				run.status !== "running" ||
				!state.plan ||
				run.planVersion !== state.plan.proposal.version ||
				run.key !== workerRunKey(event.result) ||
				run.workerId !== event.result.workerId ||
				event.result.accepted ||
				event.result.stale ||
				event.result.evidence.length !== state.evidence.filter((item) => item.workerId === run.workerId).length ||
				new Set(event.result.evidence.map((item) => item.id)).size !== event.result.evidence.length ||
				event.result.evidence.some(
					(item) =>
						item.workerId !== run.workerId ||
						!state.evidence.some((observed) => JSON.stringify(observed) === JSON.stringify(item)),
				)
			)
				throw new Error("Worker result has no matching observed attempt");
			run.result = structuredClone(event.result);
			run.status = "completed";
			run.finishedAt = event.timestamp;
		} else if (event.type === "review") {
			const run = state.runs.find((run) => run.key === event.key);
			if (
				!run?.result ||
				run.status !== "completed" ||
				run.result.stale ||
				state.cancelled ||
				run.planVersion !== state.plan?.proposal.version ||
				!event.reason.trim()
			)
				throw new Error("Only current, completed results can be reviewed");
			run.result.accepted = event.accepted;
			run.reason = event.reason;
		} else if (event.type === "reconciled") {
			const run = state.runs.find((run) => run.key === event.key);
			if (!run || !["interrupted", "cancelled", "failed"].includes(run.status) || !event.reason.trim())
				throw new Error("Reconciliation requires an inspected unsuccessful attempt");
			run.reconciled = true;
			run.reason = event.reason;
		} else if (event.type === "invalidate") {
			this.invalidate(event.reason);
			delete state.plan;
			delete state.decision;
		} else if (event.type === "cancel") {
			state.cancelled = true;
			for (const run of state.runs) {
				if (run.status !== "running") continue;
				run.status = "cancelled";
				run.finishedAt = event.timestamp;
				run.reason = event.reason;
			}
		}
		state.eventIds.push(event.id);
	}

	private invalidate(reason: string): void {
		for (const run of this.state.runs) {
			if (run.result) {
				run.result.stale = true;
				run.result.accepted = false;
			}
			run.reason = reason;
		}
	}

	/** Called only after the old runtime is known to have stopped, never on an observation timeout. */
	recover(event: (run: WorkerRun) => Extract<DelegationEvent, { type: "run" }>): void {
		for (const run of this.snapshot().runs) {
			if (run.status !== "running") continue;
			const recovered = event({ ...run, status: "interrupted", reconciled: false });
			// Require reconciliation observations from after this recovery, not from before the crash.
			this.record({ ...recovered, run: { ...recovered.run, finishedAt: recovered.timestamp } });
		}
	}
}
