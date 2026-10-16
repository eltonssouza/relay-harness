import { randomUUID } from "node:crypto";
import type { ApprovedWorkPlan, WorkerResult, WorkerRun, WorkerSelection, WorkTask } from "./contracts.ts";
import { workerRunKey } from "./contracts.ts";
import { resolveDelegationLimits } from "./limits.ts";
import type { DelegationEvent, DelegationStore } from "./store.ts";

export interface WorkExecutionReport {
	runs: WorkerRun[];
	notExecuted: Array<{ taskId: string; reason: string }>;
}

/** The same lease is held across an entire worker and each potentially mutating principal call. */
export class WorkspaceLeases {
	private readers = new Set<string>();
	private writer?: string;

	acquire(owner: string, exclusive: boolean): (() => void) | undefined {
		if (this.writer || this.readers.has(owner) || (exclusive && this.readers.size)) return undefined;
		if (exclusive) this.writer = owner;
		else this.readers.add(owner);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			if (this.writer === owner) this.writer = undefined;
			this.readers.delete(owner);
		};
	}

	/** Nested principal calls keep their ancestor's lease; upgrades require no other reader. */
	borrow(owner: string, exclusive: boolean): boolean {
		if (this.writer === owner) return true;
		if (!this.readers.has(owner)) return false;
		if (!exclusive) return true;
		if (this.writer || this.readers.size !== 1) return false;
		this.readers.delete(owner);
		this.writer = owner;
		return true;
	}

	hasActiveWorkers(): boolean {
		return Boolean(this.writer || this.readers.size);
	}
}

export class DelegationScheduler {
	readonly leases: WorkspaceLeases;
	private readonly store: DelegationStore;
	private readonly execute: (
		task: WorkTask,
		selection: WorkerSelection,
		run: WorkerRun,
		signal: AbortSignal,
	) => Promise<WorkerResult>;
	private controller = new AbortController();
	private running = false;

	constructor(
		store: DelegationStore,
		leases: WorkspaceLeases,
		execute: (
			task: WorkTask,
			selection: WorkerSelection,
			run: WorkerRun,
			signal: AbortSignal,
		) => Promise<WorkerResult>,
	) {
		this.store = store;
		this.leases = leases;
		this.execute = execute;
	}

	cancel(): void {
		this.controller.abort();
	}

