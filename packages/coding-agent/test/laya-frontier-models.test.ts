import { describe, expect, it } from "vitest";
import {
	deriveModelRegistry,
	PerformanceHistory,
	QuotaManager,
	rankCandidates,
	type TierCatalogModel,
} from "../src/extensions/laya/policy.ts";
import { scopedModelRegistry } from "../src/extensions/laya/provider-scope.ts";
import { CAPABILITY_TIERS } from "../src/extensions/laya/questions.ts";

function priced(provider: string, id: string, input: number, output: number): TierCatalogModel {
	return { provider, id, cost: { input, output, cacheRead: 0, cacheWrite: 0 } };
}

const anthropic = [
	priced("anthropic", "claude-haiku-5-5", 1, 5),
	priced("anthropic", "claude-sonnet-5-5", 3, 15),
	priced("anthropic", "claude-opus-5-5", 5, 25),
];

describe("Laya tiers derived from catalog prices", () => {
	it("maps three price levels of a provider to fast, balanced and strong", () => {
		const registry = deriveModelRegistry(anthropic);
		expect(registry.fast).toEqual(["anthropic/claude-haiku-5-5"]);
		expect(registry.balanced).toEqual(["anthropic/claude-sonnet-5-5"]);
		expect(registry.strong).toEqual(["anthropic/claude-opus-5-5"]);
		expect(registry.frontier).toEqual([]);
	});

	it("adds frontier at a fourth price level", () => {
		const registry = deriveModelRegistry([...anthropic, priced("anthropic", "claude-next", 15, 75)]);
		expect(registry.frontier).toEqual(["anthropic/claude-next"]);
		expect(registry.strong).toEqual(["anthropic/claude-opus-5-5"]);
	});

	it("keeps models that share a price, such as effort variants, in one tier", () => {
		const registry = deriveModelRegistry([
			priced("google-antigravity", "gemini-flash-low", 0.3, 2.5),
			priced("google-antigravity", "gemini-flash-high", 0.3, 2.5),
			priced("google-antigravity", "gemini-pro-low", 1.25, 10),
			priced("google-antigravity", "gemini-pro-high", 1.25, 10),
			priced("google-antigravity", "claude-opus-low", 5, 25),
		]);
		expect(registry.fast).toEqual(["google-antigravity/gemini-flash-high", "google-antigravity/gemini-flash-low"]);
		expect(registry.balanced).toEqual(["google-antigravity/gemini-pro-high", "google-antigravity/gemini-pro-low"]);
		expect(registry.strong).toEqual(["google-antigravity/claude-opus-low"]);
	});

	it("derives each provider on its own price scale", () => {
		const registry = deriveModelRegistry([
			...anthropic,
			priced("cheap", "small", 0.01, 0.02),
			priced("cheap", "large", 0.5, 1),
		]);
		expect(registry.fast).toEqual(["anthropic/claude-haiku-5-5", "cheap/small"]);
		expect(registry.strong).toEqual(["anthropic/claude-opus-5-5", "cheap/large"]);
	});

	it("gives a provider with one price level no tiers", () => {
		const registry = deriveModelRegistry([priced("lmstudio", "qwen-7b", 0, 0), priced("lmstudio", "qwen-32b", 0, 0)]);
		expect(Object.values(registry).flat()).toEqual([]);
	});

	it("is deterministic regardless of catalog order", () => {
		expect(deriveModelRegistry([...anthropic].reverse())).toEqual(deriveModelRegistry(anthropic));
	});
});

describe("provider-scoped registry from the catalog", () => {
	const catalog = [
		...anthropic,
		priced("anthropic", "claude-fable-5-1", 15, 75),
		priced("openai", "mini", 0.4, 1.6),
		priced("openai", "main", 2, 8),
		priced("openai", "pro", 15, 60),
	];

	it("never counts or offers Fable, which is not an eligible model", () => {
		const { registry } = scopedModelRegistry(
			{ followProvider: true },
			{ provider: "anthropic", id: "claude-opus-5-5" },
			catalog,
		);
		expect(Object.values(registry).flat()).not.toContain("anthropic/claude-fable-5-1");
		expect(registry.frontier).toEqual([]);
		expect(registry.strong).toEqual(["anthropic/claude-opus-5-5"]);
	});

	it("retains the selected provider's derived tiers when local models were configured", () => {
		const settings = { followProvider: true, models: { fast: ["lmstudio/qwen-7b"] } };
		expect(
			scopedModelRegistry(settings, { provider: "anthropic", id: "claude-sonnet-5-5" }, catalog).registry.fast,
		).toEqual(["anthropic/claude-haiku-5-5"]);
	});

	it("keeps every provider's models when not following one", () => {
		const { registry } = scopedModelRegistry({}, undefined, catalog);
		expect(registry.fast).toEqual(["anthropic/claude-haiku-5-5", "openai/mini"]);
		expect(registry.strong).toEqual(["anthropic/claude-opus-5-5", "openai/pro"]);
	});

	it("does not leak cloud models into an explicitly mapped local group", () => {
		const { registry } = scopedModelRegistry(
			{
				followProvider: true,
				modelGroups: { "local-qwen": { balanced: ["lmstudio/qwen/qwen3.8-27b"] } },
			},
			{ provider: "lmstudio", id: "qwen/qwen3.8-27b" },
			catalog,
		);
		expect(registry.balanced).toEqual(["lmstudio/qwen/qwen3.8-27b"]);
		expect(registry.frontier).toEqual([]);
	});

	it.each(["fast", "balanced", "strong"] as const)(
		"can route a %s task using only one provider's credentials",
		(requiredTier) => {
			const { registry } = scopedModelRegistry({ followProvider: false }, undefined, anthropic);
			const candidates = CAPABILITY_TIERS.flatMap((tier) =>
				(registry[tier] ?? []).map((ref, order) => ({ ref, provider: "anthropic", tier, order })),
			);
			const ranked = rankCandidates(candidates, {
				requiredTier,
				minTier: "fast",
				risk: 0,
				profile: "balanced",
				taskKey: "bug_fix:1",
				history: new PerformanceHistory(),
				quota: new QuotaManager(),
			});
			expect(ranked[0].tier).toBe(requiredTier);
			expect(ranked[0].provider).toBe("anthropic");
		},
	);

	it("keeps user-defined tier overrides and group boundaries", () => {
		const overridden = scopedModelRegistry({ models: { balanced: ["custom/model"] } }, undefined, catalog);
		expect(overridden.registry.balanced).toEqual(["custom/model"]);
		const grouped = scopedModelRegistry(
			{
				followProvider: true,
				modelGroups: {
					"antigravity-claude": {
						balanced: ["google-antigravity/claude-sonnet-5-5"],
						strong: ["google-antigravity/claude-opus-5-5"],
					},
				},
			},
			{ provider: "google-antigravity", id: "claude-sonnet-5-5" },
			catalog,
		);
		expect(grouped.registry.fast).toEqual([]);
		expect(grouped.registry.balanced).toEqual(["google-antigravity/claude-sonnet-5-5"]);
	});
});
