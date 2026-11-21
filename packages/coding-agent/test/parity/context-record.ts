/**
 * Reference behavior of the context and prompt files the resource loader reads
 * (`src/core/resource-loader.ts`, `findGitPaths` in `src/core/footer-data-provider.ts`), for the
 * Rust port: `resources/context.json` holds, over a tree of folders and git layouts, the git paths
 * found from each folder, the context files (`AGENTS.md`, `CLAUDE.md`) loaded for it and the
 * project guide's path, then the system prompt and appended prompt `DefaultResourceLoader` reads
 * with and without project trust and explicit sources.
 *
 * The temporary directory becomes `<root>`, with `/` after it. Context files outside it (in the
 * machine's own folders above the temporary directory) are left out. In file contents, `<root>`
 * stands for the directory itself, so a worktree's `.git` file can point at an absolute git dir.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findGitPaths } from "../../src/core/footer-data-provider.ts";
import { DefaultResourceLoader, loadProjectContextFiles } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

/** `<root>` for the tree, `/` after it. */
function portable(value: unknown, root: string): unknown {
	if (typeof value === "string") {
		return value
			.split(root)
			.join("<root>")
			.replace(/<root>[^"'\s)]*/g, (path) => path.replaceAll("\\", "/"));
	}
	if (Array.isArray(value)) return value.map((item) => portable(item, root));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item, root)]));
	}
	return value;
}

/** Paths of the tree and their contents; `null` makes a folder. */
const TREE: [string, string | null][] = [
	["agent/AGENTS.md", "Global rules."],
	["work/AGENTS.md", "Work rules."],
	["work/plain/CLAUDE.md", "Plain rules from CLAUDE.md."],
	["work/plain/sub", null],
	["work/over/AGENTS.override.md", "Override rules."],
	["work/over/AGENTS.md", "Shadowed by the override."],
	["work/folder/AGENTS.md", null],
	["work/folder/CLAUDE.md", "AGENTS.md is a folder here."],
	["work/bom/AGENTS.md", "﻿Rules after a byte order mark."],
	["work/both/CLAUDE.md", "CLAUDE.md loses to AGENTS.md."],
	["work/both/AGENTS.md", "AGENTS.md wins."],
	["work/empty", null],
	["repo/.git/HEAD", "ref: refs/heads/main\n"],
	["repo/AGENTS.md", "Main repository rules."],
	["repo/src/deep", null],
	["repo/.git/worktrees/wt/HEAD", "ref: refs/heads/wt\n"],
	["repo/.git/worktrees/wt/commondir", "../..\n"],
	["repo/wt/.git", "gitdir: <root>/repo/.git/worktrees/wt\n"],
	["repo/wt/AGENTS.md", "Worktree rules."],
	["repo/wt/inner", null],
	["repo/.git/worktrees/bare-wt/HEAD", "ref: refs/heads/bare-wt\n"],
	["repo/.git/worktrees/bare-wt/commondir", "../.."],
	["repo/plainwt/.git", "gitdir: <root>/repo/.git/worktrees/bare-wt"],
	["repo/.git/worktrees/rel/HEAD", "ref: refs/heads/rel\n"],
	["repo/.git/worktrees/rel/commondir", "../..\n"],
	["repo/relwt/.git", "  gitdir:   ../.git/worktrees/rel  \n"],
	["repo/relwt/CLAUDE.md", "Relative worktree rules."],
	["repo/missing/.git", "gitdir: <root>/repo/.git/worktrees/none\n"],
	["repo/odd/.git", "not a gitdir line\n"],
	["repo/.git/modules/sub/HEAD", "ref: refs/heads/main\n"],
	["repo/sub/.git", "gitdir: <root>/repo/.git/modules/sub\n"],
	["repo/sub/AGENTS.md", "Submodule rules."],
	["proj/.bare/HEAD", "ref: refs/heads/main\n"],
	["proj/.bare/worktrees/main/HEAD", "ref: refs/heads/main\n"],
	["proj/.bare/worktrees/main/commondir", "../..\n"],
	["proj/main/.git", "gitdir: <root>/proj/.bare/worktrees/main\n"],
	["proj/AGENTS.md", "Bare layout parent rules."],
	["proj/main/AGENTS.md", "Bare layout worktree rules."],
	["sibling/.git/worktrees/side/HEAD", "ref: refs/heads/side\n"],
	["sibling/.git/worktrees/side/commondir", "../..\n"],
	["sibling/AGENTS.md", "Sibling main rules."],
	["side/.git", "gitdir: <root>/sibling/.git/worktrees/side\n"],
	["side/AGENTS.md", "Sibling worktree rules."],
	["sibling/.git/HEAD", "ref: refs/heads/main\n"],
	["nohead/.git", null],
	["nohead/inside", null],
	["sp/agent/SYSTEM.md", "Global system prompt."],
	["sp/agent/APPEND_SYSTEM.md", "Global appended prompt."],
	["sp/proj/.relay/SYSTEM.md", "﻿Project system prompt."],
	["sp/proj/.relay/APPEND_SYSTEM.md", "Project appended prompt."],
	["sp/onlyglobal/.relay", null],
	["sp/emptyagent", null],
	["sp/bare", null],
	["sp/extra.md", "﻿Extra prompt file."],
	["sp/folder.md", null],
];

