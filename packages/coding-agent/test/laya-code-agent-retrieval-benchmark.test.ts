import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyToolRetrievalOutcome, retrieveTools } from "../src/extensions/laya/tool-retrieval.ts";

interface BenchmarkCase {
	id: number;
	prompt: string;
	expected: string[];
	outcome: "answer" | "approval" | "clarify" | "refuse" | "tools";
	challenge: string;
}

const fixturePath = join(
	fileURLToPath(new URL(".", import.meta.url)),
	"fixtures",
	"laya-code-agent-retrieval-cases.json",
);
const cases: BenchmarkCase[] = JSON.parse(readFileSync(fixturePath, "utf8"));
const toolCatalog = [
	{
		name: "bash",
		label: "Run commands and tests",
		description: "Execute shell commands, scripts, tests, builds, and migrations",
	},
	{
		name: "browser",
		label: "Inspect browser",
		description: "Open pages, inspect web applications and browser console",
	},
	{
		name: "read",
		label: "Read files",
		description: "Open and read source files, configuration, documentation, and fixtures",
	},
	{
		name: "search",
		label: "Search repository",
		description: "Find code, symbols, files, history, and project documentation",
	},
	{
		name: "write",
		label: "Edit files",
		description: "Create, implement, modify, and write source code, tests, README, and changelog",
	},
];
const codeAgentTools = new Set(toolCatalog.map((tool) => tool.name));

describe("Laya Code Agent retrieval benchmark", () => {
	it("contains the 33 adapted and labeled scenarios", () => {
		expect(cases).toHaveLength(33);
		expect(cases.map((testCase) => testCase.id)).toEqual(Array.from({ length: 33 }, (_, index) => index + 1));
		for (const testCase of cases) {
			expect(testCase.prompt.length).toBeGreaterThan(0);
			expect(testCase.challenge.length).toBeGreaterThan(0);
			expect(testCase.expected.every((tool) => codeAgentTools.has(tool))).toBe(true);
			if (["answer", "refuse"].includes(testCase.outcome)) expect(testCase.expected).toEqual([]);
		}
	});

	it("classifies answer, clarification, refusal, and approval outcomes", () => {
		const expected = new Map([
			[4, "answer"],
			[6, "refuse"],
			[7, "clarify"],
			[13, "approval"],
			[28, "answer"],
			[30, "approval"],
			[31, "clarify"],
		]);
		for (const testCase of cases) {
			const outcome = expected.get(testCase.id);
			if (outcome) expect(classifyToolRetrievalOutcome(testCase.prompt)).toBe(outcome);
		}
	});

	it("runs all 33 prompts through the production lexical retriever and reports metrics", () => {
		const metrics = {
			truePositive: 0,
			falsePositive: 0,
			falseNegative: 0,
			trueNegative: 0,
			toolCases: 0,
			noToolCases: 0,
			selectedTools: new Set<string>(),
			byChallenge: new Map<string, { total: number; exact: number }>(),
			mismatches: [] as Array<{ id: number; expected: string[]; actual: string[]; outcome: string }>,
		};
		for (const testCase of cases) {
			const limit = Math.max(testCase.expected.length, 1);
			const selected = retrieveTools(testCase.prompt, toolCatalog, limit);
			const expected = new Set(testCase.expected);
			const actual = new Set(selected);
			metrics.toolCases += expected.size > 0 ? 1 : 0;
			metrics.noToolCases += expected.size === 0 ? 1 : 0;
			for (const tool of codeAgentTools) {
				if (expected.has(tool) && actual.has(tool)) metrics.truePositive++;
				else if (actual.has(tool)) metrics.falsePositive++;
				else if (expected.has(tool)) metrics.falseNegative++;
				else metrics.trueNegative++;
			}
			for (const tool of selected) metrics.selectedTools.add(tool);
			const byChallenge = metrics.byChallenge.get(testCase.challenge) ?? { total: 0, exact: 0 };
			byChallenge.total++;
			if (expected.size === actual.size && [...expected].every((tool) => actual.has(tool))) byChallenge.exact++;
			metrics.byChallenge.set(testCase.challenge, byChallenge);
			if (expected.size !== actual.size || [...expected].some((tool) => !actual.has(tool))) {
				metrics.mismatches.push({
					id: testCase.id,
					expected: [...expected],
					actual: [...actual],
					outcome: testCase.outcome,
				});
			}
		}
		const precision = metrics.truePositive / (metrics.truePositive + metrics.falsePositive || 1);
		const recall = metrics.truePositive / (metrics.truePositive + metrics.falseNegative || 1);
		const exactMatch = [...metrics.byChallenge.values()].reduce((sum, group) => sum + group.exact, 0);
		console.info("Laya retrieval benchmark:", {
			prompts: cases.length,
			toolCases: metrics.toolCases,
			noToolCases: metrics.noToolCases,
			precision: Number(precision.toFixed(3)),
			recall: Number(recall.toFixed(3)),
			exactMatch: `${exactMatch}/${cases.length}`,
			selectedTools: [...metrics.selectedTools].sort(),
			falsePositivesOnNoToolPrompts: metrics.mismatches.filter(
				(mismatch) => mismatch.outcome !== "tools" && mismatch.expected.length === 0 && mismatch.actual.length > 0,
			),
			mismatches: metrics.mismatches,
			byChallenge: Object.fromEntries(metrics.byChallenge),
		});
		expect(cases).toHaveLength(33);
		expect(precision).toBeGreaterThanOrEqual(0.9);
		expect(recall).toBeGreaterThanOrEqual(0.8);
		expect(exactMatch / cases.length).toBeGreaterThanOrEqual(0.7);
		expect(
			metrics.mismatches.filter(
				(mismatch) => mismatch.outcome !== "tools" && mismatch.expected.length === 0 && mismatch.actual.length > 0,
			),
		).toEqual([]);
	});
});
