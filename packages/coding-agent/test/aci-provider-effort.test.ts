import type { Api, Model } from "@relay-harness/ai";
import { getBuiltinModels } from "@relay-harness/ai/providers/all";
import { describe, expect, it } from "vitest";
import { reasoningControl } from "../src/extensions/laya/reasoning-control.ts";

function builtin(provider: "openai" | "anthropic", id: string): Model<Api> {
	const model = (getBuiltinModels(provider) as Model<Api>[]).find((candidate) => candidate.id === id);
	if (!model) throw new Error(`${provider}/${id} is not in the built-in catalog`);
	return model;
}

// Golden integration cases (ACI M1-F6-T07): the effort actually sent comes from each model's own catalog
// entry, so no parameter equivalence is assumed between vendors.
describe("provider effort resolution on the built-in catalog", () => {
	it.each([
		["openai", "gpt-6-luna", "high"],
		["openai", "gpt-6-sol", "medium"],
		["openai", "gpt-6-astra", "low"],
		["anthropic", "claude-opus-5-5", "high"],
		["anthropic", "claude-sonnet-5-5", "medium"],
	] as const)("%s/%s at %s is declared by the catalog and applied unchanged", (provider, id, level) => {
		expect(reasoningControl(builtin(provider, id), level)).toMatchObject({
			requested: level,
			applied: level,
			adjustment: "exact",
			evidence: "declared",
		});
	});

	it("records, instead of hiding, a level a model does not support (M1-F6-T08)", () => {
		// Astra declares no `off` and no `minimal`: the nearest supported level is used and the change is recorded.
		expect(reasoningControl(builtin("openai", "gpt-6-astra"), "minimal")).toMatchObject({
			applied: "low",
			adjustment: "raised",
			evidence: "declared",
		});
		expect(reasoningControl(builtin("openai", "gpt-6-astra"), "off")).toMatchObject({
			applied: "low",
			adjustment: "raised",
		});
		// Luna can turn reasoning off; Claude Opus cannot, so the same request differs by vendor.
		expect(reasoningControl(builtin("openai", "gpt-6-luna"), "off").applied).toBe("off");
		expect(reasoningControl(builtin("anthropic", "claude-opus-5-5"), "off")).toMatchObject({
			applied: "low",
			adjustment: "raised",
		});
	});

	it("marks levels of a model without a declared map as assumed, never as confirmed", () => {
		const haiku = builtin("anthropic", "claude-haiku-5-5");
		expect(haiku.thinkingLevelMap).toBeUndefined();
		expect(reasoningControl(haiku, "medium")).toMatchObject({ evidence: "assumed" });
		expect(reasoningControl(haiku, "xhigh").supported).not.toContain("xhigh");
	});
});
