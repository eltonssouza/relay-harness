import type {
	ClassifierAnswer,
	ClassifierContext,
	ClassifierQuestion,
	ClassifierResult,
	JsonObject,
} from "@relay-harness/ai";

export type DecisionRisk = "read" | "write" | "destructive";
export type FiniteParameter =
	| { type: "choice"; instructions: string; choices: Record<string, string> }
	| { type: "bool"; instructions: string };

export interface FiniteAction {
	description: string;
	risk: DecisionRisk;
	parameters?: Record<string, FiniteParameter>;
}

export interface DecisionObservation {
	state: JsonObject;
	actions: Record<string, FiniteAction>;
	/** The environment must independently verify completion before offering finish. */
	goalReached: boolean;
}

export const DEFAULT_DECISION_THRESHOLDS = { read: 0.5, write: 0.7, destructive: 0.9, finish: 0.8 };
export type DecisionThresholds = typeof DEFAULT_DECISION_THRESHOLDS;

export interface DecisionVerdict {
	kind: "execute" | "refused" | "finish" | "escalate";
	action: string;
	parameters: Record<string, string | boolean>;
	weakest: number;
	threshold: number;
	reason?: string;
}

const RESERVED = new Set(["finish", "escalate", "next_action", "goal_reached"]);

/** Compile only enumerable values. Candidate strings are supplied by the environment, never generated. */
export function compileDecision(observation: DecisionObservation): Record<string, ClassifierQuestion> {
	const questions: Record<string, ClassifierQuestion> = {};
	const criteria: Record<string, string> = { escalate: "Stop and hand the decision to a person or reasoning agent." };
	for (const [name, action] of Object.entries(observation.actions)) {
		if (!/^[a-z][a-z0-9_]*$/.test(name) || RESERVED.has(name)) throw new Error(`Invalid action: ${name}`);
		if (!action.description || !["read", "write", "destructive"].includes(action.risk)) {
			throw new Error(`Invalid action specification: ${name}`);
		}
		criteria[name] = action.description;
		for (const [parameter, spec] of Object.entries(action.parameters ?? {})) {
			if (!/^[a-z][a-z0-9_]*$/.test(parameter)) throw new Error(`Invalid parameter: ${parameter}`);
			const key = `${name}__${parameter}`;
			if (spec.type === "choice") {
				const entries = Object.entries(spec.choices);
				if (
					entries.length === 0 ||
					entries.length > 255 ||
					entries.some(([id, description]) => !id || !description)
				) {
					throw new Error(`Parameter ${key} needs 1..255 named choices`);
				}
				questions[key] = { type: "choice", instructions: spec.instructions, criteria: spec.choices };
			} else if (spec.type === "bool") {
				questions[key] = { type: "bool", instructions: spec.instructions, criteria: { true: "yes", false: "no" } };
			} else {
				throw new Error(`Parameter ${key} is not finite`);
			}
		}
	}
	if (observation.goalReached) criteria.finish = "The environment verified the goal; finish the run.";
	if (Object.keys(criteria).length > 255) throw new Error("The action space exceeds 255 options");
	questions.next_action = { type: "choice", instructions: "Which available action should run next?", criteria };
	questions.goal_reached = {
		type: "bool",
		instructions: "Does the observation demonstrate that the goal is fully achieved?",
		criteria: { true: "verified completion", false: "work remains or evidence is missing" },
	};
	return questions;
}

