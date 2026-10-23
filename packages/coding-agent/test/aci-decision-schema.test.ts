import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClassifierAnswer } from "@relay-harness/ai";
import { describe, expect, it } from "vitest";
import { assessmentFromAnswers, heuristicAssessment } from "../src/extensions/laya/assessment.ts";
import {
	assertDecisionSchema,
	assessmentDivergence,
	decisionRecord,
	decisionSchemaErrors,
	decisionSchemaSha256,
} from "../src/extensions/laya/decision-schema.ts";
import type { LayaAnswer } from "../src/extensions/laya/native-onnx.ts";
import { LAYA_NATIVE_MANIFEST } from "../src/extensions/laya/native-runtime.ts";
import { toClassifierAnswers } from "../src/extensions/laya/onnx-server.ts";
import { applyPolicy } from "../src/extensions/laya/policy.ts";
import { LAYA_QUESTIONS } from "../src/extensions/laya/questions.ts";

const reference = JSON.parse(readFileSync(join(__dirname, "fixtures", "aci-laya-parity-reference.json"), "utf8")) as {
	cases: Array<{ id: string; request: string; answers: Record<string, LayaAnswer> }>;
};
const valid = () => toClassifierAnswers(reference.cases[0]?.answers ?? {});

const EXPECTED_DECISIONS = [
	"task_type",
	"complexity",
	"scope",
	"risk",
	"ambiguity",
	"reasoning_requirement",
	"capability_tier",
	"reasoning_effort",
	"agent",
	"validation_level",
	"requires_write",
	"requires_shell",
	"requires_tests",
	"requires_web",
	"requires_browser",
	"requires_database",
	"requires_git",
	"security_sensitive",
	"library_category",
];

describe("Laya decision schema v1", () => {
	it("maps exactly the 19 decisions the pinned checkpoint answers", () => {
		expect(Object.keys(LAYA_QUESTIONS).sort()).toEqual([...EXPECTED_DECISIONS].sort());
		for (const item of reference.cases)
			expect(Object.keys(item.answers).sort()).toEqual([...EXPECTED_DECISIONS].sort());
	});

	it("is pinned to the question schema the native checkpoint was verified with", () => {
		expect(decisionSchemaSha256()).toBe(LAYA_NATIVE_MANIFEST.schemaSha256);
	});

	it("accepts every reference answer set", () => {
		for (const item of reference.cases) expect(decisionSchemaErrors(toClassifierAnswers(item.answers))).toEqual([]);
	});

	it("rejects missing, mistyped, out-of-domain and unknown answers", () => {
		const answers: Record<string, ClassifierAnswer> = { ...valid() };
		delete answers.scope;
		answers.task_type = { type: "choice", choice: "poetry", probabilities: { poetry: 1 }, confidence: 1 };
		answers.complexity = { type: "score", score: 9, confidence: 0.5 };
		answers.requires_git = { type: "bool", probability: 1.5 };
		answers.agent = { type: "bool", probability: 0.5 };
		answers.extra = { type: "bool", probability: 0.5 };
		const errors = decisionSchemaErrors(answers);
		expect(errors).toEqual(
			expect.arrayContaining([
				"scope: missing",
				'task_type: "poetry" is not an option',
				'task_type: probability for unknown option "poetry"',
				"complexity: score 9 is outside 0..4",
				"requires_git: probability 1.5 is outside 0..1",
				"agent: expected choice, got bool",
				"extra: not a v1 question",
			]),
		);
		expect(() => assertDecisionSchema(answers)).toThrow(/laya-decisions-v1/);
		expect(() => assertDecisionSchema(valid())).not.toThrow();
	});

	it("does not tie capability tiers to provider names", () => {
		const tiers = Object.keys(
			LAYA_QUESTIONS.capability_tier?.type === "choice" ? LAYA_QUESTIONS.capability_tier.criteria : {},
		);
		expect(tiers).toEqual(["fast", "balanced", "strong", "frontier"]);
		const text = JSON.stringify(LAYA_QUESTIONS.capability_tier).toLowerCase();
		for (const provider of ["openai", "anthropic", "claude", "gpt", "gemini", "google", "mistral", "llama"])
			expect(text).not.toContain(provider);
	});
});

describe("suggested versus applied decision", () => {
	it("keeps the classifier suggestion separate from what the policy applies, with reason codes", () => {
		const assessment = assessmentFromAnswers(valid());
		const request = reference.cases[0]?.request ?? "";
		// This case is answered with 0.9963 confidence; requiring 1 forces the low-confidence escalation.
		expect(assessment.confidence).toBeLessThan(1);
		const policy = applyPolicy(assessment, request, { minConfidence: 1 });
		const record = decisionRecord(assessment, policy);
		expect(record).toMatchObject({
			schemaVersion: "laya-decisions-v1",
			source: "laya",
			suggestedTier: assessment.recommendation.tier,
			suggestedEffort: assessment.recommendation.effort,
			classifierConfidence: assessment.confidence,
			effectiveTier: policy.requiredTier,
			effectiveEffort: policy.effort,
		});
		// The required confidence is not met, so the policy escalates and says why.
		expect(record.decisionReasonCodes).toContain("insufficient_confidence");
		expect(record.effectiveTier).not.toBe(record.suggestedTier);
	});

	it("reports where Laya and the keyword fallback disagree without treating confidence as quality", () => {
		const divergences = reference.cases.map((item) => {
			const laya = assessmentFromAnswers(toClassifierAnswers(item.answers));
			return { laya, fields: assessmentDivergence(laya, heuristicAssessment(item.request)) };
		});
		expect(divergences.some(({ fields }) => fields.length > 0)).toBe(true);
		for (const { laya, fields } of divergences) {
			expect(fields.every((field) => typeof field === "string")).toBe(true);
			expect(assessmentDivergence(laya, laya)).toEqual([]);
		}
	});
});
