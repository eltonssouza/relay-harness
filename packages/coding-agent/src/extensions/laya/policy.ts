import type { ModelThinkingLevel } from "@relay-harness/ai";
import type { TaskAssessment } from "./assessment.ts";
import {
	CAPABILITY_TIERS,
	type CapabilityTier,
	type ReasoningEffort,
	VALIDATION_LEVELS,
	type ValidationLevel,
} from "./questions.ts";

/**
 * Policy engine: turns Laya's recommendation into a model choice the harness accepts.
 *
 * Laya recommends; the harness decides. Deterministic rules set floors that Laya cannot lower,
 * the model registry maps abstract tiers to concrete models, the quota manager and performance
 * history adjust each candidate, and a profile-weighted utility picks the cheapest model that is
 * likely enough to succeed.
 */

export const POLICY_PROFILES = ["economy", "balanced", "quality", "critical"] as const;
export type PolicyProfile = (typeof POLICY_PROFILES)[number];

export interface ProfileWeights {
	quality: number;
	cost: number;
	latency: number;
	risk: number;
	/** Minimum estimated success probability a model needs to be chosen. */
	minSuccess: number;
}

export const PROFILES: Record<PolicyProfile, ProfileWeights> = {
	economy: { quality: 0.3, cost: 0.5, latency: 0.2, risk: 0, minSuccess: 0.75 },
	balanced: { quality: 0.45, cost: 0.3, latency: 0.15, risk: 0.1, minSuccess: 0.85 },
	quality: { quality: 0.7, cost: 0.1, latency: 0, risk: 0.2, minSuccess: 0.9 },
	critical: { quality: 0.7, cost: 0, latency: 0, risk: 0.3, minSuccess: 0.95 },
};

/** Antigravity catalogs may expose each reasoning effort as a separate model ID. */
function antigravityModels(id: string, efforts: readonly string[] = []): string[] {
	return [id, ...efforts.map((effort) => `${id}-${effort}`)].map((model) => `google-antigravity/${model}`);
}

/**
 * Concrete models per tier as `provider/model`, in preference order. Only models whose provider
 * has credentials are candidates. Override with the `laya.models` setting.
 */
export const DEFAULT_MODEL_REGISTRY: Record<CapabilityTier, string[]> = {
	fast: [
		"anthropic/claude-haiku-4-5",
		"openai-codex/gpt-6-luna",
		"google/gemini-3.5-flash",
		...antigravityModels("gemini-3.7-flash", ["medium", "low", "high"]),
		...antigravityModels("gemini-3.6-flash", ["medium", "low", "high"]),
	],
	balanced: [
		"anthropic/claude-sonnet-5-5",
		"openai-codex/gpt-5.6-terra",
		"google/gemini-3.8-flash",
		...antigravityModels("claude-sonnet-5-5", ["medium", "low", "high"]),
		...antigravityModels("gemini-3.8-flash", ["medium", "low", "high"]),
		...antigravityModels("gpt-oss-120b-medium"),
	],
	strong: [
		"anthropic/claude-opus-5-5",
		"openai-codex/gpt-6-sol",
		"google/gemini-3.1-pro-preview",
		...antigravityModels("claude-opus-5-5", ["medium", "low", "high"]),
		...antigravityModels("gemini-3.1-pro", ["high", "low"]),
	],
	frontier: [
		"anthropic/claude-fable-5-1",
		"openai-codex/gpt-6.1-sol",
		"openai-codex/gpt-6-astra",
		"anthropic/claude-fable-5",
	],
};

/** Relative quota cost and latency per tier, 0..1. */
const TIER_PRIORS: Record<CapabilityTier, { cost: number; latency: number }> = {
	fast: { cost: 0.1, latency: 0.15 },
	balanced: { cost: 0.35, latency: 0.35 },
	strong: { cost: 0.65, latency: 0.6 },
	frontier: { cost: 0.9, latency: 0.85 },
};

/**
 * Prior success probability relative to the tier the task requires: a model of exactly that tier is
 * sufficient, each tier above adds a little, each tier below loses a lot.
 */
const MATCHED_SUCCESS = 0.9;
const OVERPOWERED_BONUS = 0.04;
const UNDERPOWERED_PENALTY = 0.18;

/** Weight of the prior, in runs, when blending it with observed history. */
const PRIOR_RUNS = 5;

export const tierIndex = (tier: CapabilityTier) => CAPABILITY_TIERS.indexOf(tier);
export const maxTier = (a: CapabilityTier, b: CapabilityTier) => (tierIndex(a) >= tierIndex(b) ? a : b);
export function nextTier(tier: CapabilityTier): CapabilityTier | undefined {
	return CAPABILITY_TIERS[tierIndex(tier) + 1];
}

