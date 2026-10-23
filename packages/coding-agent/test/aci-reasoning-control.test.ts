import type { Api, Model } from "@relay-harness/ai";
import { describe, expect, it } from "vitest";
import { reasoningControl } from "../src/extensions/laya/reasoning-control.ts";

function model(overrides: Partial<Model<Api>>): Model<Api> {
	return {
		id: "local-model",
		name: "Local model",
		api: "openai-completions",
		provider: "local",
		baseUrl: "http://127.0.0.1:1234/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4_000,
		...overrides,
	} as Model<Api>;
}

describe("reasoningControl", () => {
	it("sends no reasoning effort to a model the catalog marks as non-reasoning", () => {
		expect(reasoningControl(model({ reasoning: false }), "high")).toEqual({
			requested: "high",
			applied: "off",
			supported: ["off"],
			adjustment: "unsupported",
			evidence: "none",
		});
	});

	it("reports standard levels on an unmapped reasoning model as assumed, not confirmed", () => {
		const control = reasoningControl(model({ reasoning: true }), "high");
		expect(control).toMatchObject({ applied: "high", adjustment: "exact", evidence: "assumed" });
		expect(control.supported).not.toContain("xhigh");
	});

	it("clamps to the nearest declared level and says in which direction", () => {
		// Standard levels count as supported unless the catalog marks them null; xhigh/max need an explicit entry.
		const declared = model({ reasoning: true, thinkingLevelMap: { minimal: null, medium: null } });
		expect(reasoningControl(declared, "medium")).toMatchObject({
			applied: "high",
			adjustment: "raised",
			evidence: "declared",
		});
		expect(reasoningControl(declared, "minimal")).toMatchObject({ applied: "low", adjustment: "raised" });
		expect(reasoningControl(declared, "xhigh")).toMatchObject({ applied: "high", adjustment: "lowered" });
		expect(reasoningControl(declared, "low")).toMatchObject({ applied: "low", adjustment: "exact" });
	});

	it("only offers extended levels the catalog declares", () => {
		const extended = model({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } });
		expect(reasoningControl(extended, "xhigh")).toMatchObject({ applied: "xhigh", adjustment: "exact" });
		expect(reasoningControl(extended, "max").applied).toBe("xhigh");
	});
});
