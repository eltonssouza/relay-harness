import { createHash } from "node:crypto";
import type { ClassifierAnswer } from "@relay-harness/ai";
import type { TaskAssessment } from "./assessment.ts";
import type { PolicyDecision } from "./policy.ts";
import { LAYA_QUESTIONS, layaDecisionsFile } from "./questions.ts";

/**
 * Decision schema v1 (ACI phase 2): the 19 Laya questions as published with the pinned checkpoint.
 * Answers are validated against it before routing uses them, and the schema hash is pinned so a
 * question change cannot silently pair with a checkpoint trained on another schema.
 */
export const LAYA_DECISION_SCHEMA_VERSION = "laya-decisions-v1";

/** SHA-256 of the wire questions (`layaDecisionsFile().decisions`), as the parity reference used. */
export function decisionSchemaSha256(): string {
	return createHash("sha256").update(JSON.stringify(layaDecisionsFile().decisions)).digest("hex");
}

function unit(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Every problem with a classifier result: missing answers, wrong types and out-of-domain values. */
export function decisionSchemaErrors(answers: Record<string, ClassifierAnswer>): string[] {
	const errors: string[] = [];
	for (const [id, question] of Object.entries(LAYA_QUESTIONS)) {
		const answer = answers[id];
		if (!answer) {
			errors.push(`${id}: missing`);
			continue;
		}
		if (answer.type !== question.type) {
			errors.push(`${id}: expected ${question.type}, got ${answer.type}`);
			continue;
		}
		if (answer.type === "choice") {
			const options = Object.keys(question.criteria ?? {});
			if (!options.includes(answer.choice)) errors.push(`${id}: ${JSON.stringify(answer.choice)} is not an option`);
			if (!unit(answer.confidence)) errors.push(`${id}: confidence ${answer.confidence} is outside 0..1`);
			for (const [option, probability] of Object.entries(answer.probabilities)) {
				if (!options.includes(option))
					errors.push(`${id}: probability for unknown option ${JSON.stringify(option)}`);
				else if (!unit(probability)) errors.push(`${id}: probability ${probability} for ${option} is outside 0..1`);
			}
		} else if (answer.type === "score") {
			const levels = Array.isArray(question.criteria) ? question.criteria.length : 0;
			if (!(Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= levels - 1))
				errors.push(`${id}: score ${answer.score} is outside 0..${levels - 1}`);
			if (!unit(answer.confidence)) errors.push(`${id}: confidence ${answer.confidence} is outside 0..1`);
		} else if (!unit(answer.probability)) {
			errors.push(`${id}: probability ${answer.probability} is outside 0..1`);
		}
	}
	for (const id of Object.keys(answers)) if (!(id in LAYA_QUESTIONS)) errors.push(`${id}: not a v1 question`);
	return errors;
}

/** Throws with every schema problem, so the caller falls back instead of routing on a bad answer. */
export function assertDecisionSchema(answers: Record<string, ClassifierAnswer>): void {
	const errors = decisionSchemaErrors(answers);
	if (errors.length > 0)
		throw new Error(`Laya answers do not match ${LAYA_DECISION_SCHEMA_VERSION}: ${errors.slice(0, 5).join("; ")}`);
}

/**
 * What the classifier suggested, next to what the policy decided to apply, with the reasons.
 * The classifier's confidence is its certainty about the labels, not a guarantee of execution quality.
 */
export interface DecisionRecord {
	schemaVersion: typeof LAYA_DECISION_SCHEMA_VERSION;
	source: TaskAssessment["source"];
	suggestedTier: TaskAssessment["recommendation"]["tier"];
	suggestedEffort: TaskAssessment["recommendation"]["effort"];
	classifierConfidence: number;
	effectiveTier: PolicyDecision["requiredTier"];
	effectiveEffort: PolicyDecision["effort"];
	effectiveThinkingLevel: PolicyDecision["thinkingLevel"];
	decisionReasonCodes: string[];
}

export function decisionRecord(assessment: TaskAssessment, policy: PolicyDecision): DecisionRecord {
	return {
		schemaVersion: LAYA_DECISION_SCHEMA_VERSION,
		source: assessment.source,
		suggestedTier: assessment.recommendation.tier,
		suggestedEffort: assessment.recommendation.effort,
		classifierConfidence: assessment.confidence,
		effectiveTier: policy.requiredTier,
		effectiveEffort: policy.effort,
		effectiveThinkingLevel: policy.thinkingLevel,
		decisionReasonCodes: [...policy.rules, ...policy.escalations],
	};
}

/** Routing-relevant fields where two assessments disagree (e.g. Laya versus the keyword fallback). */
export function assessmentDivergence(a: TaskAssessment, b: TaskAssessment): string[] {
	const fields: Array<[string, unknown, unknown]> = [
		["task.type", a.task.type, b.task.type],
		["task.scope", a.task.scope, b.task.scope],
		["recommendation.tier", a.recommendation.tier, b.recommendation.tier],
		["recommendation.effort", a.recommendation.effort, b.recommendation.effort],
		["agent", a.agent, b.agent],
		["validation", a.validation, b.validation],
		["securitySensitive", a.securitySensitive, b.securitySensitive],
		...Object.keys(a.tools).map((tool): [string, unknown, unknown] => [
			`tools.${tool}`,
			a.tools[tool as keyof TaskAssessment["tools"]],
			b.tools[tool as keyof TaskAssessment["tools"]],
		]),
	];
	return fields.filter(([, left, right]) => left !== right).map(([name]) => name);
}
