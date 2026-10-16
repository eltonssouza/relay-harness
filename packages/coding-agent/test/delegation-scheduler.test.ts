import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApprovedWorkPlan, WorkerResult, WorkerRun } from "../src/core/delegation/contracts.ts";
import { workerRunKey } from "../src/core/delegation/contracts.ts";
import { DEFAULT_DELEGATION_LIMITS } from "../src/core/delegation/limits.ts";
import { DelegationScheduler, WorkspaceLeases } from "../src/core/delegation/scheduler.ts";
import { type DelegationEvent, DelegationStore } from "../src/core/delegation/store.ts";
import { delegationCheckpoint } from "../src/extensions/delegation/checkpoint.ts";

function fixture(count = 4, maxConcurrent = 3) {
	const plan: ApprovedWorkPlan = {
		proposal: {
			workflowId: "workflow",

			version: 1,
			workspaceRevision: 0,
			tasks: Array.from({ length: count }, (_, index) => ({
				taskId: `task-${index}`,
				objective: `Investigate ${index}`,
				acceptanceCriteria: ["Root cause"],
				proposedProfile: "engineer",
				dependencies: [],
				inputs: [],
				expectedOutput: "Report",
				resourceScope: ["src"],
				accessMode: "investigation",
				limits: { durationMs: 1000, steps: 5, outputBytes: 1000 },
			})),
		},
		decisionId: "decision",
		model: "relay-laya-v4",
		checkpoint: delegationCheckpoint(),
		maxConcurrent,
		limits: { ...DEFAULT_DELEGATION_LIMITS, maxConcurrent: Math.max(3, maxConcurrent) },
		selections: Array.from({ length: count }, (_, index) => ({
			taskId: `task-${index}`,
			profile: "engineer",
			tools: [],
			skills: [],
			executionMode: "parallel",
		})),
	};
	const events: DelegationEvent[] = [];
	const store = new DelegationStore("workflow", (event) => {
		events.push(event);
	});
	return { plan, store, events };
}

type EventPayload = DelegationEvent extends infer Event
	? Event extends DelegationEvent
		? Omit<Event, "id" | "workflowId" | "timestamp">
		: never
	: never;
function record(store: DelegationStore, payload: EventPayload): DelegationEvent {
	const event: DelegationEvent = {
		...payload,
		id: randomUUID(),
		workflowId: "workflow",
		timestamp: new Date().toISOString(),
	};
	store.record(event);
	return event;
}

function approve(store: DelegationStore, plan: ApprovedWorkPlan): void {
	record(store, { type: "proposal", proposal: plan.proposal });
	record(store, { type: "approved", plan });
}

function result(run: WorkerRun): WorkerResult {
	return {
		workflowId: run.workflowId,
		planVersion: run.planVersion,
		taskId: run.taskId,
		attempt: run.attempt,
		workerId: run.workerId,
		summary: "Observed root cause",
		limitations: [],
		evidence: [],
		workspaceRevision: 0,
		accepted: false,
		stale: false,
	};
}

function running(taskId = "task-0", attempt = 1): WorkerRun {
	const identity = {
		workflowId: "workflow",

		planVersion: 1,
		taskId,
		attempt,
		workerId: randomUUID(),
	};
	return { ...identity, key: workerRunKey(identity), status: "running", reconciled: false };
}

