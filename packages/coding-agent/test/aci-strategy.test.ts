import { describe, expect, it } from "vitest";
import { heuristicAssessment, type TaskAssessment } from "../src/extensions/laya/assessment.ts";
import { applyPolicy } from "../src/extensions/laya/policy.ts";
import { STRATEGIES, STRATEGY_RULES_VERSION, selectStrategy } from "../src/extensions/laya/strategy.ts";

const ALL_TOOLS = ["read", "edit", "write", "bash", "web_fetch", "execute_work"];
const MIN_CONFIDENCE = 0.5;

function assessment(overrides: {
	source?: TaskAssessment["source"];
	confidence?: number;
	task?: Partial<TaskAssessment["task"]>;
	tools?: Partial<TaskAssessment["tools"]>;
	securitySensitive?: boolean;
	validation?: TaskAssessment["validation"];
}): TaskAssessment {
	const base = heuristicAssessment("explain this function");
	const tools = Object.fromEntries(Object.keys(base.tools).map((id) => [id, false])) as TaskAssessment["tools"];
	return {
		...base,
		source: overrides.source ?? "laya",
		confidence: overrides.confidence ?? 0.95,
		task: {
			...base.task,
			type: "code_edit",
			complexity: 0.25,
			risk: 0.1,
			ambiguity: 0.1,
			scope: "single_file",
			...overrides.task,
		},
		tools: { ...tools, ...overrides.tools },
		securitySensitive: overrides.securitySensitive ?? false,
		validation: overrides.validation ?? base.validation,
	};
}

function decide(request: string, item: TaskAssessment, activeTools = ALL_TOOLS) {
	const policy = applyPolicy(item, request, { minConfidence: MIN_CONFIDENCE });
	return { decision: selectStrategy(request, item, policy, { activeTools }, MIN_CONFIDENCE), policy };
}

describe("cognitive strategy selector (rules v1)", () => {
	it("solves a simple, confident task directly", () => {
		const { decision } = decide("rename variable x to count", assessment({}));
		expect(decision).toMatchObject({ rulesVersion: STRATEGY_RULES_VERSION, strategy: "direct" });
		expect(decision.reasonCodes).toContain("simple_task");
		expect(decision.abstentions).toEqual([]);
	});

	it("decomposes a multi-step task and delegates it when the delegation tool is available", () => {
		const broad = assessment({ task: { scope: "repository", complexity: 0.9 } });
		expect(decide("migrate the whole repo to ESM", broad).decision.strategy).toBe("delegate");
		const withoutDelegation = decide(
			"migrate the whole repo to ESM",
			broad,
			ALL_TOOLS.filter((t) => t !== "execute_work"),
		).decision;
		expect(withoutDelegation.strategy).toBe("decompose");
		expect(withoutDelegation.abstentions).toEqual([{ strategy: "delegate", reason: "delegation_unavailable" }]);
	});

	it("uses tools only when they are active, and abstains otherwise", () => {
		const needsWeb = assessment({ tools: { requires_web: true } });
		expect(decide("check the latest release notes", needsWeb).decision.strategy).toBe("tool_assisted");
		const offline = decide("check the latest release notes", needsWeb, ["read", "edit", "bash"]).decision;
		expect(offline.strategy).toBe("direct");
		expect(offline.abstentions).toEqual([{ strategy: "tool_assisted", reason: "tools_unavailable:requires_web" }]);
	});

	it("plans, executes and verifies a change that needs test evidence, if it can write", () => {
		const change = assessment({ tools: { requires_write: true, requires_tests: true }, validation: "unit_test" });
		const { decision, policy } = decide("add input validation to the parser", change);
		expect(["unit_test", "integration_test", "review"]).toContain(policy.validation.level);
		expect(decision.strategy).toBe("plan_execute_verify");
		const readOnly = decide("add input validation to the parser", change, ["read", "bash"]).decision;
		expect(readOnly.abstentions.map((a) => a.strategy)).toContain("plan_execute_verify");
		expect(readOnly.strategy).not.toBe("plan_execute_verify");
	});

	it("sends sensitive high-risk work and ambiguous requests to human review", () => {
		const sensitive = assessment({ securitySensitive: true, task: { risk: 0.9 } });
		expect(decide("rotate the production signing keys", sensitive).decision).toMatchObject({
			strategy: "human_review",
			reasonCodes: expect.arrayContaining(["sensitive_high_risk"]),
		});
		expect(decide("make it better", assessment({ task: { ambiguity: 0.9 } })).decision).toMatchObject({
			strategy: "human_review",
			reasonCodes: expect.arrayContaining(["high_ambiguity"]),
		});
	});

	it("treats low confidence and truncated input by an explicit rule: human review, never a confident guess", () => {
		const unsure = decide("fix it", assessment({ confidence: 0.2 })).decision;
		expect(unsure).toMatchObject({
			strategy: "human_review",
			reasonCodes: expect.arrayContaining(["low_confidence"]),
		});

		const long = `${"refactor the module ".repeat(200)}`;
		const truncated = decide(long, assessment({ confidence: 0.99 })).decision;
		expect(truncated.evidence.truncated).toBe(true);
		expect(truncated.reasonCodes).toContain("request_truncated");
		expect(truncated.confidence).toBeLessThanOrEqual(MIN_CONFIDENCE);

		const rules = decide("rename x", assessment({ source: "heuristic" })).decision;
		expect(rules.reasonCodes).toContain("keyword_rules");
	});

	it("records structured evidence without the request text", () => {
		const secret = "deploy with token sk-live-1234567890";
		const { decision } = decide(secret, assessment({ tools: { requires_shell: true } }));
		expect(decision.evidence).toMatchObject({
			requiredTools: ["requires_shell"],
			requestChars: secret.length,
			truncated: false,
		});
		expect(JSON.stringify(decision)).not.toContain("sk-live");
	});

	it("only returns known strategies, never multi_candidate or escalate under rules v1, and grants nothing", () => {
		const scenarios = [
			assessment({}),
			assessment({ task: { scope: "repository", complexity: 0.9 } }),
			assessment({ tools: { requires_web: true, requires_browser: true, requires_database: true } }),
			assessment({ securitySensitive: true, task: { risk: 0.95 } }),
			assessment({ confidence: 0.1 }),
			assessment({ task: { type: "research" } }),
		];
		for (const item of scenarios) {
			const activeTools = ["read"];
			const { decision, policy } = decide("task", item, activeTools);
			expect(STRATEGIES).toContain(decision.strategy);
			expect(["multi_candidate", "escalate"]).not.toContain(decision.strategy);
			// The decision is advice: it has no field that could add a tool, model or permission.
			expect(Object.keys(decision).sort()).toEqual(
				["abstentions", "confidence", "evidence", "reasonCodes", "rulesVersion", "strategy"].sort(),
			);
			expect(activeTools).toEqual(["read"]);
			expect(policy.requiredTier).toBeDefined();
		}
	});
});
