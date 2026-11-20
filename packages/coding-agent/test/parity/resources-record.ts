/**
 * Reference behavior of the system prompt (`src/core/system-prompt.ts`) and the skills' prompt
 * listing (`formatSkillsForPrompt` in `src/core/skills.ts`), for the Rust port:
 *
 * - `resources/system-prompt.json`: `buildSystemPromptState` and `buildSystemPrompt` on scripted
 *   options, `diffSystemPromptSections`, and `formatSkillsForPrompt`.
 * - `resources/context.json`: the context and prompt files the resource loader reads
 *   (`context-record.ts`).
 *
 * The coding-agent package, which the prompt names for its documentation, becomes `<package>`,
 * with `/` after it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill } from "../../src/core/skills.ts";
import { formatSkillsForPrompt } from "../../src/core/skills.ts";
import {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	buildSystemPromptState,
	diffSystemPromptSections,
} from "../../src/core/system-prompt.ts";
import { contextJson } from "./context-record.ts";

export const RESOURCES_DIR = fileURLToPath(new URL("../../../../crates/fixtures/resources/", import.meta.url));

/** The coding-agent package, which the system prompt names for its documentation. */
const PACKAGE_DIR = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");

/** `<package>` for the package directory, `/` after it. */
function portable(value: unknown): unknown {
	if (typeof value === "string") {
		return value
			.split(PACKAGE_DIR)
			.join("<package>")
			.replace(/<package>[^\s)]*/g, (path) => path.replaceAll("\\", "/"));
	}
	if (Array.isArray(value)) return value.map(portable);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item)]));
	}
	return value;
}

const json = (value: unknown) => `${JSON.stringify(portable(value), null, "\t")}\n`;

