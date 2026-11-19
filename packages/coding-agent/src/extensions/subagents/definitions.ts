/**
 * Agent definitions in the Claude Code format: a Markdown file whose frontmatter names the agent,
 * describes when to use it, and lists its `tools` and `model`; the body is its system prompt.
 *
 *   ---
 *   name: go-expert
 *   description: Go specialist. Use for Go code.
 *   tools: Read, Grep, Glob, Bash, Edit
 *   model: sonnet
 *   ---
 *   You are a Go specialist...
 *
 * Tool names map to Relay's tools. A definition naming a tool Relay does not have is rejected
 * when it loads, with the reason, instead of running without the tool it expects.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITY_TIERS, type CapabilityTier } from "../../core/model-tiers.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";

/** Claude Code tool names and Relay's own, mapped to Relay tools. `agent` delegates further. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
	read: "read",
	grep: "grep",
	glob: "find",
	find: "find",
	ls: "ls",
	bash: "bash",
	edit: "edit",
	write: "write",
	agent: "agent",
	task: "agent",
};

/** Tools of a definition that lists none: Claude Code gives such an agent every tool. */
export const DEFAULT_SUBAGENT_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];

/** Claude Code's model aliases, as capability tiers. */
const MODEL_TIERS: Readonly<Record<string, CapabilityTier>> = { haiku: "fast", sonnet: "balanced", opus: "strong" };

const AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Which model a definition asks for. */
export type ModelChoice = { kind: "inherit" } | { kind: "tier"; tier: CapabilityTier } | { kind: "model"; ref: string };

export interface AgentDefinition {
	name: string;
	description: string;
	/** Relay tool names. */
	tools: string[];
	model: ModelChoice;
	/** The system prompt, with `<PKG>` and `<ROOT>` still in place. */
	prompt: string;
	filePath: string;
	/** Root of the package the definition came from, which `<PKG>` names. */
	packageRoot?: string;
	/** Root of the collection the package belongs to, which `<ROOT>` names. */
	collectionRoot?: string;
}

export interface RejectedDefinition {
	filePath: string;
	reason: string;
}

export interface AgentCatalog {
	agents: AgentDefinition[];
	rejected: RejectedDefinition[];
}

function toolList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) return value.map(String);
	if (typeof value === "string") return value.split(",");
	return undefined;
}

function modelChoice(value: unknown): ModelChoice | string {
	if (value === undefined || value === null || value === "" || value === "inherit") return { kind: "inherit" };
	if (typeof value !== "string") return "`model` must be a string";
	const alias = MODEL_TIERS[value.toLowerCase()];
	if (alias) return { kind: "tier", tier: alias };
	if ((CAPABILITY_TIERS as readonly string[]).includes(value)) return { kind: "tier", tier: value as CapabilityTier };
	return { kind: "model", ref: value };
}

/** Parse one definition file. Returns the reason when it cannot run in Relay. */
export function parseAgentDefinition(
	content: string,
	filePath: string,
	roots: Pick<DefinitionSource, "packageRoot" | "collectionRoot"> = {},
): AgentDefinition | RejectedDefinition {
	const { frontmatter, body } = parseFrontmatter(content);
	const { name, description } = frontmatter;
	if (typeof name !== "string" || !AGENT_NAME.test(name)) {
		return { filePath, reason: "`name` must be lowercase letters, digits and dashes" };
	}
	if (typeof description !== "string" || description.trim() === "") {
		return { filePath, reason: "`description` is missing" };
	}
	const listed = toolList(frontmatter.tools);
	const tools: string[] = [];
	for (const entry of listed ?? []) {
		const tool = entry.trim();
		if (tool === "") continue;
		const mapped = TOOL_NAMES[tool.toLowerCase()];
		if (!mapped) return { filePath, reason: `tool \`${tool}\` is not available in Relay` };
		if (!tools.includes(mapped)) tools.push(mapped);
	}
	const model = modelChoice(frontmatter.model);
	if (typeof model === "string") return { filePath, reason: model };
	return {
		name,
		description: description.trim(),
		tools: listed ? tools : [...DEFAULT_SUBAGENT_TOOLS],
		model,
		prompt: body.trim(),
		filePath,
		...(roots.packageRoot ? { packageRoot: roots.packageRoot } : {}),
		...(roots.collectionRoot ? { collectionRoot: roots.collectionRoot } : {}),
	};
}

/** A directory of `*.md` definitions, and the roots `<PKG>` and `<ROOT>` name for them. */
export interface DefinitionSource {
	directory: string;
	packageRoot?: string;
	collectionRoot?: string;
}

/** Load the definitions of every source. A name in an earlier source replaces the same name in a later one. */
export function loadAgentCatalog(sources: readonly DefinitionSource[]): AgentCatalog {
	const agents = new Map<string, AgentDefinition>();
	const rejected: RejectedDefinition[] = [];
	for (const source of sources) {
		if (!existsSync(source.directory)) continue;
		for (const file of readdirSync(source.directory).sort()) {
			if (!file.endsWith(".md")) continue;
			const filePath = join(source.directory, file);
			const parsed = parseAgentDefinition(readFileSync(filePath, "utf8"), filePath, source);
			if ("reason" in parsed) rejected.push(parsed);
			else if (!agents.has(parsed.name)) agents.set(parsed.name, parsed);
		}
	}
	return { agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)), rejected };
}

/**
 * The system prompt with the placeholders of an installed package replaced: `<PKG>` is the
 * package's folder and `<ROOT>` the collection's, as general-agents uses them. A definition that
 * did not come from a package keeps them as written.
 */
export function agentPrompt(definition: AgentDefinition): string {
	let prompt = definition.prompt;
	if (definition.packageRoot) prompt = prompt.replaceAll("<PKG>", definition.packageRoot);
	if (definition.collectionRoot) prompt = prompt.replaceAll("<ROOT>", definition.collectionRoot);
	return prompt;
}
