import type { ClassifierAnswer } from "@relay-harness/ai";
import {
	AGENT_IDS,
	type AgentId,
	AMBIGUITY_LEVELS,
	CAPABILITY_TIERS,
	type CapabilityTier,
	COMPLEXITY_LEVELS,
	LAYA_QUESTIONS,
	LIBRARY_CATEGORY_IDS,
	type LibraryCategoryId,
	REASONING_EFFORTS,
	REASONING_LEVELS,
	type ReasoningEffort,
	RISK_LEVELS,
	TASK_SCOPES,
	TASK_TYPES,
	type TaskScope,
	type TaskType,
	TOOL_REQUIREMENT_IDS,
	type ToolRequirement,
	VALIDATION_LEVELS,
	type ValidationLevel,
} from "./questions.ts";

/** Laya's System 1 answer about one request: what the task is and how it recommends running it. */
export interface TaskAssessment {
	/** Laya's answers, the labels of a similar learned task, or keyword rules. */
	source: "laya" | "memory" | "heuristic";
	/** Null means abstention: keyword fallbacks never invent library confidence. */
	libraryCategory: LibraryCategoryId | null;
	libraryConfidence: number;
	task: {
		type: TaskType;
		/** Scores normalized to 0..1. */
		complexity: number;
		risk: number;
		ambiguity: number;
		reasoning: number;
		scope: TaskScope;
	};
	recommendation: { tier: CapabilityTier; effort: ReasoningEffort };
	agent: AgentId;
	validation: ValidationLevel;
	tools: Record<ToolRequirement, boolean>;
	securitySensitive: boolean;
	/** Lowest confidence among the answers that drive routing: task type, tier and effort. */
	confidence: number;
}

function choice<T extends string>(answers: Record<string, ClassifierAnswer>, id: string, options: readonly T[]) {
	const answer = answers[id];
	if (answer?.type !== "choice" || !options.includes(answer.choice as T)) {
		throw new Error(`Laya returned no valid answer for ${id}`);
	}
	return { value: answer.choice as T, confidence: answer.probabilities[answer.choice] ?? answer.confidence };
}

function score(answers: Record<string, ClassifierAnswer>, id: string, levels: readonly string[]): number {
	const answer = answers[id];
	if (answer?.type !== "score") throw new Error(`Laya returned no valid answer for ${id}`);
	return Math.min(1, Math.max(0, answer.score / (levels.length - 1)));
}

function yes(answers: Record<string, ClassifierAnswer>, id: string): boolean {
	const answer = answers[id];
	if (answer?.type !== "bool") throw new Error(`Laya returned no valid answer for ${id}`);
	return answer.probability >= 0.5;
}

/** Reads a classifier result for `LAYA_QUESTIONS`. Throws when an answer is missing or unknown. */
export function assessmentFromAnswers(answers: Record<string, ClassifierAnswer>): TaskAssessment {
	const type = choice(answers, "task_type", TASK_TYPES);
	const tier = choice(answers, "capability_tier", CAPABILITY_TIERS);
	const effort = choice(answers, "reasoning_effort", REASONING_EFFORTS);
	const library = choice(answers, "library_category", LIBRARY_CATEGORY_IDS);
	return {
		source: "laya",
		libraryCategory: library.value,
		libraryConfidence: Number.isFinite(library.confidence) ? Math.min(1, Math.max(0, library.confidence)) : 0,
		task: {
			type: type.value,
			complexity: score(answers, "complexity", COMPLEXITY_LEVELS),
			risk: score(answers, "risk", RISK_LEVELS),
			ambiguity: score(answers, "ambiguity", AMBIGUITY_LEVELS),
			reasoning: score(answers, "reasoning_requirement", REASONING_LEVELS),
			scope: choice(answers, "scope", TASK_SCOPES).value,
		},
		recommendation: { tier: tier.value, effort: effort.value },
		agent: choice(answers, "agent", AGENT_IDS).value,
		validation: choice(answers, "validation_level", VALIDATION_LEVELS).value,
		tools: Object.fromEntries(TOOL_REQUIREMENT_IDS.map((id) => [id, yes(answers, id)])) as Record<
			ToolRequirement,
			boolean
		>,
		securitySensitive: yes(answers, "security_sensitive"),
		confidence: Math.min(type.confidence, tier.confidence, effort.confidence),
	};
}

