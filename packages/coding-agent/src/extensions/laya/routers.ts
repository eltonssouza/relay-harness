import type { TaskAssessment } from "./assessment.ts";
import type { PolicyDecision } from "./policy.ts";
import { AGENTS, type AgentId, type ToolRequirement, type ValidationLevel } from "./questions.ts";

/**
 * Agent, skill and tool routing. Relay has no agent registry, so the agent is a role the plan
 * message asks the model to take. Skills are reduced hierarchically: the agent picks a keyword
 * family, and only skills matching it are named. Tools are advised by default; with
 * `laya.toolRouting: "enforce"` the tools a task clearly does not need are deactivated.
 */

/** Custom message type of the plan sent with each routed request. */
export const LAYA_PLAN_MESSAGE = "laya.plan";

const AGENT_SKILL_KEYWORDS: Record<AgentId, string[]> = {
	"software-engineer": [
		"code",
		"implement",
		"refactor",
		"typescript",
		"javascript",
		"python",
		"java",
		"golang",
		"rust",
	],
	"backend-engineer": ["api", "backend", "server", "service", "rest", "graphql", "queue", "spring", "node"],
	"frontend-engineer": [
		"frontend",
		"ui",
		"ux",
		"css",
		"react",
		"vue",
		"angular",
		"component",
		"accessibility",
		"design",
	],
	"mobile-engineer": ["mobile", "android", "ios", "swift", "kotlin", "flutter", "react-native"],
	"devops-engineer": ["devops", "ci", "deploy", "docker", "kubernetes", "infra", "terraform", "release"],
	"database-engineer": ["database", "sql", "postgres", "mysql", "migration", "schema", "query", "cockroach"],
	"security-engineer": ["security", "auth", "oauth", "vulnerab", "secret", "crypto", "audit", "compliance"],
	"software-architect": ["architecture", "system-design", "design", "ddd", "distributed", "event", "adr"],
	"qa-engineer": ["test", "qa", "testing", "coverage", "e2e", "playwright", "vitest", "jest"],
	researcher: ["research", "explain", "analysis", "docs", "compare", "documentation"],
};

export interface SkillInfo {
	name: string;
	description: string;
}

/** Up to `limit` skills whose name or description matches the agent's keyword family or the request. */
export function selectSkills(skills: readonly SkillInfo[], agent: AgentId, request: string, limit = 3): string[] {
	const keywords = AGENT_SKILL_KEYWORDS[agent];
	const requestWords = new Set(request.toLowerCase().match(/[a-z0-9-]{4,}/g) ?? []);
	return skills
		.map((skill) => {
			const name = skill.name.toLowerCase();
			const text = `${name} ${skill.description.toLowerCase()}`;
			const keywordHits = keywords.filter((keyword) => text.includes(keyword)).length;
			const requestHits = name.split(/[^a-z0-9]+/).filter((part) => requestWords.has(part)).length;
			return { name: skill.name, score: keywordHits + 2 * requestHits };
		})
		.filter((skill) => skill.score > 0)
		.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
		.slice(0, limit)
		.map((skill) => skill.name);
}

/** Tool name patterns per requirement. Tools matching none of them are never deactivated. */
const TOOL_PATTERNS: Record<ToolRequirement, RegExp> = {
	requires_write: /^(edit|write|multi_?edit|apply_patch)$/,
	requires_shell: /^bash$/,
	requires_tests: /^bash$/,
	requires_git: /^bash$/,
	requires_web: /web|fetch|search_web|http/,
	requires_browser: /browser|playwright|puppeteer/,
	requires_database: /sql|database|\bdb\b|postgres|mysql/,
};

/**
 * Tools to deactivate for this task: tools that match only requirements the task does not have.
 * `bash` serves shell, tests and git, so it stays when any of them is needed.
 */
export function unneededTools(activeTools: readonly string[], tools: Record<ToolRequirement, boolean>): string[] {
	return activeTools.filter((name) => {
		const matched = (Object.keys(TOOL_PATTERNS) as ToolRequirement[]).filter((id) => TOOL_PATTERNS[id].test(name));
		return matched.length > 0 && matched.every((id) => !tools[id]);
	});
}

const VALIDATION_HINTS: Record<ValidationLevel, string> = {
	none: "no check needed",
	syntax: "check formatting or syntax of what changed",
	compile: "run the type check or build",
	unit_test: "run the unit tests that cover the change",
	integration_test: "run the integration or end-to-end tests of the affected flow",
	review: "review the change for security, data and architectural impact, then run the relevant tests",
};

const TOOL_LABELS: Record<ToolRequirement, string> = {
	requires_write: "file edits",
	requires_shell: "shell",
	requires_tests: "tests",
	requires_web: "web",
	requires_browser: "browser",
	requires_database: "database",
	requires_git: "git",
};

/** The advisory plan sent to the model next to the user's message. */
export function renderPlanMessage(
	assessment: TaskAssessment,
	policy: PolicyDecision,
	skills: readonly string[],
	enforcedTools: readonly string[],
): string {
	const percent = (value: number) => `${Math.round(value * 100)}%`;
	const needed = (Object.keys(TOOL_LABELS) as ToolRequirement[]).filter((id) => assessment.tools[id]);
	const notNeeded = (Object.keys(TOOL_LABELS) as ToolRequirement[]).filter((id) => !assessment.tools[id]);
	const lines = [
		"[laya:plan] Execution plan from the harness router for this request (guidance, not a constraint):",
		`- Task: ${assessment.task.type.replaceAll("_", " ")}, scope ${assessment.task.scope.replaceAll("_", " ")}, complexity ${percent(assessment.task.complexity)}, risk ${percent(assessment.task.risk)}.`,
		`- Role: act as ${assessment.agent} (${AGENTS[assessment.agent]}).`,
	];
	if (skills.length > 0)
		lines.push(`- Skills likely relevant: ${skills.join(", ")}. Load one only when a step needs it.`);
	lines.push(
		`- Tools: ${needed.length > 0 ? `needs ${needed.map((id) => TOOL_LABELS[id]).join(", ")}` : "read-only"}${
			notNeeded.length > 0 ? `; not expected: ${notNeeded.map((id) => TOOL_LABELS[id]).join(", ")}` : ""
		}.`,
	);
	if (enforcedTools.length > 0) lines.push(`- Deactivated for this request: ${enforcedTools.join(", ")}.`);
	if (policy.validation.level !== "none") {
		lines.push(
			`- Validation${policy.validation.required ? " (required)" : ""}: ${VALIDATION_HINTS[policy.validation.level]} before reporting completion.`,
		);
	}
	if (policy.rules.length > 0)
		lines.push(`- Sensitive area: ${policy.rules.join(", ")}. Prefer the safest correct change.`);
	if (assessment.task.ambiguity >= 0.75) lines.push("- The request is open: confirm the goal before large changes.");
	return lines.join("\n");
}
