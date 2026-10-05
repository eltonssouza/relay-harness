/**
 * Tool effect classification shared by the harness pillars.
 *
 * The pillars reason about what a tool call does to the world, not about which model issued it:
 * alignment gates destructive and external effects, evidence checks that mutations are followed
 * by verification, context engineering detects superseded reads, and skill telemetry detects
 * whether a loaded resource turned into an action. Classification is deterministic and cheap.
 */

import type { AgentToolCall } from "../types.ts";

/**
 * What a tool call does.
 *
 * - `read`: observes state (files, search, listings).
 * - `write`: changes local working state in a reversible way (edit, write a file).
 * - `execute`: runs a command whose effect is not otherwise known.
 * - `verify`: runs a check whose outcome is evidence (tests, type check, build, lint).
 * - `destructive`: changes local state in a way that is hard to reverse (history rewrite, recursive delete).
 * - `external`: changes state outside the workspace (push, publish, deploy, remote infrastructure).
 */
export type ToolEffectKind = "read" | "write" | "execute" | "verify" | "destructive" | "external";

export interface ToolEffect {
	kind: ToolEffectKind;
	/** Workspace paths the call reads or writes, as given in the arguments. */
	paths: string[];
	/** Shell command, for shell tools. */
	command?: string;
	/** Why a `destructive` or `external` classification was made. */
	reason?: string;
}

/** Classifies one tool call. Return undefined to fall back to the default classification. */
export type ToolEffectClassifier = (toolCall: AgentToolCall) => ToolEffect | undefined;

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "search", "list", "cat", "view"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "multi_edit", "apply_patch", "patch", "notebook_edit"]);
const SHELL_TOOLS = new Set(["bash", "shell", "sh", "powershell", "pwsh", "exec", "terminal", "run"]);

interface CommandRule {
	pattern: RegExp;
	kind: "destructive" | "external";
	reason: string;
}

/**
 * Command patterns for effects that require authorization. Ordered: the first match wins, so
 * the force-push rule precedes the plain push rule. Matching is textual: a command that only
 * mentions an operation (`echo "git push"`) is also matched. That false positive costs one
 * authorization prompt; a false negative could cost unrecoverable work.
 */