/** Requests that must not run on a weak model, whatever Laya says. */
export const DETERMINISTIC_RULES: Array<{ id: string; pattern: RegExp }> = [
	{
		id: "production-database-migration",
		pattern:
			/(migrat|migra[cç]|\bdrop\b|backfill|alter table).*(produc|produ[cç])|(produc|produ[cç]).*(migrat|migra[cç]|\bdrop\b|backfill|alter table)/i,
	},
	{ id: "authentication", pattern: /\bauth|login|oauth|\bsso\b|password|senha|session token|jwt/i },
	{ id: "security-vulnerability", pattern: /vulnerab|inje[cç]|\bxss\b|csrf|\bcve-|exploit|privilege escalation/i },
	{ id: "payment-processing", pattern: /payment|pagamento|billing|cobran[cç]a|stripe|checkout|invoice|fatura/i },
];

/** The top effort maps to `xhigh`; routing never uses `max`. */
export const EFFORT_TO_THINKING: Record<ReasoningEffort, ModelThinkingLevel> = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	extra_high: "xhigh",
};

export interface PolicyOptions {
	/** Answers below this confidence raise the tier by one (`insufficient_confidence`). */
	minConfidence: number;
}

export interface PolicyDecision {
	/** Tier Laya recommended. */
	recommendedTier: CapabilityTier;
	/** Tier the policy requires: the recommendation raised by rules and low confidence. */
	requiredTier: CapabilityTier;
	/** Hard floor: no model below this tier is chosen. */
	minTier: CapabilityTier;
	effort: ReasoningEffort;
	thinkingLevel: ModelThinkingLevel;
	validation: { required: boolean; level: ValidationLevel };
	/** Deterministic rules that fired. */
	rules: string[];
	/** Why the tier differs from Laya's recommendation. */
	escalations: EscalationReason[];
}

export type EscalationReason =
	| "insufficient_confidence"
	| "test_failure"
	| "missing_context"
	| "high_risk"
	| "repeated_failure"
	| "architecture_complexity"
	| "security_sensitive"
	| "provider_unavailable";

/** Applies the deterministic rules and the confidence threshold to Laya's assessment. */
export function applyPolicy(assessment: TaskAssessment, request: string, options: PolicyOptions): PolicyDecision {
	const recommendedTier = assessment.recommendation.tier;
	const rules = DETERMINISTIC_RULES.filter((rule) => rule.pattern.test(request)).map((rule) => rule.id);
	const escalations: EscalationReason[] = [];
	let minTier: CapabilityTier = "fast";
	if (rules.length > 0 || assessment.securitySensitive || assessment.task.type === "security") {
		minTier = "strong";
		escalations.push("security_sensitive");
	} else if (assessment.task.risk >= 0.66) {
		minTier = "strong";
		escalations.push("high_risk");
	} else if (assessment.task.type === "architecture" && assessment.task.complexity >= 0.75) {
		minTier = "strong";
		escalations.push("architecture_complexity");
	}
	let requiredTier = maxTier(recommendedTier, minTier);
	if (assessment.confidence < options.minConfidence) {
		const raised = nextTier(requiredTier);
		if (raised) {
			requiredTier = raised;
			escalations.push("insufficient_confidence");
		}
	}
	// Floors that do not raise the tier are not reported as escalations.
	const effectiveEscalations = tierIndex(requiredTier) > tierIndex(recommendedTier) ? escalations : [];

	const sensitive = minTier === "strong";
	let effort = assessment.recommendation.effort;
	if (sensitive && (effort === "minimal" || effort === "low")) effort = "medium";
	const validationLevel: ValidationLevel =
		sensitive && VALIDATION_LEVELS.indexOf(assessment.validation) < VALIDATION_LEVELS.indexOf("review")
			? "review"
			: assessment.validation;
	return {
		recommendedTier,
		requiredTier,
		minTier,
		effort,
		thinkingLevel: EFFORT_TO_THINKING[effort],
		validation: { required: sensitive || validationLevel !== "none", level: validationLevel },
		rules,
		escalations: effectiveEscalations,
	};
}

/**
 * Relative availability of each provider's subscription quota, 0..1. Configured values come from
 * the `laya.quota` setting; rate-limit and overload errors lower a provider's availability for
 * ten minutes, so equivalent models of other providers win in the meantime.
 */
export class QuotaManager {
	private configured: Record<string, number> = {};
	private penalties = new Map<string, { amount: number; at: number }>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	configure(quota: Record<string, number> | undefined): void {
		this.configured = { ...(quota ?? {}) };
	}

