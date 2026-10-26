import { isEligibleChatModel } from "../../core/model-eligibility.ts";
import type { LayaSettings } from "../../core/settings-manager.ts";
import { DEFAULT_TIER_PROVIDERS, deriveModelRegistry, parseModelRef, type TierCatalogModel } from "./policy.ts";
import { CAPABILITY_TIERS, type CapabilityTier } from "./questions.ts";

type TierRegistry = Partial<Record<CapabilityTier, string[]>>;

/**
 * Keep task intelligence independent of providers; constrain the concrete model catalog here.
 * `catalog` holds the models that have credentials; tiers a setting does not name are derived from
 * the eligible ones of the providers in `DEFAULT_TIER_PROVIDERS`.
 */
export function scopedModelRegistry(
	settings: LayaSettings,
	selected?: { provider: string; id: string },
	catalog: readonly TierCatalogModel[] = [],
): { registry: TierRegistry; scope?: string } {
	const derived = deriveModelRegistry(
		catalog.filter(
			(model) => DEFAULT_TIER_PROVIDERS.has(model.provider) && isEligibleChatModel(model.provider, model.id),
		),
	);
	if (!settings.followProvider) {
		const registry: TierRegistry = {};
		for (const tier of CAPABILITY_TIERS) {
			registry[tier] = (settings.models?.[tier] ?? derived[tier]).filter((ref) => {
				const model = parseModelRef(ref);
				return model && isEligibleChatModel(model.provider, model.id);
			});
		}
		return { registry };
	}
	if (!selected) {
		throw new Error("laya/auto: select a physical model first so Laya knows which provider to follow.");
	}
	const ref = `${selected.provider}/${selected.id}`;
	const groups = Object.entries(settings.modelGroups ?? {}).filter(([, tiers]) =>
		CAPABILITY_TIERS.some((tier) => tiers[tier]?.includes(ref)),
	);
	if (groups.length > 1) throw new Error(`laya/auto: ${ref} belongs to multiple laya.modelGroups; keep one group.`);
	const group = groups[0];
	const registry: TierRegistry = {};
	for (const tier of CAPABILITY_TIERS) {
		const refs = group ? (group[1][tier] ?? []) : [...derived[tier], ...(settings.models?.[tier] ?? [])];
		registry[tier] = [...new Set(refs)].filter((candidate) => {
			const model = parseModelRef(candidate);
			return model?.provider === selected.provider && isEligibleChatModel(model.provider, model.id);
		});
	}
	return { registry, scope: group ? `${selected.provider} (${group[0]})` : selected.provider };
}