const outcome = (run: () => unknown) => {
	try {
		const value = run();
		return { result: value === undefined ? "<undefined>" : value };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
};

function skill(name: string, description: string, options: { disabled?: boolean; dir?: string } = {}): Skill {
	const baseDir = `${options.dir ?? "/skills"}/${name}`;
	const filePath = `${baseDir}/SKILL.md`;
	return {
		name,
		description,
		filePath,
		baseDir,
		sourceInfo: { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir },
		disableModelInvocation: options.disabled ?? false,
	};
}

const SKILLS = [
	skill("lint", "Run the linter"),
	skill("hidden", "Only by command", { disabled: true }),
	skill("escape", `Quotes "double" and 'single', <tags> & ampersands`, { dir: "/a&b" }),
];

const SNIPPETS = {
	read: "Read file contents",
	bash: "Execute bash commands",
	edit: "Make surgical edits",
	write: "Create or overwrite files",
	custom: "A custom tool",
};

interface PromptCase {
	name: string;
	options: BuildSystemPromptOptions;
}

const PROMPT_CASES: PromptCase[] = [
	{ name: "defaults without snippets", options: { cwd: "/project" } },
	{ name: "no tools", options: { cwd: "/project", selectedTools: [] } },
	{ name: "default tools with snippets", options: { cwd: "/project", toolSnippets: SNIPPETS } },
	{
		name: "tools without snippets are left out",
		options: { cwd: "/project", selectedTools: ["read", "grep", "custom", "bash"], toolSnippets: SNIPPETS },
	},
	{
		name: "an empty snippet is left out",
		options: { cwd: "/project", selectedTools: ["read", "bash"], toolSnippets: { read: "", bash: "Run commands" } },
	},
	{ name: "bash only", options: { cwd: "/project", selectedTools: ["bash"] } },
	{ name: "PowerShell only", options: { cwd: "/project", selectedTools: ["powershell"] } },
	{ name: "bash and PowerShell", options: { cwd: "/project", selectedTools: ["powershell", "bash"] } },
	{ name: "bash with grep", options: { cwd: "/project", selectedTools: ["bash", "grep"] } },
	{ name: "bash with find", options: { cwd: "/project", selectedTools: ["bash", "find"] } },
	{ name: "PowerShell with ls", options: { cwd: "/project", selectedTools: ["powershell", "ls"] } },
	{
		name: "guidelines trimmed and deduplicated",
		options: {
			cwd: "/project",
			selectedTools: ["bash", "read"],
			toolGuidelines: {
				read: ["  Read before editing  ", "Shared rule"],
				bash: ["Shared rule", "", "   "],
				write: ["Not selected"],
			},
			promptGuidelines: ["Shared rule", " Be concise in your responses ", "Extra rule"],
		},
	},
	{
		name: "custom prompt",
		options: {
			cwd: "/project",
			customPrompt: "You are a reviewer.",
			toolSnippets: SNIPPETS,
			promptGuidelines: ["Ignored without the default prompt"],
		},
	},
	{ name: "empty custom prompt", options: { cwd: "/project", customPrompt: "" } },
	{ name: "forced prompt", options: { cwd: "/project", forceSystemPrompt: "Exact prompt.", customPrompt: "x" } },
	{ name: "empty forced prompt", options: { cwd: "/project", forceSystemPrompt: "" } },
	{
		name: "addendum, context and project guide",
		options: {
			cwd: "C:\\work\\project",
			appendSystemPrompt: "Appended instructions.",
			contextFiles: [
				{ path: "/home/AGENTS.md", content: "Global rules." },
				{ path: "C:\\work\\project\\AGENTS.md", content: 'Project rules with "quotes".\n\nTwo paragraphs.' },
			],
			projectAgentsPath: "C:\\work\\project\\AGENTS.md",
		},
	},
	{ name: "empty addendum", options: { cwd: "/project", appendSystemPrompt: "" } },
	{ name: "skills with read", options: { cwd: "/project", selectedTools: ["read", "edit"], skills: SKILLS } },
	{ name: "skills with bash", options: { cwd: "/project", selectedTools: ["write", "bash"], skills: SKILLS } },
	{ name: "skills prefer read", options: { cwd: "/project", selectedTools: ["bash", "read"], skills: SKILLS } },
	{ name: "skills without read or bash", options: { cwd: "/project", selectedTools: ["edit"], skills: SKILLS } },
	{
		name: "only hidden skills",
		options: { cwd: "/project", selectedTools: ["read"], skills: [skill("only", "Hidden", { disabled: true })] },
	},
	{
		name: "custom sections",
		options: {
			cwd: "/project",
			sections: {
				zeta: "Last section.",
				tools: "Replaced tools.",
				empty: "",
				cwd: "Replaced cwd.",
				"a-b_c9": "Named.",
			},
		},
	},
	{
		name: "custom sections after a custom prompt",
		options: { cwd: "/project", customPrompt: "Custom.", sections: { rules: "Own rules.", docs: "Own docs." } },
	},
	{ name: "section named preamble", options: { cwd: "/project", sections: { preamble: "x" } } },
	{ name: "section with a capital", options: { cwd: "/project", sections: { Bad: "x" } } },
	{ name: "section starting with a digit", options: { cwd: "/project", sections: { "9lives": "x" } } },
	{ name: "section with a space", options: { cwd: "/project", sections: { "two words": "x" } } },
	{ name: "invalid empty section", options: { cwd: "/project", sections: { "bad.name": "" } } },
];

/** Previous sections (as replayed from the transcript) and the desired ones. */
const DIFF_CASES: { name: string; previous: Record<string, string | null>; current: Record<string, string> }[] = [
	{ name: "unchanged", previous: { preamble: "p", cwd: "c" }, current: { preamble: "p", cwd: "c" } },
	{
		name: "changed, added and removed",
		previous: { preamble: "p", tools: "t", gone: "g", cwd: "c" },
		current: { preamble: "p2", tools: "t", cwd: "c", added: "a" },
	},
	{ name: "removed again", previous: { preamble: "p", gone: null }, current: { preamble: "p" } },
	{ name: "restored", previous: { preamble: "p", back: null }, current: { back: "b", preamble: "p" } },
	{ name: "from nothing", previous: {}, current: { preamble: "p", cwd: "c" } },
	{ name: "to nothing", previous: { preamble: "p" }, current: {} },
];

function systemPromptJson(): string {
	const prompts = PROMPT_CASES.map(({ name, options }) => ({
		name,
		options,
		state: outcome(() => buildSystemPromptState(options)),
		text: outcome(() => buildSystemPrompt(options)),
	}));
	const diffs = DIFF_CASES.map((testCase) => ({
		...testCase,
		...outcome(() => diffSystemPromptSections(testCase.previous, testCase.current)),
	}));
	const skillLists = [
		{ name: "none", skills: [], tool: "read" as const },
		{ name: "only hidden", skills: [SKILLS[1]], tool: "read" as const },
		{ name: "read", skills: SKILLS, tool: "read" as const },
		{ name: "bash", skills: SKILLS, tool: "bash" as const },
	].map(({ name, skills, tool }) => ({
		name,
		tool,
		skills: skills.map((s) => s.name),
		text: formatSkillsForPrompt(skills, tool),
	}));
	return json({ skills: SKILLS, prompts, diffs, skillLists });
}

export async function resourcesFiles(): Promise<Record<string, string>> {
	return { "system-prompt.json": systemPromptJson(), "context.json": await contextJson() };
}

export function readResourcesFile(name: string): string {
	return readFileSync(join(RESOURCES_DIR, name), "utf8");
}
