import { describe, expect, it } from "vitest";
import { applyXpAction, type XpEvidence, type XpState, xpObservation } from "../src/extensions/xp/workflow.ts";

const state = (): XpState => ({
	version: 1,
	id: "run",
	goal: "Fix discount",
	phase: "planning",
	status: "active",
	steps: 0,
	refusals: 0,
	revision: 1,
	accepted: false,
	testsRequired: true,
	evidence: [],
});
const proof = (isError: boolean): XpEvidence => ({
	id: "test-1",
	tool: "bash",
	command: "node --test test/discount.test.ts",
	isError,
	text: isError ? "AssertionError: expected 20, received 30" : "tests 1, pass 1, fail 0",
	revision: 1,
});

describe("XP phase evidence", () => {
	it("withholds Coding until an observed behavioral failure exists", () => {
		const current = { ...state(), phase: "testing" as const, evidence: [proof(true)] };
		expect(xpObservation(current, "Fails on the boundary", []).actions.advance).toBeUndefined();
		expect(xpObservation(current, "Fails on the boundary", ["test-1"]).actions.advance).toBeDefined();
		current.revision++;
		expect(xpObservation(current, "Fails on the boundary", ["test-1"]).actions.advance).toBeUndefined();
		current.revision--;
		current.evidence[0].text = "SyntaxError: expected a token";
		expect(xpObservation(current, "Fails", ["test-1"]).actions.advance).toBeUndefined();
	});
	it("rejects invented evidence and unrelated successful commands", () => {
		expect(() => xpObservation(state(), "Done", ["invented"])).toThrow("observed");
		const current = { ...state(), phase: "coding" as const, evidence: [{ ...proof(false), command: "echo passed" }] };
		expect(xpObservation(current, "Done", ["test-1"]).actions.advance).toBeUndefined();
	});
	it("invalidates green evidence after mutations and requires user acceptance", () => {
		const current = { ...state(), phase: "listening" as const, evidence: [proof(false)] };
		expect(xpObservation(current, "Done", ["test-1"]).goalReached).toBe(false);
		current.accepted = true;
		expect(xpObservation(current, "Done", ["test-1"]).goalReached).toBe(true);
		current.revision++;
		expect(xpObservation(current, "Done", ["test-1"]).goalReached).toBe(false);
	});
	it("advances in order and clears acceptance on replanning", () => {
		const current = state();
		for (const phase of ["design", "testing", "coding", "listening"]) {
			applyXpAction(current, "advance");
			expect(current.phase).toBe(phase);
		}
		current.accepted = true;
		applyXpAction(current, "replan");
		expect(current).toMatchObject({ phase: "planning", accepted: false, revision: 2 });
	});
});
