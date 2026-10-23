import type { TaskAssessment } from "./assessment.ts";
import type { PolicyDecision } from "./policy.ts";
import type { ToolRequirement } from "./questions.ts";
import { TOOL_PATTERNS } from "./routers.ts";
import { truncateRequest } from "./telemetry.ts";

/**
 * Cognitive strategy selector, rules v1 (ACI phase 5): decides *how* to approach a task from the
 * assessment and policy, without new training. A strategy is advice for the agent and the trace; it
 * never grants a tool, permission or model. Strategies that need a missing resource are skipped and
 * reported as abstentions.
 */
export const STRATEGY_RULES_VERSION = "aci-strategy-rules-v1";

export const STRATEGIES = [
	"human_review",
	"delegate",
	"decompose",
	"plan_execute_verify",
	"tool_assisted",
	"retrieve",
	"direct",
	// Needs a verification harness for competing candidates; never selected by rules v1.
	"multi_candidate",
	// Model escalation is decided by the router (`escalations`), not by this selector.
	"escalate",
] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** Resources the session actually has; the selector only reads them. */
export interface StrategyResources {
	activeTools: readonly string[];
}

/** Structured view of the task without the request text, so no secret in the prompt reaches the trace. */
export interface TaskSnapshot {
	taskType: TaskAssessment["task"]["type"];
	scope: TaskAssessment["task"]["scope"];
	complexity: number;
	risk: number;
	ambiguity: number;
	securitySensitive: boolean;
	requiredTools: ToolRequirement[];
	requestChars: number;
	/** The request exceeded Laya's input limit and was cut before classification. */
	truncated: boolean;
}

export interface StrategyDecision {
	rulesVersion: typeof STRATEGY_RULES_VERSION;
	strategy: Strategy;
	/** The classifier's confidence, lowered when the input was truncated or came from keyword rules. */
	confidence: number;
	reasonCodes: string[];
	evidence: TaskSnapshot;
	/** Strategies the rules matched but could not use, with the reason. */
	abstentions: Array<{ strategy: Strategy; reason: string }>;
}

const DELEGATION_TOOL = "execute_work";
const BROAD_SCOPES = new Set<TaskSnapshot["scope"]>(["multi_module", "repository", "multi_repository"]);
const HIGH = 0.75;

export function taskSnapshot(request: string, assessment: TaskAssessment): TaskSnapshot {
	return {
		taskType: assessment.task.type,
		scope: assessment.task.scope,
		complexity: assessment.task.complexity,
		risk: assessment.task.risk,
		ambiguity: assessment.task.ambiguity,
		securitySensitive: assessment.securitySensitive,
		requiredTools: (Object.keys(assessment.tools) as ToolRequirement[]).filter((id) => assessment.tools[id]),
		requestChars: request.length,
		truncated: truncateRequest(request) !== request,
	};
}

export function selectStrategy(
	request: string,
	assessment: TaskAssessment,
	policy: PolicyDecision,
	resources: StrategyResources,
	minConfidence: number,
): StrategyDecision {
	const evidence = taskSnapshot(request, assessment);
	const has = (pattern: RegExp) => resources.activeTools.some((name) => pattern.test(name));
	const missingTools = evidence.requiredTools.filter((id) => !has(TOOL_PATTERNS[id]));
	const reasonCodes: string[] = [];
	let confidence = assessment.confidence;
	if (assessment.source === "heuristic") reasonCodes.push("keyword_rules");
	if (evidence.truncated) {
		reasonCodes.push("request_truncated");
		confidence = Math.min(confidence, minConfidence);
	}
	const uncertain = confidence < minConfidence;
	if (uncertain) reasonCodes.push("low_confidence");

	// Ordered rules: the first that matches and has its resources wins.
	const candidates: Array<{ strategy: Strategy; when: boolean; reason: string; missing?: string }> = [
		{
			strategy: "human_review",
			when: evidence.ambiguity >= HIGH || (evidence.securitySensitive && evidence.risk >= HIGH) || uncertain,
			reason: evidence.ambiguity >= HIGH ? "high_ambiguity" : uncertain ? "low_confidence" : "sensitive_high_risk",
		},
		{
			strategy: "delegate",
			when: BROAD_SCOPES.has(evidence.scope) && evidence.complexity >= HIGH,
			reason: "broad_complex_task",
			missing: has(new RegExp(`^${DELEGATION_TOOL}$`)) ? undefined : "delegation_unavailable",
		},
		{
			strategy: "decompose",
			when: BROAD_SCOPES.has(evidence.scope) || evidence.complexity >= HIGH,
			reason: "multi_step_task",
		},
		{
			strategy: "plan_execute_verify",
			when:
				assessment.tools.requires_write &&
				["unit_test", "integration_test", "review"].includes(policy.validation.level),
			reason: "change_needs_evidence",
			missing: missingTools.includes("requires_write") ? "write_tool_unavailable" : undefined,
		},
		{
			strategy: "tool_assisted",
			when: evidence.requiredTools.length > 0,
			reason: "needs_tools",
			missing: missingTools.length > 0 ? `tools_unavailable:${missingTools.join(",")}` : undefined,
		},
		{
			strategy: "retrieve",
			when: evidence.taskType === "research" || evidence.taskType === "question",
			reason: "needs_information",
		},
	];
	const abstentions: StrategyDecision["abstentions"] = [];
	for (const candidate of candidates) {
		if (!candidate.when) continue;
		if (candidate.missing) {
			abstentions.push({ strategy: candidate.strategy, reason: candidate.missing });
			continue;
		}
		return {
			rulesVersion: STRATEGY_RULES_VERSION,
			strategy: candidate.strategy,
			confidence,
			reasonCodes: [...reasonCodes, candidate.reason],
			evidence,
			abstentions,
		};
	}
	return {
		rulesVersion: STRATEGY_RULES_VERSION,
		strategy: "direct",
		confidence,
		reasonCodes: [...reasonCodes, "simple_task"],
		evidence,
		abstentions,
	};
}
