import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	alignmentMetrics,
	authorizationMetrics,
	completionMetrics,
	constraintMetrics,
	contextMetrics,
	declaredVerificationMetrics,
	formatReport,
	intentMetrics,
	openCases,
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

	it("authorizes only what the developer's request or answer authorizes", async () => {
		const metrics = await alignmentMetrics();
		expect(metrics.falseAllows).toEqual([]);
		expect(metrics.falseBlocks).toEqual([]);
	});

	it("counts no look-alike as a check and recognizes the common ones", () => {
		const metrics = verificationMetrics();
		expect(metrics.falseChecks).toEqual([]);
		expect(metrics.missedChecks).toEqual([]);
	});

	it("counts only the declared commands when the project declares them", () => {
		const metrics = declaredVerificationMetrics();
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

	it("records the standing rules a message states and nothing else", () => {
		expect(constraintMetrics().wrong).toEqual([]);
	});

	it("still reproduces every open finding", async () => {
		const fixed = (await openCases())
			.filter((item) => !item.reproduces)
			.map((item) => `${item.finding}: ${item.label}`);
		// A fix that makes an open case pass also removes its `open` field from corpus.json, so the floors cover it.
		expect(fixed).toEqual([]);
	});

	it("keeps a recorded session smaller and its cached prefix stable", () => {
		const metrics = contextMetrics(sessionFile);
		expect(metrics.reduction).toBeGreaterThanOrEqual(0.4);
		// Elision in batches rewrites cached messages far less often than eliding one result at a time.
		expect(metrics.cacheBreaksBatched).toBeLessThan(metrics.cacheBreaksOneByOne / 2);
		// The harness state restated on every request rewrites nothing the provider cached.
		expect(metrics.cacheBreaksWithState).toBe(metrics.cacheBreaksBatched);
	});

	it("reports every measure", async () => {
		const report = await formatReport(sessionFile);
		for (const heading of [
			"Authorization",
			"Alignment",
			"Verification",
			"Completion gate",
			"Intent",
			"Constraints",
			"Context",
			"Open findings",
		]) {
			expect(report).toContain(heading);
		}
	});
});
