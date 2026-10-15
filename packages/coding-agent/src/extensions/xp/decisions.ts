import { existsSync } from "node:fs";
import type { ClassifierQuestion, ClassifierResult, JsonObject } from "@relay-harness/ai";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "../../core/extensions/types.ts";
import type { Skill } from "../../core/skills.ts";
import { DEFAULT_LAYA_BASE_URL, LAYA_CLASSIFIER_ID, LAYA_PROVIDER_ID } from "../laya/index.ts";
import { AGENTS, type AgentId } from "../laya/questions.ts";
import type { XpPhase, XpState } from "./workflow.ts";

export const XP_DECISION_MODEL = "relay-laya-v4";
export const XP_CONTROL_TOOLS = ["xp_intent", "xp_checkpoint", "update_goal", "get_goal"];

export interface XpPhasePlan {
	model: string;
	agents: AgentId[];
	tools: string[];
	skills: string[];
	rationale: string;
}

/** Fail closed: XP never uses the router's keyword or learned-label fallback. */
export async function classifyXp(
	relay: ExtensionAPI,
	ctx: ExtensionContext,
	state: JsonObject,
	questions: Record<string, ClassifierQuestion>,
	signal?: AbortSignal,
): Promise<ClassifierResult> {
	const classifier = ctx.modelRegistry.findOfType("classifier", LAYA_PROVIDER_ID, LAYA_CLASSIFIER_ID);
	if (!classifier) throw new Error("Laya classifier unavailable. Use /laya setup, then /xp resume.");
	const settings = relay.getSettings().laya;
	const auth = await ctx.modelRegistry.getProviderAuth(LAYA_PROVIDER_ID);
	const response = await fetch(
		new URL(
			"/health",
			auth?.auth.baseUrl ??
				settings?.baseUrl ??
				process.env.LAYA_BASE_URL ??
				classifier.baseUrl ??
				DEFAULT_LAYA_BASE_URL,
		),
		{
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
			headers: {
				...(auth?.auth.apiKey ? { Authorization: `Bearer ${auth.auth.apiKey}` } : {}),
				...auth?.auth.headers,
			},
		},
	);
	if (!response.ok) throw new Error(`Laya health check failed: ${response.status}`);
	const health: unknown = await response.json();
	if (
		!health ||
		typeof health !== "object" ||
		!("ok" in health) ||
		health.ok !== true ||
		!("version" in health) ||
		health.version !== XP_DECISION_MODEL
	) {
		throw new Error(`XP requires ${XP_DECISION_MODEL}; the server did not confirm that checkpoint.`);
	}
	const result = await ctx.modelRegistry.classify(
		classifier,
		{ state: { ...state, required_model: XP_DECISION_MODEL }, questions },
		{ signal, timeoutMs: settings?.timeoutMs ?? 60_000, maxRetries: 0 },
	);
	if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? result.stopReason);
	return result;
}