/** Folders the context files are loaded for, and the agent directory. */
const CONTEXT_CASES: { cwd: string; agentDir: string }[] = [
	{ cwd: "work/plain/sub", agentDir: "agent" },
	{ cwd: "work/over", agentDir: "agent" },
	{ cwd: "work/folder", agentDir: "agent" },
	{ cwd: "work/bom", agentDir: "agent" },
	{ cwd: "work/both", agentDir: "agent" },
	{ cwd: "work/empty", agentDir: "work" },
	{ cwd: "work/plain/sub", agentDir: "work/plain" },
	{ cwd: "work/empty", agentDir: "missing/agent" },
	{ cwd: "repo/src/deep", agentDir: "agent" },
	{ cwd: "repo/wt", agentDir: "agent" },
	{ cwd: "repo/wt/inner", agentDir: "agent" },
	{ cwd: "repo/plainwt", agentDir: "agent" },
	{ cwd: "repo/relwt", agentDir: "agent" },
	{ cwd: "repo/missing", agentDir: "agent" },
	{ cwd: "repo/odd", agentDir: "agent" },
	{ cwd: "repo/sub", agentDir: "agent" },
	{ cwd: "proj/main", agentDir: "agent" },
	{ cwd: "side", agentDir: "agent" },
	{ cwd: "nohead/inside", agentDir: "agent" },
	{ cwd: "missing/folder", agentDir: "agent" },
];

/** Resource loader options for the system prompt files; `<root>` in a source is the directory. */
interface PromptCase {
	name: string;
	cwd: string;
	agentDir: string;
	trusted: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	noContextFiles?: boolean;
}

const PROMPT_CASES: PromptCase[] = [
	{ name: "trusted project", cwd: "sp/proj", agentDir: "sp/agent", trusted: true },
	{ name: "untrusted project", cwd: "sp/proj", agentDir: "sp/agent", trusted: false },
	{ name: "project without files", cwd: "sp/onlyglobal", agentDir: "sp/agent", trusted: true },
	{ name: "nothing to find", cwd: "sp/bare", agentDir: "sp/emptyagent", trusted: true },
	{ name: "inline prompt", cwd: "sp/proj", agentDir: "sp/agent", trusted: true, systemPrompt: "Inline prompt." },
	{ name: "prompt file", cwd: "sp/bare", agentDir: "sp/agent", trusted: true, systemPrompt: "<root>/sp/extra.md" },
	{ name: "empty prompt", cwd: "sp/proj", agentDir: "sp/agent", trusted: true, systemPrompt: "" },
	{
		name: "unreadable prompt file",
		cwd: "sp/bare",
		agentDir: "sp/agent",
		trusted: true,
		systemPrompt: "<root>/sp/folder.md",
	},
	{
		name: "appended sources",
		cwd: "sp/proj",
		agentDir: "sp/agent",
		trusted: true,
		appendSystemPrompt: ["Inline addition.", "<root>/sp/extra.md", "", "<root>/sp/missing.md", "<root>/sp/folder.md"],
	},
	{ name: "no appended sources", cwd: "sp/proj", agentDir: "sp/agent", trusted: true, appendSystemPrompt: [] },
	{ name: "no context files", cwd: "repo/wt", agentDir: "agent", trusted: true, noContextFiles: true },
	{ name: "context files of a worktree", cwd: "repo/wt", agentDir: "agent", trusted: true },
	{ name: "below a repository root", cwd: "repo/src/deep", agentDir: "agent", trusted: true },
];

function makeTree(root: string): void {
	for (const [path, content] of TREE) {
		const full = join(root, path);
		if (content === null) mkdirSync(full, { recursive: true });
		else {
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, content.replaceAll("<root>", root));
		}
	}
}

export async function contextJson(): Promise<string> {
	// The real path, so the tree's spelling is the one git and `realpathSync` report.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-context-")));
	try {
		makeTree(root);
		const at = (path: string) => join(root, path);
		const inTree = (file: { path: string }) => file.path.startsWith(root);
		const context = CONTEXT_CASES.map(({ cwd, agentDir }) => ({
			cwd,
			agentDir,
			gitPaths: findGitPaths(at(cwd)),
			files: loadProjectContextFiles({ cwd: at(cwd), agentDir: at(agentDir) }).filter(inTree),
		}));
		const prompts: unknown[] = [];
		for (const testCase of PROMPT_CASES) {
			const source = (text: string) => text.replaceAll("<root>", root);
			const loader = new DefaultResourceLoader({
				cwd: at(testCase.cwd),
				agentDir: at(testCase.agentDir),
				settingsManager: SettingsManager.inMemory({}, { projectTrusted: testCase.trusted }),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: testCase.noContextFiles,
				systemPrompt: testCase.systemPrompt === undefined ? undefined : source(testCase.systemPrompt),
				appendSystemPrompt: testCase.appendSystemPrompt?.map(source),
			});
			await loader.reload();
			const agents = loader.getAgentsFiles();
			prompts.push({
				...testCase,
				systemPrompt: loader.getSystemPrompt() ?? "<undefined>",
				systemPromptSource: loader.getSystemPromptSource()?.path ?? "<undefined>",
				appendSystemPrompt: loader.getAppendSystemPrompt(),
				appendSystemPromptSources: loader.getAppendSystemPromptSources().map((entry) => entry.path),
				agentsFiles: agents.agentsFiles.filter(inTree),
				projectAgentsPath: agents.projectAgentsPath ?? "<undefined>",
				options: { systemPrompt: testCase.systemPrompt, appendSystemPrompt: testCase.appendSystemPrompt },
			});
		}
		return `${JSON.stringify(portable({ tree: TREE, context, prompts }, root), null, "\t")}\n`;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