	/** Records a rate-limit or overload error from `provider`. */
	recordPressure(provider: string): void {
		const current = this.penaltyOf(provider);
		this.penalties.set(provider, { amount: Math.min(0.9, current + 0.5), at: this.now() });
	}

	available(provider: string): number {
		const configured = Math.min(1, Math.max(0, this.configured[provider] ?? 1));
		return configured * (1 - this.penaltyOf(provider));
	}

	snapshot(providers: Iterable<string>): Record<string, number> {
		return Object.fromEntries(
			[...providers].map((provider) => [provider, Number(this.available(provider).toFixed(2))]),
		);
	}

	private penaltyOf(provider: string): number {
		const penalty = this.penalties.get(provider);
		if (!penalty) return 0;
		const remaining = 1 - (this.now() - penalty.at) / 600_000;
		return remaining > 0 ? penalty.amount * remaining : 0;
	}
}

/** History key: task type plus complexity level, e.g. `bug_fix:2`. */
export function taskKey(assessment: Pick<TaskAssessment, "task">): string {
	return `${assessment.task.type}:${Math.round(assessment.task.complexity * 4)}`;
}

/** Observed outcomes per task class and model, from telemetry. */
export class PerformanceHistory {
	private outcomes = new Map<string, { runs: number; successes: number }>();

	record(key: string, model: string, success: boolean): void {
		const id = `${key}|${model}`;
		const entry = this.outcomes.get(id) ?? { runs: 0, successes: 0 };
		entry.runs++;
		if (success) entry.successes++;
		this.outcomes.set(id, entry);
	}

	get(key: string, model: string): { runs: number; successes: number } | undefined {
		return this.outcomes.get(`${key}|${model}`);
	}

	/** P(success | task, model): the prior blended with observed runs. */
	successProbability(key: string, model: string, prior: number): number {
		const observed = this.get(key, model);
		if (!observed) return prior;
		return (prior * PRIOR_RUNS + observed.successes) / (PRIOR_RUNS + observed.runs);
	}
}

export interface Candidate {
	/** `provider/model` */
	ref: string;
	provider: string;
	tier: CapabilityTier;
	/** Position in the registry; breaks ties in favor of the configured preference. */
	order: number;
}

export interface ScoredCandidate extends Candidate {
	success: number;
	cost: number;
	latency: number;
	utility: number;
	eligible: boolean;
}

export interface RankInput {
	requiredTier: CapabilityTier;
	minTier: CapabilityTier;
	/** Task risk, 0..1. */
	risk: number;
	profile: PolicyProfile;
	taskKey: string;
	history: PerformanceHistory;
	quota: QuotaManager;
}

/**
 * Scores every candidate with the profile's utility
 * `quality * P(success) - cost * quota_cost - latency * latency - risk * failure_risk`
 * and sorts the best first. Candidates below the minimum tier are dropped. A candidate is eligible
 * when its success probability reaches the profile minimum; when none is, the most likely one wins.
 */
export function rankCandidates(candidates: readonly Candidate[], input: RankInput): ScoredCandidate[] {
	const weights = PROFILES[input.profile];
	const required = tierIndex(input.requiredTier);
	const scored = candidates
		.filter((candidate) => tierIndex(candidate.tier) >= tierIndex(input.minTier))
		.filter((candidate) => input.quota.available(candidate.provider) > 0.05)
		.map((candidate): ScoredCandidate => {
			const priors = TIER_PRIORS[candidate.tier];
			const gap = tierIndex(candidate.tier) - required;
			const prior = Math.min(
				0.99,
				Math.max(0.05, MATCHED_SUCCESS + (gap > 0 ? OVERPOWERED_BONUS : UNDERPOWERED_PENALTY) * gap),
			);
			const success = input.history.successProbability(input.taskKey, candidate.ref, prior);
			// Scarce quota makes a model more expensive to use, not less likely to succeed.
			const cost = Math.min(1, priors.cost * (2 - input.quota.available(candidate.provider)));
			const failureRisk = (1 - success) * Math.max(input.risk, 0.2);
			const utility =
				weights.quality * success -
				weights.cost * cost -
				weights.latency * priors.latency -
				weights.risk * failureRisk;
			return {
				...candidate,
				success,
				cost,
				latency: priors.latency,
				utility,
				eligible: success >= weights.minSuccess,
			};
		});
	const anyEligible = scored.some((candidate) => candidate.eligible);
	return scored.sort((a, b) => {
		if (anyEligible && a.eligible !== b.eligible) return a.eligible ? -1 : 1;
		if (!anyEligible) return b.success - a.success || a.order - b.order;
		return b.utility - a.utility || a.order - b.order;
	});
}

/** Parses `provider/model`; the model id may itself contain slashes. */
export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}