const COMMAND_RULES: CommandRule[] = [
	{
		pattern: /\bgit\s+push\b[^\n;&|]*(?:\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/,
		kind: "destructive",
		reason: "force push rewrites remote history",
	},
	{
		pattern: /\bgit\s+reset\s+[^\n;&|]*--hard\b/,
		kind: "destructive",
		reason: "git reset --hard discards uncommitted work",
	},
	{
		pattern: /\bgit\s+clean\s+[^\n;&|]*-[a-zA-Z]*f/,
		kind: "destructive",
		reason: "git clean -f deletes untracked files",
	},
	{
		pattern: /\bgit\s+checkout\s+(?:--\s+)?\.(?:\s|$)/,
		kind: "destructive",
		reason: "git checkout . discards uncommitted changes",
	},
	{
		pattern: /\bgit\s+restore\s+(?:[^\n;&|]*\s)?\.(?:\s|$)/,
		kind: "destructive",
		reason: "git restore . discards uncommitted changes",
	},
	{
		pattern: /\bgit\s+stash\s+(?:drop|clear)\b/,
		kind: "destructive",
		reason: "git stash drop/clear deletes stashed work",
	},
	{
		pattern: /\bgit\s+branch\s+[^\n;&|]*-D\b/,
		kind: "destructive",
		reason: "git branch -D deletes an unmerged branch",
	},
	{ pattern: /\bgit\s+(?:filter-branch|filter-repo)\b/, kind: "destructive", reason: "history rewrite" },
	{
		pattern: /\bgit\s+rebase\b(?!\s+--(?:continue|abort|skip|quit)\b)/,
		kind: "destructive",
		reason: "rebase rewrites history",
	},
	{ pattern: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, kind: "destructive", reason: "recursive delete" },
	{ pattern: /\bRemove-Item\b[^\n;|]*-Recurse\b/i, kind: "destructive", reason: "recursive delete" },
	{ pattern: /\b(?:rmdir|rd)\s+\/s\b/i, kind: "destructive", reason: "recursive delete" },
	{ pattern: /\bdel\s+[^\n;&|]*\/s\b/i, kind: "destructive", reason: "recursive delete" },
	{ pattern: /\bfind\b[^\n;&|]*\s-delete\b/, kind: "destructive", reason: "find -delete" },
	{ pattern: /\b(?:mkfs|shred|dd\s+if=)/, kind: "destructive", reason: "low-level disk write" },
	{
		pattern: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
		kind: "destructive",
		reason: "destructive SQL",
	},
	{ pattern: /\bDELETE\s+FROM\s+\S+\s*(?:;|$|")/i, kind: "destructive", reason: "DELETE without WHERE" },
	{ pattern: /\bgit\s+push\b/, kind: "external", reason: "git push changes the remote" },
	{ pattern: /\b(?:npm|pnpm|yarn|bun)\s+publish\b/, kind: "external", reason: "package publish" },
	{
		pattern: /\b(?:cargo|twine|gem|dotnet\s+nuget)\s+(?:publish|upload|push)\b/,
		kind: "external",
		reason: "package publish",
	},
	{
		pattern:
			/\bgh\s+(?:pr\s+(?:create|merge|close|comment|review)|issue\s+(?:create|close|comment)|release\s+create|repo\s+(?:create|delete))\b/,
		kind: "external",
		reason: "GitHub write operation",
	},
	{
		pattern:
			/\b(?:kubectl\s+(?:apply|delete|scale|rollout)|helm\s+(?:install|upgrade|uninstall)|terraform\s+(?:apply|destroy)|pulumi\s+(?:up|destroy))\b/,
		kind: "external",
		reason: "infrastructure change",
	},
	{ pattern: /\bdocker\s+push\b/, kind: "external", reason: "image push" },
	{ pattern: /\b(?:vercel|netlify|fly|firebase)\s+deploy\b|\bvercel\s+--prod\b/, kind: "external", reason: "deploy" },
	{
		pattern: /\bcurl\b[^\n;&|]*\s-X\s*(?:POST|PUT|PATCH|DELETE)\b/i,
		kind: "external",
		reason: "remote write request",
	},
];

/** Commands whose outcome is evidence about the work: tests, type checks, builds, linters. */
const VERIFY_PATTERN =
	/\b(?:test|tests|vitest|jest|mocha|pytest|unittest|tox|nox|rspec|phpunit|go\s+(?:test|vet|build)|cargo\s+(?:test|check|build|clippy)|tsc|mypy|pyright|ruff|eslint|biome|prettier\s+--check|lint|typecheck|type-check|check|build|make|ctest|gradle|mvn|dotnet\s+(?:test|build)|swift\s+(?:test|build)|node\s+--test)\b/;

/** Classify a shell command. */
export function classifyCommand(command: string): Omit<ToolEffect, "paths"> {
	for (const rule of COMMAND_RULES) {
		if (rule.pattern.test(command)) return { kind: rule.kind, command, reason: rule.reason };
	}
	return { kind: VERIFY_PATTERN.test(command) ? "verify" : "execute", command };
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** Default classification by tool name and arguments. Unknown tools are `execute`. */
export function classifyToolCall(toolCall: AgentToolCall, custom?: ToolEffectClassifier): ToolEffect {
	const customEffect = custom?.(toolCall);
	if (customEffect) return customEffect;

	const name = toolCall.name.toLowerCase();
	const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
	const path = stringArg(args, "path", "file_path", "filePath", "file", "notebook_path");
	const paths = path ? [path] : [];

	if (SHELL_TOOLS.has(name)) {
		const command = stringArg(args, "command", "cmd", "script") ?? "";
		return { ...classifyCommand(command), paths };
	}
	if (WRITE_TOOLS.has(name)) return { kind: "write", paths };
	if (READ_TOOLS.has(name)) return { kind: "read", paths };
	return { kind: "execute", paths };
}

/** Whether an effect changes state. */
export function isMutation(kind: ToolEffectKind): boolean {
	return kind === "write" || kind === "destructive" || kind === "external";
}

/** Whether an effect needs explicit authorization before it runs. */
export function requiresAuthorization(kind: ToolEffectKind): boolean {
	return kind === "destructive" || kind === "external";
}
