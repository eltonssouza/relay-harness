import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODEL_REGISTRY,
	PerformanceHistory,
	QuotaManager,
	rankCandidates,
} from "../src/extensions/laya/policy.ts";
import { scopedModelRegistry } from "../src/extensions/laya/provider-scope.ts";
import { CAPABILITY_TIERS, type CapabilityTier } from "../src/extensions/laya/questions.ts";

describe("Laya frontier models", () => {
	it("retains Astra and Sol within the selected Codex provider", () => {
		const { registry } = scopedModelRegistry(
			{ followProvider: true },
			{ provider: "openai-codex", id: "gpt-6-astra" },
		);
		expect(registry.frontier).toEqual(["openai-codex/gpt-6.1-sol", "openai-codex/gpt-6-astra"]);
	});

	it("retains both Fable generations within the selected Anthropic provider", () => {
		const { registry } = scopedModelRegistry(
			{ followProvider: true },
			{ provider: "anthropic", id: "claude-fable-5" },
		);
		expect(registry.frontier).toEqual(["anthropic/claude-fable-5-1", "anthropic/claude-fable-5"]);
	});

	it("does not leak cloud models into an explicitly mapped local group", () => {
		const { registry } = scopedModelRegistry(
			{
				followProvider: true,
				modelGroups: { "local-qwen": { balanced: ["lmstudio/qwen/qwen3.8-27b"] } },
			},
			{ provider: "lmstudio", id: "qwen/qwen3.8-27b" },
		);
		expect(registry.balanced).toEqual(["lmstudio/qwen/qwen3.8-27b"]);
		expect(registry.frontier).toEqual([]);
	});

	it("maps all seven Antigravity model families to explicit capability tiers", () => {
		const { registry, scope } = scopedModelRegistry(
			{ followProvider: true },
			{ provider: "google-antigravity", id: "gemini-3.8-flash" },
		);
		expect(scope).toBe("google-antigravity");
		expect(registry.fast).toContain("google-antigravity/gemini-3.7-flash");
		expect(registry.fast).toContain("google-antigravity/gemini-3.6-flash");
		expect(registry.balanced).toContain("google-antigravity/gemini-3.8-flash");
		expect(registry.balanced).toContain("google-antigravity/claude-sonnet-5-5");
		expect(registry.balanced).toContain("google-antigravity/gpt-oss-120b-medium");
		expect(registry.strong).toContain("google-antigravity/claude-opus-5-5");
		expect(registry.strong).toContain("google-antigravity/gemini-3.1-pro");
		expect(registry.frontier).toEqual([]);
		expect(
			Object.values(registry)
				.flat()
				.every((ref) => ref.startsWith("google-antigravity/")),
		).toBe(true);
	});

	it.each([
		["fast", "gemini-3.7-flash", ["low", "medium", "high"]],
		["fast", "gemini-3.6-flash", ["low", "medium", "high"]],
		["balanced", "gemini-3.8-flash", ["low", "medium", "high"]],
		["balanced", "claude-sonnet-5-5", ["low", "medium", "high"]],
		["strong", "claude-opus-5-5", ["low", "medium", "high"]],
		["strong", "gemini-3.1-pro", ["low", "high"]],
	] as const)("recognizes %s variants of %s in provider-following mode", (tier, id, efforts) => {
		for (const effort of efforts) {
			const modelId = `${id}-${effort}`;
			const { registry } = scopedModelRegistry(
				{ followProvider: true },
				{ provider: "google-antigravity", id: modelId },
			);
			expect(registry[tier]).toContain(`google-antigravity/${modelId}`);
		}
	});

	it.each(["fast", "balanced", "strong"] as const)(
		"can route a %s task using only Antigravity credentials",
		(requiredTier) => {
			const { registry } = scopedModelRegistry({ followProvider: false });
			const candidates = CAPABILITY_TIERS.flatMap((tier) =>
				(registry[tier] ?? [])
					.filter((ref) => ref.startsWith("google-antigravity/"))
					.map((ref, order) => ({ ref, provider: "google-antigravity", tier, order })),
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
			expect(ranked[0].provider).toBe("google-antigravity");
		},
	);

	it("keeps user-defined tier overrides and Antigravity group boundaries", () => {
		const overridden = scopedModelRegistry({ models: { balanced: ["custom/model"] } });
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
		);
		expect(grouped.registry.fast).toEqual([]);
		expect(grouped.registry.balanced).toEqual(["google-antigravity/claude-sonnet-5-5"]);
	});

	it("registers each Antigravity model in only one tier", () => {
		const refs = Object.values(DEFAULT_MODEL_REGISTRY)
			.flat()
			.filter((ref) => ref.startsWith("google-antigravity/"));
		expect(new Set(refs).size).toBe(refs.length);
		for (const tier of ["fast", "balanced", "strong"] satisfies CapabilityTier[]) {
			expect(DEFAULT_MODEL_REGISTRY[tier].some((ref) => ref.startsWith("google-antigravity/"))).toBe(true);
		}
	});
});