describe("delegation scheduler and persistence", () => {
	it("inherits exclusive leases and permits upgrades only after other readers release", () => {
		const leases = new WorkspaceLeases();
		const release = leases.acquire("parent", false);
		const other = leases.acquire("worker", false);
		expect(leases.borrow("parent", false)).toBe(true);
		expect(leases.borrow("parent", true)).toBe(false);
		expect(leases.borrow("missing", true)).toBe(false);
		other?.();
		expect(leases.borrow("parent", true)).toBe(true);
		expect(leases.borrow("parent", false)).toBe(true);
		expect(leases.acquire("worker", false)).toBeUndefined();
		release?.();
		expect(leases.hasActiveWorkers()).toBe(false);
	});
	it.each([1, 2, 3, 4])("limits concurrency to %s and preserves all independent results", async (maxConcurrent) => {
		const { plan, store } = fixture(maxConcurrent + 1, maxConcurrent);
		approve(store, plan);
		const leases = new WorkspaceLeases();
		let active = 0;
		let peak = 0;
		let release: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const scheduler = new DelegationScheduler(store, leases, async (_task, _selection, run) => {
			peak = Math.max(peak, ++active);
			if (active === maxConcurrent) release();
			await barrier;
			active--;
			return result(run);
		});
		const report = await scheduler.run(plan.selections.map((item) => item.taskId));
		expect(peak).toBe(maxConcurrent);
		expect(report.runs).toHaveLength(maxConcurrent + 1);
		expect(report.runs.every((run) => run.status === "completed" && !run.result?.accepted)).toBe(true);
		expect(leases.hasActiveWorkers()).toBe(false);
	});
	it("waits for explicit acceptance before executing dependencies and does not repeat accepted effects", async () => {
		const { plan, store } = fixture(2);
		plan.proposal.tasks[1].dependencies = ["task-0"];
		approve(store, plan);
		const executed: string[] = [];
		const scheduler = new DelegationScheduler(store, new WorkspaceLeases(), async (_task, _selection, run) => {
			executed.push(run.taskId);
			return result(run);
		});
		const first = await scheduler.run(["task-0", "task-1"]);
		expect(executed).toEqual(["task-0"]);
		expect(first.notExecuted).toEqual([{ taskId: "task-1", reason: expect.stringContaining("acceptance") }]);
		record(store, {
			type: "review",
			key: first.runs[0].key,
			accepted: true,
			reason: "Root cause meets the criterion",
		});
		await scheduler.run(["task-0", "task-1"]);
		expect(executed).toEqual(["task-0", "task-1"]);
	});
	it("serializes validation and mutations with investigations and principal edits", async () => {
		const { plan, store } = fixture(3);
		plan.proposal.tasks[0].accessMode = "validation";
		plan.selections[0].executionMode = "exclusive";
		plan.proposal.tasks[2].accessMode = "mutation";
		plan.selections[2].executionMode = "exclusive";
		approve(store, plan);
		const leases = new WorkspaceLeases();
		let active = 0;
		const scheduler = new DelegationScheduler(store, leases, async (_task, _selection, run) => {
			expect(++active).toBe(1);
			expect(leases.acquire("principal-edit", true)).toBeUndefined();
			await Promise.resolve();
			active--;
			return result(run);
		});
		await scheduler.run(plan.selections.map((item) => item.taskId));
		expect(store.snapshot().runs).toHaveLength(3);
		const release = leases.acquire("principal-edit", true);
		expect(release).toBeTypeOf("function");
		release?.();
	});
	it("propagates dependency failures while preserving independent results", async () => {
		const { plan, store } = fixture(3);
		plan.proposal.tasks[1].dependencies = ["task-0"];
		approve(store, plan);
		const scheduler = new DelegationScheduler(store, new WorkspaceLeases(), async (_task, _selection, run) => {
			if (run.taskId === "task-0") throw new Error("Inspection failed");
			return result(run);
		});
		const report = await scheduler.run(["task-0", "task-1", "task-2"]);
		expect(report.runs.map((run) => [run.taskId, run.status])).toEqual([
			["task-0", "failed"],
			["task-2", "completed"],
		]);
		expect(report.notExecuted).toEqual([{ taskId: "task-1", reason: expect.stringContaining("dependency") }]);
	});
	it("cancels active work and never starts queued tasks afterwards", async () => {
		const { plan, store } = fixture(3, 1);
		approve(store, plan);
		const controller = new AbortController();
		const executed: string[] = [];
		const leases = new WorkspaceLeases();
		const scheduler = new DelegationScheduler(store, leases, async (_task, _selection, run) => {
			executed.push(run.taskId);
			controller.abort();
			return result(run);
		});
		const report = await scheduler.run(["task-0", "task-1", "task-2"], controller.signal);
		expect(executed).toEqual(["task-0"]);
		expect(report.runs[0].status).toBe("cancelled");
		expect(report.notExecuted).toHaveLength(2);
		expect(leases.hasActiveWorkers()).toBe(false);
		await expect(scheduler.run(["task-1"])).rejects.toThrow("cancelled");
	});

	it("cancels obsolete active workers immediately when their plan is invalidated", async () => {
		const { plan, store } = fixture(1);
		approve(store, plan);
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const scheduler = new DelegationScheduler(
			store,
			new WorkspaceLeases(),
			async (_task, _selection, run, signal) => {
				markStarted();
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return result(run);
			},
		);
		const execution = scheduler.run(["task-0"]);
		await started;
		record(store, { type: "invalidate", reason: "Specification changed" });
		const report = await execution;
		expect(report.runs[0].status).toBe("cancelled");
		expect(report.runs[0].result).toBeUndefined();
	});

	it("does not allow a repeated lease owner to release another active read", () => {
		const leases = new WorkspaceLeases();
		const release = leases.acquire("worker", false);
		expect(leases.acquire("worker", false)).toBeUndefined();
		expect(leases.acquire("principal", true)).toBeUndefined();
		release?.();
		expect(leases.acquire("principal", true)).toBeTypeOf("function");
	});
	it("rejects concurrent execution batches", async () => {
		const { plan, store } = fixture(1);
		approve(store, plan);
		let release: () => void = () => {};
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const scheduler = new DelegationScheduler(store, new WorkspaceLeases(), async (_task, _selection, run) => {
			await wait;
			return result(run);
		});
		const first = scheduler.run(["task-0"]);
		await expect(scheduler.run(["task-0"])).rejects.toThrow("already executing");
		release();
		await first;
	});
	it("requires an approved plan and rejects unapproved task IDs", async () => {
		const { plan, store } = fixture(1);
		const scheduler = new DelegationScheduler(store, new WorkspaceLeases(), async (_task, _selection, run) =>
			result(run),
		);
		await expect(scheduler.run(["task-0"])).rejects.toThrow("No approved");
		approve(store, plan);
		await expect(scheduler.run(["other"])).rejects.toThrow("approved plan");
		await expect(scheduler.run(["task-0", "task-0"])).rejects.toThrow("unique task IDs");
	});
	it("recovers running attempts as interrupted without replaying side effects", async () => {
		const { plan, store, events } = fixture(1);
		plan.proposal.tasks[0].accessMode = "mutation";
		plan.selections[0].executionMode = "exclusive";
		approve(store, plan);
		const run = running();
		record(store, { type: "run", run });
		const replay = new DelegationStore(
			"workflow",
			(event) => {
				events.push(event);
			},
			events,
		);
		replay.recover((interrupted) => ({
			type: "run",
			run: interrupted,
			id: randomUUID(),
			workflowId: "workflow",
			timestamp: new Date().toISOString(),
		}));
		let effects = 0;
		const scheduler = new DelegationScheduler(replay, new WorkspaceLeases(), async (_task, _selection, run) => {
			effects++;
			return result(run);
		});
		const stopped = await scheduler.run(["task-0"]);
		expect(effects).toBe(0);
		expect(stopped.runs[0].status).toBe("interrupted");
		expect(stopped.runs[0].finishedAt).toBe(events.findLast((event) => event.type === "run")?.timestamp);
		expect(stopped.notExecuted[0].reason).toContain("reconciliation");
		record(replay, { type: "reconciled", key: run.key, reason: "Inspected workspace: the write did not occur" });
		await scheduler.run(["task-0"]);
		expect(effects).toBe(1);
		expect(replay.snapshot().runs[1]).toMatchObject({ attempt: 2, status: "completed" });
	});
	it("replays repeated events once and keeps snapshot mutations local", () => {
		const { plan, store, events } = fixture(1);
		approve(store, plan);
		const run = running();
		const event = record(store, { type: "run", run });
		store.record(event);
		const replay = new DelegationStore("workflow", () => {}, [...events, event]);
		expect(replay.snapshot().runs).toHaveLength(1);
		const snapshot = replay.snapshot();
		snapshot.runs[0].status = "completed";
		expect(replay.snapshot().runs[0].status).toBe("running");
	});
	it("does not authorize work when persistence fails", () => {
		const { plan } = fixture(1);
		const store = new DelegationStore("workflow", () => {
			throw new Error("Disk full");
		});
		expect(() => approve(store, plan)).toThrow("Disk full");
		expect(store.snapshot().proposal).toBeUndefined();
	});
	it("persists final metrics after cancellation without reviving work and replays them once", () => {
		const { plan, store, events } = fixture(1);
		approve(store, plan);
		const run = running();
		record(store, { type: "run", run });
		record(store, { type: "cancel", reason: "User stopped delegation" });
		const evidence = {
			workflowId: run.workflowId,
			planVersion: run.planVersion,
			taskId: run.taskId,
			attempt: run.attempt,
			workerId: run.workerId,
			id: "cancelled-call",
			toolCallId: "call",
			tool: "read",
			isError: true,
			text: "Aborted",
			workspaceRevision: 0,
		};
		record(store, { type: "evidence", evidence });
		const metrics = {
			usage: {
				input: 10,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 13,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			elapsedMs: 50,
			steps: 1,
			outputBytes: 20,
		};
		const event = record(store, { type: "metrics", key: run.key, metrics });
		const replay = new DelegationStore("workflow", () => {}, [...events, event]);
		expect(replay.snapshot().runs).toMatchObject([{ status: "cancelled", metrics }]);
		expect(replay.snapshot().runs[0].result).toBeUndefined();
		expect(replay.snapshot().evidence).toEqual([evidence]);
		expect(() => record(store, { type: "evidence", evidence: { ...evidence, id: "late-call" } })).toThrow(
			"observations are closed",
		);
		expect(() => record(store, { type: "metrics", key: run.key, metrics })).toThrow("without final metrics");
		expect(() => record(store, { type: "metrics", key: "unknown", metrics })).toThrow("observed attempt");
	});
	it("records a direct decision separately and requires a new proposal before another decision", () => {
		const { plan, store } = fixture(1);
		record(store, { type: "proposal", proposal: plan.proposal });
		record(store, { type: "decision", kind: "direct", decisionId: "direct-decision" });
		expect(store.snapshot().decision).toEqual({ kind: "direct", decisionId: "direct-decision" });
		expect(store.snapshot().plan).toBeUndefined();
		expect(() => record(store, { type: "approved", plan })).toThrow("already has a recorded decision");
		record(store, { type: "invalidate", reason: "Changed resources" });
		expect(store.snapshot().decision).toBeUndefined();
		record(store, { type: "proposal", proposal: { ...plan.proposal, version: 2 } });
		record(store, { type: "approved", plan: { ...plan, proposal: { ...plan.proposal, version: 2 } } });
		expect(store.snapshot().decision?.kind).toBe("delegated");
	});
	it("rejects forged results, overwritten attempts and cross-workflow events", () => {
		const { plan, store } = fixture(1);
		approve(store, plan);
		const run = running();
		record(store, { type: "run", run });
		expect(() => record(store, { type: "run", run })).toThrow("restarted");
		expect(() => record(store, { type: "result", key: run.key, result: { ...result(run), accepted: true } })).toThrow(
			"matching observed",
		);
		expect(() =>
			record(store, {
				type: "result",
				key: run.key,
				result: {
					...result(run),
					evidence: [
						{
							...run,
							id: "fake",
							toolCallId: "fake",
							tool: "bash",
							text: "passed",
							isError: false,
							workspaceRevision: 0,
						},
					],
				},
			}),
		).toThrow("matching observed");
		expect(() =>
			store.record({
				id: "foreign",
				workflowId: "other",
				timestamp: new Date().toISOString(),
				type: "cancel",
				reason: "Other task",
			}),
		).toThrow("another workflow");
	});
	it("invalidates accepted results when proposals or context change", () => {
		const { plan, store } = fixture(1);
		approve(store, plan);
		const run = running();
		record(store, { type: "run", run });
		record(store, { type: "result", key: run.key, result: result(run) });
		record(store, { type: "review", key: run.key, accepted: true, reason: "Verified criteria" });
		record(store, { type: "invalidate", reason: "External SDD edit" });
		expect(store.snapshot().plan).toBeUndefined();
		expect(store.snapshot().runs[0].result).toMatchObject({ stale: true, accepted: false });
		expect(() => record(store, { type: "review", key: run.key, accepted: true, reason: "Old result" })).toThrow(
			"current, completed",
		);
	});
	it("requires a new proposal version and stops replacement while workers run", () => {
		const { plan, store } = fixture(1);
		approve(store, plan);
		expect(() => record(store, { type: "proposal", proposal: plan.proposal })).toThrow("new version");
		record(store, { type: "run", run: running() });
		expect(() => record(store, { type: "proposal", proposal: { ...plan.proposal, version: 2 } })).toThrow(
			"Cancel obsolete",
		);
	});
	it.each([1, 2, 3])("requires reconciliation and enforces the configured budget of %s attempts", async (budget) => {
		const { plan, store } = fixture(1);
		plan.limits.maxAttempts = budget;
		approve(store, plan);
		let attempts = 0;
		const scheduler = new DelegationScheduler(store, new WorkspaceLeases(), async () => {
			attempts++;
			throw new Error("Failed");
		});
		for (let attempt = 1; attempt <= budget; attempt++) {
			await scheduler.run(["task-0"]);
			await scheduler.run(["task-0"]);
			expect(attempts).toBe(attempt);
			record(store, {
				type: "reconciled",
				key: store.snapshot().runs[attempt - 1].key,
				reason: "No effects observed",
			});
		}
		await scheduler.run(["task-0"]);
		expect(attempts).toBe(budget);
	});
});