/**
 * The assessment a labeled exercise describes, read as answers given with full certainty. Throws when
 * a label is missing or not an option.
 */
export function assessmentFromLabels(labels: Readonly<Record<string, string | number | boolean>>): TaskAssessment {
	const answers: Record<string, ClassifierAnswer> = {};
	for (const [id, question] of Object.entries(LAYA_QUESTIONS)) {
		const value = labels[id];
		if (question.type === "choice" && typeof value === "string") {
			answers[id] = { type: "choice", choice: value, probabilities: { [value]: 1 }, confidence: 1 };
		} else if (question.type === "score" && typeof value === "number") {
			answers[id] = { type: "score", score: value, confidence: 1 };
		} else if (question.type === "bool" && typeof value === "boolean") {
			answers[id] = { type: "bool", probability: value ? 1 : 0 };
		}
	}
	return assessmentFromAnswers(answers);
}

const has = (pattern: RegExp, text: string) => pattern.test(text);

/** Ordered: the first matching rule decides the task type. English and Portuguese keywords. */
const TYPE_RULES: Array<[TaskType, RegExp]> = [
	["security", /vulnerab|inje[cç]|xss|csrf|exploit|secur|seguran[cç]a|oauth|password|senha|secret|segredo/],
	["architecture", /architect|arquitet|system design|microservi|microsservi|\badr\b|desenhe uma|design a /],
	[
		"debugging",
		/investigat|investig|root cause|causa raiz|deadlock|intermittent|intermitente|hangs|trava|why .*fail|por que .*falh/,
	],
	["test", /\btests?\b|\btestes?\b|coverage|cobertura|flaky|type ?check|checagem/],
	["bug_fix", /\bfix\b|\bbug|corrij|conserte|arrume|broken|quebr|crash|\berro|\berror|wrong|errad|returns? 500/],
	[
		"refactor",
		/refactor|refator|extract|extraia|\bsplit\b|divida|rename|renomei|migrate .* to|migre|convert|converta/,
	],
	["documentation", /readme|\bdocs?\b|document|changelog|comment|coment[aá]rio/],
	["research", /compare|pesquis|research|map every|mapeie|list the|liste os/],
	[
		"feature",
		/\badd\b|adicion|implement|create|crie|\bbuild\b|support|suporte|endpoint|integrat|integre|deploy|pipeline/,
	],
];

const QUESTION_START =
	/^(what|how|why|where|which|when|is |are |can |does |o que|como|por que|onde|qual|quando|isso|d[aá] )/;

const DEFAULT_COMPLEXITY: Record<TaskType, number> = {
	question: 1,
	code_edit: 1,
	bug_fix: 2,
	refactor: 2,
	feature: 2,
	test: 1,
	architecture: 3,
	debugging: 3,
	security: 3,
	research: 1,
	documentation: 1,
};

const AGENT_RULES: Array<[AgentId, RegExp]> = [
	["mobile-engineer", /android|\bios\b|mobile|flutter|react native|swift|kotlin/],
	["devops-engineer", /docker|\bci\b|pipeline|deploy|kubernetes|\bk8s\b|release|workflow|terraform/],
	["database-engineer", /\bsql\b|database|banco de dados|\bindex|[ií]ndice|migration|query|consulta|schema/],
	[
		"frontend-engineer",
		/\bcss\b|\bui\b|button|bot[aã]o|component|p[aá]gina|\bpage\b|modal|dropdown|react|html|dark mode|layout/,
	],
	["backend-engineer", /\bapi\b|endpoint|servi[cç]|service|queue|fila|worker|server|backend/],
];

const SECURITY_SENSITIVE =
	/auth|login|oauth|token|password|senha|secret|segredo|credential|credencia|permiss|payment|pagamento|stripe|vulnerab|inje[cç]|production (database|db|data)|banco de produ|produ[cç][aã]o.*(migra|banco)|(migra|banco).*produ[cç]/;