/** Build choices only from resources the session can actually invoke. */
export async function selectXpResources(
	relay: ExtensionAPI,
	ctx: ExtensionContext,
	state: XpState,
	skills: readonly Skill[],
	signal?: AbortSignal,
): Promise<XpPhasePlan> {
	const agents = Object.fromEntries(
		Object.entries(AGENTS).filter(([id]) => state.availableAgents?.includes(id as AgentId)),
	);
	if (!Object.keys(agents).length) throw new Error("No available XP agent profiles");
	const tools = relay
		.getAllTools()
		.filter((tool) => tool.exposure !== "hidden" && !XP_CONTROL_TOOLS.includes(tool.name));
	const candidates: Array<{ kind: "tool" | "skill" | "agent"; name: string; description: string }> = [
		...Object.entries(agents).map(([name, description]) => ({ kind: "agent" as const, name, description })),
		...tools.map((tool: ToolInfo) => ({ kind: "tool" as const, name: tool.name, description: tool.description })),
		...skills
			.filter((skill) => !skill.disableModelInvocation && existsSync(skill.filePath))
			.map((skill) => ({ kind: "skill" as const, name: skill.name, description: skill.description })),
	];
	const questions: Record<string, ClassifierQuestion> = {
		selection_reason: {
			type: "choice",
			instructions: "What is the main reason for selecting these resources in the current phase?",
			criteria: {
				requirements: "Clarify requirements, constraints, risks and acceptance criteria",
				architecture: "Evaluate alternatives and define technical boundaries and contracts",
				validation: "Derive or execute checks against acceptance criteria and risks",
				implementation: "Implement the planned change and verify its behavior",
				feedback: "Analyze results and feedback to decide adjustments or completion",
				recovery: "Resolve failures or reconcile changed artifacts before continuing",
			},
		},
		agent: {
			type: "choice",
			instructions: "Which available specialist should lead this XP phase?",
			criteria: agents,
		},
	};
	for (const [index, resource] of candidates.entries())
		questions[`resource_${index}`] = {
			type: "bool",
			instructions: `Does this phase need ${resource.kind} ${resource.name}? ${resource.description.slice(0, 220)} Select only necessary resources; additional agents execute sequentially in this session.`,
			criteria: { true: "needed for the current phase", false: "unnecessary for the current phase" },
		};
	const context: JsonObject = {
		goal: state.goal.slice(0, 1000),
		phase: state.phase,
		reports: Object.fromEntries(
			Object.entries(state.specificationReports ?? {}).map(([phase, report]) => [phase, report.slice(0, 300)]),
		),
		testPlan: state.testPlan?.slice(0, 500) ?? "",
		guidance:
			"Select the smallest sufficient team and resource set. Agents are execution profiles, not independent spawned workers. Repository permissions and mandatory tests remain enforced.",
		recentEvidence: state.evidence
			.slice(-5)
			.map((item) => ({ tool: item.tool, isError: item.isError, text: item.text.slice(-300) })),
	};
	const answers: ClassifierResult["answers"] = {};
	// Bound each classifier batch instead of silently dropping resources from large MCP catalogs.
	const entries = Object.entries(questions);
	for (let offset = 0; offset < entries.length; offset += 24) {
		const batch = Object.fromEntries(entries.slice(offset, offset + 24));
		const batchTools = tools.filter((tool) =>
			Object.values(batch).some((question) => question.instructions.includes(`tool ${tool.name}?`)),
		);
		const batchContext: JsonObject = {
			...context,
			tools: batchTools.map((tool) => ({
				name: tool.name,
				exposure: tool.exposure,
				parameters: JSON.parse(JSON.stringify(tool.parameters)) as JsonObject,
				guidelines: tool.promptGuidelines ?? [],
			})),
		};
		const result = await classifyXp(relay, ctx, batchContext, batch, signal);
		relay.appendEntry("xp.resource_decision", {
			workflow: state.id,
			phase: state.phase,
			model: XP_DECISION_MODEL,
			context: batchContext,
			questions: batch,
			answers: result.answers,
		});
		Object.assign(answers, result.answers);
	}
	const answer = answers.agent;
	if (
		answer?.type !== "choice" ||
		!Object.hasOwn(agents, answer.choice) ||
		!Number.isFinite(answer.confidence) ||
		answer.confidence < 0.7 ||
		answer.confidence > 1 ||
		!Number.isFinite(answer.probabilities[answer.choice]) ||
		answer.probabilities[answer.choice] < 0.7 ||
		answer.probabilities[answer.choice] > 1
	)
		throw new Error("Invalid or uncertain Laya resource selection");
	const lead = answer.choice as AgentId;
	const reason = answers.selection_reason;
	const reasonQuestion = questions.selection_reason;
	if (
		reasonQuestion.type !== "choice" ||
		reason?.type !== "choice" ||
		!Object.hasOwn(reasonQuestion.criteria, reason.choice) ||
		!Number.isFinite(reason.confidence) ||
		reason.confidence < 0.7 ||
		reason.confidence > 1 ||
		!Number.isFinite(reason.probabilities[reason.choice]) ||
		reason.probabilities[reason.choice] < 0.7 ||
		reason.probabilities[reason.choice] > 1
	)
		throw new Error("Invalid or uncertain Laya selection rationale");
	const plan: XpPhasePlan = { model: XP_DECISION_MODEL, agents: [lead], tools: [], skills: [], rationale: "" };
	for (const [index, resource] of candidates.entries()) {
		const answer = answers[`resource_${index}`];
		if (
			answer?.type !== "bool" ||
			!Number.isFinite(answer.probability) ||
			answer.probability < 0 ||
			answer.probability > 1 ||
			Math.max(answer.probability, 1 - answer.probability) < 0.7
		)
			throw new Error(`Invalid or uncertain Laya selection for ${resource.name}`);
		if (answer.probability < 0.5) continue;
		if (resource.kind === "agent") {
			if (!plan.agents.includes(resource.name as AgentId)) plan.agents.push(resource.name as AgentId);
		} else if (resource.kind === "tool") plan.tools.push(resource.name);
		else plan.skills.push(resource.name);
	}
	plan.rationale = `${reasonQuestion.criteria[reason.choice]}. Lead: ${lead} (${agents[lead]}). Additional resources were selected individually for this phase.`;
	relay.appendEntry("xp.resources", {
		workflow: state.id,
		phase: state.phase,
		revision: state.revision,
		context,
		questions,
		answers,
		plan,
	});
	return plan;
}

export function xpPlanFor(state: XpState, phase: XpPhase = state.phase): XpPhasePlan | undefined {
	return state.phasePlans?.[phase];
}