function probability(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

function choiceConfidence(answer: ClassifierAnswer | undefined): number {
	return answer?.type === "choice"
		? Math.min(probability(answer.confidence), probability(answer.probabilities[answer.choice]))
		: 0;
}

/** Refuse malformed answers and use the weakest dependent judgment, including each parameter. */
export function judgeDecision(
	observation: DecisionObservation,
	answers: Record<string, ClassifierAnswer>,
	thresholds: DecisionThresholds = DEFAULT_DECISION_THRESHOLDS,
): DecisionVerdict {
	for (const value of Object.values(thresholds)) {
		if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error("Invalid confidence threshold");
	}
	const answer = answers.next_action;
	const action = answer?.type === "choice" ? answer.choice : "";
	let weakest = choiceConfidence(answer);
	const refused = (threshold: number, reason: string): DecisionVerdict => ({
		kind: "refused",
		action,
		parameters: {},
		weakest,
		threshold,
		reason,
	});
	if (action === "escalate") return { kind: "escalate", action, parameters: {}, weakest, threshold: 0 };
	if (action === "finish") {
		const goal = answers.goal_reached;
		weakest = Math.min(weakest, goal?.type === "bool" ? probability(goal.probability) : 0);
		if (!observation.goalReached || weakest < thresholds.finish)
			return refused(thresholds.finish, "Completion is not verified");
		return { kind: "finish", action, parameters: {}, weakest, threshold: thresholds.finish };
	}
	const spec = Object.hasOwn(observation.actions, action) ? observation.actions[action] : undefined;
	if (!spec) return refused(1, "Action was not offered");
	const parameters: Record<string, string | boolean> = {};
	for (const [name, parameter] of Object.entries(spec.parameters ?? {})) {
		const value = answers[`${action}__${name}`];
		if (parameter.type === "choice") {
			if (value?.type !== "choice" || !Object.hasOwn(parameter.choices, value.choice))
				return refused(1, `Invalid parameter: ${name}`);
			parameters[name] = value.choice;
			weakest = Math.min(weakest, choiceConfidence(value));
		} else {
			if (
				value?.type !== "bool" ||
				!Number.isFinite(value.probability) ||
				value.probability < 0 ||
				value.probability > 1
			)
				return refused(1, `Invalid parameter: ${name}`);
			parameters[name] = value.probability >= 0.5;
			weakest = Math.min(weakest, Math.max(value.probability, 1 - value.probability));
		}
	}
	const threshold = thresholds[spec.risk];
	if (weakest < threshold) return refused(threshold, "Insufficient confidence");
	return { kind: "execute", action, parameters, weakest, threshold };
}

export interface DecisionTrace {
	observation: DecisionObservation;
	questions: Record<string, ClassifierQuestion>;
	answers: Record<string, ClassifierAnswer>;
	verdict: DecisionVerdict;
	result?: JsonObject;
	error?: string;
}

export interface DecisionEnvironment {
	observe(signal?: AbortSignal): Promise<DecisionObservation>;
	execute(action: string, parameters: Record<string, string | boolean>, signal?: AbortSignal): Promise<JsonObject>;
}

export interface DecisionRun {
	status: "completed" | "incomplete" | "failed" | "cancelled";
	reason: string;
	steps: DecisionTrace[];
	/** Full last decision for the reasoning agent or person taking over. */
	handoff?: DecisionTrace;
}

/** Enforce the deadline even when an adapter fails to settle on cancellation. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let onAbort: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([work, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Bounded observe → classify → gate → execute loop, independent of the classifier provider. */
export async function runDecisionLoop(options: {
	environment: DecisionEnvironment;
	decide: (context: ClassifierContext, signal?: AbortSignal) => Promise<ClassifierResult>;
	signal?: AbortSignal;
	thresholds?: DecisionThresholds;
	maxSteps?: number;
	timeoutMs?: number;
	maxRefusals?: number;
	onStep?: (trace: DecisionTrace) => void;
}): Promise<DecisionRun> {
	const maxSteps = options.maxSteps ?? 100;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const maxRefusals = options.maxRefusals ?? 3;
	if (
		!Number.isInteger(maxSteps) ||
		maxSteps < 1 ||
		!Number.isInteger(maxRefusals) ||
		maxRefusals < 1 ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0
	)
		throw new Error("Invalid loop limits");
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
		: AbortSignal.timeout(timeoutMs);
	const steps: DecisionTrace[] = [];
	let refusals = 0;
	let previous: string | undefined;
	const end = (status: DecisionRun["status"], reason: string): DecisionRun => ({
		status,
		reason,
		steps,
		...(status === "incomplete" && steps.length ? { handoff: steps.at(-1) } : {}),
	});
	const record = (trace: DecisionTrace) => {
		steps.push(trace);
		options.onStep?.(trace);
	};
	for (let step = 0; step < maxSteps; step++) {
		let trace: DecisionTrace | undefined;
		try {
			if (signal.aborted)
				return end(
					options.signal?.aborted ? "cancelled" : "incomplete",
					options.signal?.aborted ? "cancelled" : "timeout",
				);
			const observation = await abortable(options.environment.observe(signal), signal);
			const questions = compileDecision(observation);
			trace = { observation, questions, answers: {}, verdict: judgeDecision(observation, {}, options.thresholds) };
			const decision = await abortable(options.decide({ state: observation.state, questions }, signal), signal);
			trace = {
				observation,
				questions,
				answers: decision.answers,
				verdict: judgeDecision(observation, decision.answers, options.thresholds),
			};
			if (signal.aborted) {
				record(trace);
				return end(
					options.signal?.aborted ? "cancelled" : "incomplete",
					options.signal?.aborted ? "cancelled" : "timeout",
				);
			}
			if (decision.stopReason !== "stop") {
				trace.error = decision.errorMessage ?? decision.stopReason;
				record(trace);
				return end(decision.stopReason === "aborted" ? "cancelled" : "failed", "provider_error");
			}
			if (trace.verdict.kind === "finish") {
				record(trace);
				return end("completed", "goal_reached");
			}
			if (trace.verdict.kind === "escalate") {
				record(trace);
				return end("incomplete", "escalation_requested");
			}
			if (trace.verdict.kind === "refused") {
				record(trace);
				if (++refusals >= maxRefusals) return end("incomplete", "no_confident_action");
				continue;
			}
			refusals = 0;
			const signature = JSON.stringify([observation.state, trace.verdict.action, trace.verdict.parameters]);
			if (previous === signature) {
				record(trace);
				return end("incomplete", "repeated_action");
			}
			previous = signature;
			trace.result = await abortable(
				options.environment.execute(trace.verdict.action, trace.verdict.parameters, signal),
				signal,
			);
			record(trace);
		} catch (error) {
			if (trace && !steps.includes(trace)) {
				trace.error = error instanceof Error ? error.message : String(error);
				record(trace);
			}
			return end(
				signal.aborted ? (options.signal?.aborted ? "cancelled" : "incomplete") : "failed",
				signal.aborted ? (options.signal?.aborted ? "cancelled" : "timeout") : "decision_error",
			);
		}
	}
	return end("incomplete", "max_steps");
}