/**
 * Keyword fallback used when the Laya server is unreachable or returns invalid answers, so routing
 * keeps working. It follows the same tier rule as the synthetic training data and reports a
 * confidence of 0.5: neither trusted nor escalated.
 */
export function heuristicAssessment(request: string): TaskAssessment {
	const text = request.toLowerCase();
	let type: TaskType =
		TYPE_RULES.find(([, pattern]) => has(pattern, text))?.[0] ??
		(text.trim().endsWith("?") || QUESTION_START.test(text.trim()) ? "question" : "code_edit");
	if (type !== "question" && text.trim().endsWith("?") && QUESTION_START.test(text.trim())) type = "question";

	let complexity = DEFAULT_COMPLEXITY[type];
	if (has(/typo|digita[cç][aã]o|rename|renomei|texto|\btext\b|bump|vers[aã]o do/, text)) complexity = 0;
	if (
		has(
			/race condition|condi[cç][aã]o de corrida|concurren|concorr[eê]n|memory leak|vazamento|multi-tenant|zero downtime|sem downtime/,
			text,
		)
	)
		complexity = 3;
	if (has(/distribut|distribu[ií]d|crdt|corrup|plugin system|sistema de plugins|deadlock|monorepo/, text))
		complexity = 4;

	const security = has(SECURITY_SENSITIVE, text) || type === "security";
	let risk = complexity >= 3 ? 2 : complexity >= 2 ? 1 : 0;
	if (security || has(/produ[cç]|production|\bdrop\b|delete|apag/, text)) risk = 3;

	const scope: TaskScope = has(/\btypo|digita|button|bot[aã]o|\bline\b|linha/, text)
		? "single_line"
		: has(/monorepo|repository|reposit[oó]rio|whole|inteiro|all (the )?packages|todos os pacotes/, text)
			? "repository"
			: has(/services|servi[cç]os|across|between|entre|packages|pacotes/, text)
				? "multi_module"
				: has(/\.[a-z]{1,5}\b/, text)
					? "single_file"
					: "module";

	const ambiguity =
		text.length < 30 ? 2 : has(/investig|find out|descubra|evaluate|avalie|propose|proponha/, text) ? 1 : 0;
	const tierIndex = Math.max(complexity <= 1 ? 0 : complexity - 1, risk >= 2 || security ? 2 : 0);

	const agent: AgentId =
		type === "security"
			? "security-engineer"
			: type === "architecture" || complexity >= 4
				? "software-architect"
				: type === "test"
					? "qa-engineer"
					: type === "question" || type === "research"
						? "researcher"
						: (AGENT_RULES.find(([, pattern]) => has(pattern, text))?.[0] ?? "software-engineer");

	const validation: ValidationLevel =
		type === "question" || type === "research"
			? "none"
			: type === "documentation"
				? "syntax"
				: type === "code_edit"
					? "compile"
					: type === "architecture" || security
						? "review"
						: complexity >= 3
							? "integration_test"
							: "unit_test";

	const readOnly = type === "question" || type === "research" || type === "architecture";
	return {
		source: "heuristic",
		libraryCategory: null,
		libraryConfidence: 0,
		task: {
			type,
			complexity: complexity / 4,
			risk: risk / 3,
			ambiguity: ambiguity / 2,
			reasoning: complexity / 4,
			scope,
		},
		recommendation: { tier: CAPABILITY_TIERS[Math.min(tierIndex, 3)], effort: REASONING_EFFORTS[complexity] },
		agent,
		validation,
		tools: {
			requires_write: !readOnly && !has(/^(run|rode) /, text.trim()),
			requires_shell: agent === "devops-engineer" || type === "debugging",
			requires_tests: validation === "compile" || validation === "unit_test" || validation === "integration_test",
			requires_web: has(
				/official doc|documenta[cç][aã]o oficial|latest version|[uú]ltima vers|search the web|pesquis/,
				text,
			),
			requires_browser: agent === "frontend-engineer" && has(/browser|navegador|mobile|celular|focus|foco/, text),
			requires_database: agent === "database-engineer" || has(/\bsql\b|database|banco/, text),
			requires_git: has(/\bgit\b|commit|branch|\bpush\b|merge|rebase/, text),
		},
		securitySensitive: security,
		confidence: 0.5,
	};
}
