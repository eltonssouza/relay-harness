import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heuristicAssessment } from "../src/extensions/laya/assessment.ts";
import { applyPolicy } from "../src/extensions/laya/policy.ts";

// Adaptive Cognitive Intelligence (ACI) phase 0 baseline: the existing Laya decider must keep
// producing these task → tier → effort → justification decisions until a reviewed change updates them.
interface GoldenCase {
	request: string;
	expected: {
		type: string;
		requiredTier: string;
		minTier: string;
		effort: string;
		thinkingLevel: string;
		validation: string;
		rules: string[];
		escalations: string[];
	};
}

const golden = JSON.parse(readFileSync(join(__dirname, "fixtures", "aci-golden-decisions.json"), "utf8")) as {
	cases: GoldenCase[];
};

describe("ACI golden decisions (heuristic path, balanced profile)", () => {
	it.each(golden.cases)("$request", ({ request, expected }) => {
		const assessment = heuristicAssessment(request);
		const policy = applyPolicy(assessment, request, { minConfidence: 0.6 });
		expect({
			type: assessment.task.type,
			requiredTier: policy.requiredTier,
			minTier: policy.minTier,
			effort: policy.effort,
			thinkingLevel: policy.thinkingLevel,
			validation: policy.validation.level,
			rules: policy.rules,
			escalations: policy.escalations,
		}).toEqual(expected);
	});
});
