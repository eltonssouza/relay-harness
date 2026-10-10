import type { ClassifierQuestion } from "@relay-harness/ai";

/**
 * Typed questions Laya answers about each request, in one classifier call.
 *
 * Stage A (task intelligence) describes the task. Stage B (execution intelligence) recommends how
 * to run it. The questions use abstract tiers and efforts, never model names: the model registry
 * maps tiers to concrete models, so models can change without retraining Laya. The provider is not
 * a question: it depends on credentials and quota, which only the harness knows.
 *
 * These definitions are the contract with the trained checkpoint. `layaDecisionsFile()` exports
 * them in the laya-trainer format; train and serve with the same wording.
 */

export const TASK_TYPES = [
	"question",
	"code_edit",
	"bug_fix",
	"refactor",
	"feature",
	"test",
	"architecture",
	"debugging",
	"security",
	"research",
	"documentation",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_SCOPES = [
	"single_line",
	"single_file",
	"module",
	"multi_module",
	"repository",
	"multi_repository",
] as const;
export type TaskScope = (typeof TASK_SCOPES)[number];

export const CAPABILITY_TIERS = ["fast", "balanced", "strong", "frontier"] as const;
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "extra_high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const VALIDATION_LEVELS = ["none", "syntax", "compile", "unit_test", "integration_test", "review"] as const;
export type ValidationLevel = (typeof VALIDATION_LEVELS)[number];

export const LIBRARY_DIRECTORIES = {
	languages: "01_programming_languages",
	algorithms: "02_algorithms_and_data_structures",
	architecture: "03_design_and_architecture",
	engineering: "04_engineering_and_practices",
	databases: "05_databases",
	web_frontend: "06_web_and_frontend",
	devops: "07_devops_sre_operations",
	security: "08_security_and_privacy",
	automation: "09_automation_and_integration",
	frameworks: "10_frameworks",
} as const;
export type LibraryCategoryId = keyof typeof LIBRARY_DIRECTORIES;
export const LIBRARY_CATEGORY_IDS = Object.keys(LIBRARY_DIRECTORIES) as LibraryCategoryId[];

export const AGENTS = {
	"software-engineer": "general implementation tasks that fit no specialist below",
	"code-reviewer": "read-only review of correctness, specification compliance, security and maintainability",
	"code-simplifier": "simplify code while preserving its behavior and contracts",
	"database-administrator": "data architecture, schemas, migrations, query tuning and integrity",
	"fullstack-engineer": "complete vertical features spanning database, backend and frontend",
	"principal-engineer": "cross-team technical strategy, RFCs and engineering guardrails",
	"product-designer": "user journeys, interaction design, visual systems and accessibility",
	"product-owner": "business requirements, backlog refinement and acceptance criteria",
	"quality-assurance": "test strategy, regression automation and release quality verification",
	"site-reliability-engineer": "SLOs, observability, reliability, incidents and error budgets",
	"tech-lead": "delivery decomposition, technical alignment, reviews and engineering standards",
	"backend-engineer": "APIs, services, business rules, queues, server-side code",
	"frontend-engineer": "web UI, components, styling, browser behavior, accessibility",
	"mobile-engineer": "iOS, Android, React Native or Flutter apps",
	"devops-engineer": "CI/CD, builds, containers, infrastructure, deployment, release scripts",
	"database-engineer": "schemas, migrations, queries, indexes, data modeling",
	"security-engineer": "vulnerabilities, authentication, authorization, secrets, hardening",
	"software-architect": "system design, module boundaries, cross-cutting architectural decisions",
	"qa-engineer": "writing or fixing tests, test strategy, flaky tests, coverage",
	researcher: "investigating, comparing options or explaining code without changing it",
} as const satisfies Record<string, string>;
export type AgentId = keyof typeof AGENTS;
export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

/** Tool needs, asked as independent yes/no questions to avoid a combinatorial choice. */
export const TOOL_REQUIREMENTS = {
	requires_write: "Does the task require creating or editing files?",
	requires_shell: "Does the task require running shell commands other than tests?",
	requires_tests: "Does the task require running tests, type checks, or builds?",
	requires_web: "Does the task require searching or reading the web?",
	requires_browser: "Does the task require driving a browser or checking a running UI?",
	requires_database: "Does the task require querying or changing a database?",
	requires_git: "Does the task require git operations such as commits, branches, or history?",
} as const;
export type ToolRequirement = keyof typeof TOOL_REQUIREMENTS;
export const TOOL_REQUIREMENT_IDS = Object.keys(TOOL_REQUIREMENTS) as ToolRequirement[];

export const COMPLEXITY_LEVELS = ["trivial", "simple", "moderate", "complex", "expert"];
export const RISK_LEVELS = [
	"low: easy to undo, no user impact",
	"moderate: visible behavior change",
	"high: data, money, availability or many users affected",
	"critical: production data, security or irreversible operations",
];
export const AMBIGUITY_LEVELS = [
	"clear: the request states what to do",
	"partial: some details must be inferred",
	"open: the goal or approach must be clarified or explored first",
];
export const REASONING_LEVELS = [
	"recall: answer is direct knowledge",
	"routine: a known recipe",
	"multi-step: several dependent steps",
	"deep: careful analysis of interactions",
	"novel: design or debugging without a known recipe",
];

const yesNo = (instructions: string, yes: string, no: string): ClassifierQuestion => ({
	type: "bool",
	instructions,
	criteria: { true: yes, false: no },
});

export const LAYA_QUESTIONS: Record<string, ClassifierQuestion> = {
	library_category: {
		type: "choice",
		instructions: "Which category of the technical library does this request best match?",
		criteria: {
			languages: "language syntax, types, ownership, closures, event loop, concurrency and standard libraries",
			algorithms: "algorithms, graphs, trees, heaps, sorting, searching, data structures and complexity",
			architecture:
				"architecture, DDD, domain ownership, design patterns, module boundaries, refactoring and maintainable code",
			engineering: "testing, TDD, test quality, SOLID, linting, formatting, construction and project practices",
			databases: "databases, SQL, NoSQL, indexing, transactions, data modeling, stream processing",
			web_frontend: "REST APIs, HTTP, WebSocket, CSS, forms, accessibility, visual design and web performance",
			devops: "Git, rebasing, CI/CD, Docker, Kubernetes, cloud, observability, SRE and reliability",
			security: "SSH, SQL injection, OWASP, threats, authorization, secure review, privacy and GDPR",
			automation: "n8n, Hermes, LLM agents, agent SDKs, orchestration, workflows and integration",
			frameworks:
				"framework APIs and lifecycle: React, Next.js, Angular, Spring, Django, NestJS and similar libraries",
		},
	},
	task_type: {
		type: "choice",
		instructions: "What kind of software engineering task does the request ask for?",
		criteria: {
			question: "a question to answer, no change requested",
			code_edit: "a small, explicit change: rename, text, config value, formatting",
			bug_fix: "fix behavior that is wrong and reproducible",
			refactor: "restructure code without changing behavior",
			feature: "add new behavior or capability",
			test: "write, fix or extend tests",
			architecture: "design or evaluate structure across modules or systems",
			debugging: "investigate a failure whose cause is unknown",
			security: "find or fix a vulnerability, or change auth, secrets or permissions",
			research: "explore, compare options or explain code without changing it",
			documentation: "write or update docs, comments, READMEs or changelogs",
		},
	},
	complexity: {
		type: "score",
		instructions: "How complex is the task?",
		criteria: COMPLEXITY_LEVELS,
	},
	scope: {
		type: "choice",
		instructions: "How much of the codebase does the task touch?",
		criteria: {
			single_line: "one line or one value",
			single_file: "one file",
			module: "several files of one module or package",
			multi_module: "several modules or packages",
			repository: "the whole repository",
			multi_repository: "more than one repository or service",
		},
	},
	risk: {
		type: "score",
		instructions: "How risky is a wrong result?",
		criteria: RISK_LEVELS,
	},
	ambiguity: {
		type: "score",
		instructions: "How ambiguous is the request?",
		criteria: AMBIGUITY_LEVELS,
	},
	reasoning_requirement: {
		type: "score",
		instructions: "How much reasoning does the task need?",
		criteria: REASONING_LEVELS,
	},
	capability_tier: {
		type: "choice",
		instructions: "What is the cheapest model capability tier likely to solve the task correctly?",
		criteria: {
			fast: "small, fast model: trivial edits, lookups, simple questions",
			balanced: "mid-size model: ordinary features, fixes and refactors",
			strong: "large model: subtle bugs, risky or cross-module changes",
			frontier: "most capable model: novel design, hard debugging, critical systems",
		},
	},
	reasoning_effort: {
		type: "choice",
		instructions: "How much reasoning effort should the model spend?",
		criteria: {
			minimal: "answer or edit directly",
			low: "brief planning",
			medium: "plan the steps before acting",
			high: "analyze alternatives and edge cases",
			extra_high: "exhaustive analysis of a hard problem",
		},
	},
	agent: {
		type: "choice",
		instructions: "Which specialist should handle the task?",
		criteria: AGENTS,
	},
	validation_level: {
		type: "choice",
		instructions: "What validation should confirm the result?",
		criteria: {
			none: "nothing to validate: answers, explanations, plans",
			syntax: "check formatting or syntax only: docs, config, text",
			compile: "type check or build",
			unit_test: "run unit tests of the changed code",
			integration_test: "run integration or end-to-end tests",
			review: "careful review of the change: security, architecture, data",
		},
	},
	...Object.fromEntries(
		Object.entries(TOOL_REQUIREMENTS).map(([id, instructions]) => [
			id,
			yesNo(instructions, "yes, the task needs it", "no, the task does not need it"),
		]),
	),
	security_sensitive: yesNo(
		"Does the task touch authentication, authorization, secrets, payments, security vulnerabilities, or production data migrations?",
		"yes, it touches one of these",
		"no",
	),
};

/** The questions in laya-trainer's `.laya/decisions.json` format (`bool` is `noul` there). */
export function layaDecisionsFile(): {
	description: string;
	language: string;
	decisions: Record<string, unknown>;
} {
	return {
		description:
			"Relay adaptive execution intelligence: task profile, capability tier, effort, agent, tools and validation for a coding request.",
		language: "auto",
		decisions: Object.fromEntries(
			Object.entries(LAYA_QUESTIONS).map(([id, question]) => [
				id,
				question.type === "bool" ? { ...question, type: "noul" } : question,
			]),
		),
	};
}