	/** One batch per session: repeated execution calls cannot create concurrent duplicate attempts. */
	async run(taskIds: readonly string[], signal?: AbortSignal): Promise<WorkExecutionReport> {
		if (this.running) throw new Error("Delegated work is already executing");
		const state = this.store.snapshot();
		if (state.cancelled || this.controller.signal.aborted) throw new Error("Delegated work was cancelled");
		const plan = state.plan;
		if (!plan) throw new Error("No approved work plan");
		if (!plan.limits) throw new Error("Approved work plan is missing its configured limits");
		const limits = resolveDelegationLimits(plan.limits);
		if (
			!Number.isSafeInteger(plan.maxConcurrent) ||
			plan.maxConcurrent < 1 ||
			plan.maxConcurrent > limits.maxConcurrent
		)
			throw new Error("Invalid worker concurrency limit");
		if (
			new Set(taskIds).size !== taskIds.length ||
			taskIds.some((id) => !plan.selections.some((item) => item.taskId === id))
		)
			throw new Error("Execute only unique task IDs from the approved plan");
		this.running = true;
		const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
		const pending = new Set(taskIds);
		const active = new Map<string, Promise<void>>();
		const notExecuted: WorkExecutionReport["notExecuted"] = [];
		const unsubscribe = this.store.subscribe((updated) => {
			if (updated.cancelled || updated.plan?.decisionId !== plan.decisionId) this.cancel();
		});
		try {
			while (pending.size || active.size) {
				if (combined.aborted) {
					for (const taskId of pending)
						notExecuted.push({ taskId, reason: "Session or user cancelled execution" });
					pending.clear();
					await Promise.all(active.values());
					break;
				}
				const current = this.store.snapshot();
				if (!current.plan || current.plan.decisionId !== plan.decisionId || current.cancelled) {
					this.cancel();
					continue;
				}
				let started = false;
				for (const taskId of [...pending]) {
					if (active.size >= plan.maxConcurrent) break;
					const task = plan.proposal.tasks.find((task) => task.taskId === taskId);
					const selection = plan.selections.find((selection) => selection.taskId === taskId);
					if (!task || !selection) throw new Error("Invalid approved plan");
					const previous = this.latest(plan, taskId);
					if (previous?.status === "completed" && previous.result?.accepted && !previous.result.stale) {
						pending.delete(taskId);
						continue;
					}
					if (
						previous &&
						(!previous.reconciled || previous.status === "running" || previous.attempt >= limits.maxAttempts)
					) {
						pending.delete(taskId);
						notExecuted.push({
							taskId,
							reason:
								previous.status === "completed"
									? "Result requires coordinator review"
									: "Previous attempt requires reconciliation or exhausted its retry limit",
						});
						continue;
					}
					const dependencies = task.dependencies.map((id) => this.latest(plan, id));
					if (dependencies.some((run) => run && ["failed", "cancelled", "interrupted"].includes(run.status))) {
						pending.delete(taskId);
						notExecuted.push({ taskId, reason: "A required dependency did not complete successfully" });
						continue;
					}
					if (dependencies.some((run) => !run?.result?.accepted || run.result.stale)) continue;
					const workerId = randomUUID();
					const release = this.leases.acquire(workerId, selection.executionMode === "exclusive");
					if (!release) continue;
					const identity = {
						workflowId: plan.proposal.workflowId,
						planVersion: plan.proposal.version,
						taskId,
						attempt: (previous?.attempt ?? 0) + 1,
						workerId,
					};
					const run: WorkerRun = {
						...identity,
						key: workerRunKey(identity),
						status: "running",
						reconciled: false,
						startedAt: new Date().toISOString(),
						resources: structuredClone(selection),
					};
					try {
						this.record({ type: "run", run });
					} catch (error) {
						release();
						throw error;
					}
					pending.delete(taskId);
					started = true;
					const promise = this.perform(task, selection, run, combined).finally(() => {
						release();
						active.delete(taskId);
					});
					active.set(taskId, promise);
				}
				if (active.size) await Promise.race(active.values());
				else if (!started) {
					for (const taskId of pending)
						notExecuted.push({ taskId, reason: "Dependencies await acceptance or workspace resources are busy" });
					pending.clear();
				}
			}
			return {
				runs: this.store
					.snapshot()
					.runs.filter((run) => run.planVersion === plan.proposal.version && taskIds.includes(run.taskId)),
				notExecuted,
			};
		} finally {
			unsubscribe();
			if (combined.aborted) this.cancel();
			if (active.size) {
				this.cancel();
				await Promise.allSettled(active.values());
			}
			this.running = false;
		}
	}

	private latest(plan: ApprovedWorkPlan, taskId: string): WorkerRun | undefined {
		return this.store
			.snapshot()
			.runs.findLast((run) => run.planVersion === plan.proposal.version && run.taskId === taskId);
	}

	private record(
		event:
			| Omit<Extract<DelegationEvent, { type: "run" }>, "id" | "workflowId" | "timestamp">
			| Omit<Extract<DelegationEvent, { type: "result" }>, "id" | "workflowId" | "timestamp">,
	): void {
		this.store.record({
			...event,
			id: randomUUID(),
			workflowId: this.store.snapshot().workflowId,
			timestamp: new Date().toISOString(),
		});
	}

	private async perform(
		task: WorkTask,
		selection: WorkerSelection,
		run: WorkerRun,
		signal: AbortSignal,
	): Promise<void> {
		try {
			const result = await this.execute(task, selection, run, signal);
			signal.throwIfAborted();
			this.record({ type: "result", key: run.key, result });
		} catch (error) {
			const current = this.store.snapshot().runs.find((item) => item.key === run.key);
			if (current?.status === "running")
				this.record({
					type: "run",
					run: {
						...run,
						status: signal.aborted
							? "cancelled"
							: error instanceof Error && error.name === "AbortError"
								? "interrupted"
								: "failed",
						reason: error instanceof Error ? error.message : String(error),
						finishedAt: new Date().toISOString(),
					},
				});
		}
	}
}
