/**
 * Capability tiers of models: `fast`, `balanced`, `strong` and `frontier`. Agent definitions name
 * a tier instead of a model (`model: haiku` means "a fast model"), so the same definition runs on
 * any provider. A tier resolves to the `modelTiers` setting when it names an available model,
 * otherwise to a model of the session's provider derived from catalog prices.
 */

import type { Api, Model } from "@relay-harness/ai";
import { isEligibleChatModel } from "./model-eligibility.ts";

export const CAPABILITY_TIERS = ["fast", "balanced", "strong", "frontier"] as const;
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

/** Models per tier as `provider/model`, in preference order. */
export type ModelTiers = Partial<Record<CapabilityTier, string[]>>;

/** The catalog fields tier derivation reads. */
export type TierCatalogModel = Pick<Model<Api>, "provider" | "id" | "cost">;

/**
 * Models per tier as `provider/model`, derived from catalog prices instead of a hand-kept list.
 * Within each provider, models are ordered by output price, then input price, and a price level
 * maps to a tier by its position among the provider's distinct levels: three levels give fast,
 * balanced and strong; a fourth adds frontier. Models that share a price, such as the effort
 * variants of one model, share a tier. A provider with a single price level carries no capability
 * signal and gets no tiers.
 */
export function deriveModelTiers(models: readonly TierCatalogModel[]): Record<CapabilityTier, string[]> {
	const tiers: Record<CapabilityTier, string[]> = { fast: [], balanced: [], strong: [], frontier: [] };
	const byProvider = new Map<string, TierCatalogModel[]>();
	for (const model of models) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
	for (const provider of [...byProvider.keys()].sort()) {
		const entries = byProvider.get(provider) ?? [];
		const levelKey = (model: TierCatalogModel) => `${model.cost.output}/${model.cost.input}`;
		const levels = [...new Set(entries.map(levelKey))].sort((a, b) => {
			const [outputA, inputA] = a.split("/").map(Number);
			const [outputB, inputB] = b.split("/").map(Number);
			return outputA - outputB || inputA - inputB;
		});
		if (levels.length < 2) continue;
		for (const model of entries) {
			const position = levels.indexOf(levelKey(model));
			const tier =
				CAPABILITY_TIERS[
					Math.min(CAPABILITY_TIERS.length - 1, Math.floor((position * CAPABILITY_TIERS.length) / levels.length))
				];
			tiers[tier].push(`${provider}/${model.id}`);
		}
	}
	return tiers;
}

/** `provider/model` split in two, or undefined when `ref` is not of that form. */
export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export interface TierResolution {
	/** Configured models per tier (the `modelTiers` setting). */
	configured?: ModelTiers;
	/** Every model the registry knows. */
	catalog: readonly Model<Api>[];
	/** Whether a model has credentials, so it can run. */
	isAvailable: (model: Model<Api>) => boolean;
	/** The session's model: derived tiers stay on its provider, and it is the last fallback. */
	current: Model<Api> | undefined;
}

/**
 * The model for `tier`: the first available configured model, else the session's model when it
 * belongs to the tier, else the first available model of the session's provider in that tier,
 * else the session's model.
 */
export function resolveTier(tier: CapabilityTier, options: TierResolution): Model<Api> | undefined {
	const { catalog, current } = options;
	const find = (ref: string) => {
		const parsed = parseModelRef(ref);
		return parsed ? catalog.find((model) => model.provider === parsed.provider && model.id === parsed.id) : undefined;
	};
	const usable = (model: Model<Api> | undefined): model is Model<Api> =>
		model !== undefined && isEligibleChatModel(model.provider, model.id) && options.isAvailable(model);
	for (const ref of options.configured?.[tier] ?? []) {
		const model = find(ref);
		if (usable(model)) return model;
	}
	if (!current) return undefined;
	const derived = deriveModelTiers(catalog.filter((model) => model.provider === current.provider))[tier];
	if (derived.includes(`${current.provider}/${current.id}`)) return current;
	return derived.map(find).find(usable) ?? current;
}
