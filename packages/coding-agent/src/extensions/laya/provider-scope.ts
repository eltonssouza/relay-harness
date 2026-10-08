import type { LayaSettings } from "../../core/settings-manager.ts";
import { DEFAULT_MODEL_REGISTRY, parseModelRef } from "./policy.ts";
import { CAPABILITY_TIERS, type CapabilityTier } from "./questions.ts";

type TierRegistry = Partial<Record<CapabilityTier, string[]>>;

/** Keep task intelligence independent of providers; constrain the concrete model catalog here. */
export function scopedModelRegistry(
	settings: LayaSettings,
	selected?: { provider: string; id: string },
): { registry: TierRegistry; scope?: string } {
	if (!settings.followProvider) return { registry: { ...DEFAULT_MODEL_REGISTRY, ...settings.models } };
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
		const refs = group
			? (group[1][tier] ?? [])
			: [...DEFAULT_MODEL_REGISTRY[tier], ...(settings.models?.[tier] ?? [])];
		registry[tier] = [...new Set(refs)].filter(
			(candidate) => parseModelRef(candidate)?.provider === selected.provider,
		);
	}
	return { registry, scope: group ? `${selected.provider} (${group[0]})` : selected.provider };
}
