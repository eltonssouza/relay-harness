import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	authorizationMetrics,
	completionMetrics,
	contextMetrics,
	formatReport,
	intentMetrics,
	verificationMetrics,
} from "./bench.ts";

const sessionFile = fileURLToPath(new URL("../fixtures/large-session.jsonl", import.meta.url));

/**
 * Thresholds are floors the pillars must keep. Raising one is a decision to make with the report
 * in hand (`npm run bench:harness`); lowering one needs a reason in the commit.
 */
describe("harness benchmark", () => {
	it("lets no risky command through and rarely asks about safe ones", () => {
		const metrics = authorizationMetrics();
		expect(metrics.falseAllows).toEqual([]);
		expect(metrics.falsePrompts.length / metrics.safe).toBeLessThanOrEqual(0.05);
	});

	it("counts no look-alike as a check and recognizes the common ones", () => {
		const metrics = verificationMetrics();
		expect(metrics.falseChecks).toEqual([]);
		expect(metrics.missedChecks).toEqual([]);
	});

	it("accepts no unverified work and rarely flags verified work", () => {
		const metrics = completionMetrics();
		expect(metrics.falseSuccesses).toEqual([]);
		expect(metrics.falseGates.length / metrics.scenarios).toBeLessThanOrEqual(0.05);
	});

	it("judges intent correctly on at least nine in ten cases", () => {
		const metrics = intentMetrics();
		expect(metrics.wrong.length / metrics.cases).toBeLessThanOrEqual(0.1);
	});

	it("keeps a recorded session smaller and its cached prefix stable", () => {
		const metrics = contextMetrics(sessionFile);
		expect(metrics.reduction).toBeGreaterThanOrEqual(0.4);
		// Elision in batches rewrites cached messages far less often than eliding one result at a time.
		expect(metrics.cacheBreaksBatched).toBeLessThan(metrics.cacheBreaksOneByOne / 2);
	});

	it("reports every measure", () => {
		const report = formatReport(sessionFile);
		for (const heading of ["Authorization", "Verification", "Completion gate", "Intent", "Context"]) {
			expect(report).toContain(heading);
		}
	});
});
