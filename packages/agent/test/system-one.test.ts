import type { ClassifierAnswer, ClassifierResult } from "@relay-harness/ai";
import { describe, expect, it, vi } from "vitest";
import {
	compileDecision,
	type DecisionObservation,
	judgeDecision,
	runDecisionLoop,
} from "../src/harness/system-one.ts";

const choice = (value: string, confidence = 0.95): ClassifierAnswer => ({
	type: "choice",
	choice: value,
	confidence,
	probabilities: { [value]: confidence },
});
const result = (answers: Record<string, ClassifierAnswer>): ClassifierResult => ({
	api: "typesafe-system-one",
	provider: "laya",
	model: "execution-intelligence",
	answers,
	stopReason: "stop",
	timestamp: 0,
});
const observation: DecisionObservation = {
	state: { goal: "ship order", status: "packed" },
	goalReached: false,
	actions: {
		ship: {
			description: "Ship the packed order",
			risk: "destructive",
			parameters: {
				carrier: {
					type: "choice",
					instructions: "Choose a carrier",
					choices: { courier: "Courier", post: "Post" },
				},
			},
		},
	},
};

describe("finite System One decisions", () => {
	it("times out an adapter that ignores cancellation and records the attempted decision", async () => {
		const execute = vi.fn();
		const run = await runDecisionLoop({
			timeoutMs: 10,
			environment: { observe: async () => observation, execute },
			decide: () => new Promise<ClassifierResult>(() => {}),
		});
		expect(run).toMatchObject({
			status: "incomplete",
			reason: "timeout",
			steps: [{ questions: { next_action: expect.any(Object) }, error: expect.any(String) }],
		});
		expect(execute).not.toHaveBeenCalled();
	});
	it("compiles finite candidates and withholds finish without environment proof", () => {
		expect(compileDecision(observation).ship__carrier).toMatchObject({
			criteria: { courier: "Courier", post: "Post" },
		});
		expect(compileDecision(observation).next_action).toMatchObject({
			criteria: { ship: expect.any(String), escalate: expect.any(String) },
		});
		expect(compileDecision(observation).next_action).not.toMatchObject({ criteria: { finish: expect.any(String) } });
	});
	it("gates on the weakest parameter and rejects fabricated values", () => {
		expect(
			judgeDecision(observation, { next_action: choice("ship"), ship__carrier: choice("courier", 0.7) }),
		).toMatchObject({ kind: "refused", weakest: 0.7, threshold: 0.9 });
		expect(judgeDecision(observation, { next_action: choice("ship"), ship__carrier: choice("unknown") }).kind).toBe(
			"refused",
		);
		expect(
			judgeDecision(observation, { next_action: choice("ship"), ship__carrier: choice("courier") }),
		).toMatchObject({ kind: "execute", parameters: { carrier: "courier" } });
	});
	it("refuses missing, non-finite and contradictory probabilities", () => {
		for (const confidence of [Number.NaN, Infinity, -1, 2])
			expect(
				judgeDecision(observation, { next_action: choice("ship", confidence), ship__carrier: choice("courier") })
					.kind,
			).toBe("refused");
		expect(
			judgeDecision(observation, {
				next_action: { type: "choice", choice: "ship", confidence: 0.95, probabilities: { ship: 0.1 } },
				ship__carrier: choice("courier"),
			}).kind,
		).toBe("refused");
		expect(judgeDecision(observation, {}).kind).toBe("refused");
	});
	it("requires independent completion and a confident goal answer", () => {
		const answers = {
			next_action: choice("finish"),
			goal_reached: { type: "bool", probability: 0.95 } as ClassifierAnswer,
		};
		expect(judgeDecision(observation, answers).kind).toBe("refused");
		expect(judgeDecision({ ...observation, goalReached: true }, answers).kind).toBe("finish");
		expect(
			judgeDecision(
				{ ...observation, goalReached: true },
				{ ...answers, goal_reached: { type: "bool", probability: 0.2 } },
			).kind,
		).toBe("refused");
	});
	it("executes once, observes again and records a verified finish", async () => {
		let shipped = false;
		const execute = vi.fn(async () => {
			shipped = true;
			return { shipped };
		});
		const run = await runDecisionLoop({
			environment: { observe: async () => ({ ...observation, state: { shipped }, goalReached: shipped }), execute },
			decide: async () =>
				shipped
					? result({ next_action: choice("finish"), goal_reached: { type: "bool", probability: 0.95 } })
					: result({ next_action: choice("ship"), ship__carrier: choice("courier") }),
		});
		expect(run).toMatchObject({ status: "completed", reason: "goal_reached" });
		expect(run.steps).toHaveLength(2);
		expect(execute).toHaveBeenCalledExactlyOnceWith("ship", { carrier: "courier" }, expect.any(AbortSignal));
	});
	it("hands off repeated refusals without executing", async () => {
		const execute = vi.fn();
		const run = await runDecisionLoop({
			environment: { observe: async () => observation, execute },
			decide: async () => result({ next_action: choice("ship", 0.4), ship__carrier: choice("courier") }),
		});
		expect(run).toMatchObject({
			status: "incomplete",
			reason: "no_confident_action",
			handoff: { verdict: { weakest: 0.4, threshold: 0.9 } },
		});
		expect(execute).not.toHaveBeenCalled();
	});
	it("stops a repeated action on unchanged state", async () => {
		const execute = vi.fn(async () => ({ ok: true }));
		const run = await runDecisionLoop({
			environment: { observe: async () => observation, execute },
			decide: async () => result({ next_action: choice("ship"), ship__carrier: choice("courier") }),
		});
		expect(run.reason).toBe("repeated_action");
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it("cancellation during classification prevents execution", async () => {
		const controller = new AbortController();
		const execute = vi.fn();
		const run = await runDecisionLoop({
			signal: controller.signal,
			environment: { observe: async () => observation, execute },
			decide: async () => {
				controller.abort();
				return result({ next_action: choice("ship"), ship__carrier: choice("courier") });
			},
		});
		expect(run.status).toBe("cancelled");
		expect(execute).not.toHaveBeenCalled();
	});
	it("records provider and execution failures", async () => {
		const failed = await runDecisionLoop({
			environment: { observe: async () => observation, execute: vi.fn() },
			decide: async () => ({ ...result({}), stopReason: "error", errorMessage: "unavailable" }),
		});
		expect(failed.steps[0].error).toBe("unavailable");
		const run = await runDecisionLoop({
			environment: {
				observe: async () => observation,
				execute: async () => {
					throw new Error("write failed");
				},
			},
			decide: async () => result({ next_action: choice("ship"), ship__carrier: choice("courier") }),
		});
		expect(run).toMatchObject({ status: "failed", steps: [{ error: "write failed" }] });
	});
});
