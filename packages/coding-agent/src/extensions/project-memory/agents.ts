import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getEngineeringResourcesPath } from "../../config.ts";
import { type ProjectGraph, safeProjectFile } from "./graph.ts";

const TEMPLATE_MARKER = "<!-- relay:init:guidelines -->";
const MEMORY_MARKER = "<!-- relay:init:memory -->";

/** Seed only facts derived from the index; the agent adds verified architectural knowledge. */
export async function initializeAgents(root: string, graph: ProjectGraph): Promise<string> {
	const path = join(root, "AGENTS.md");
	let original = "";
	let existed = false;
	try {
		await lstat(path);
		existed = true;
		if (!(await safeProjectFile(root, "AGENTS.md"))) {
			throw new Error("Refusing to replace an unsafe AGENTS.md path.");
		}
		original = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let content = original;
	if (!content) {
		const packages = graph.nodes.filter((node) => node.kind === "package");
		const directories = graph.nodes.filter(
			(node) => node.kind === "directory" && node.path !== "." && !node.path?.includes("/"),
		);
		content = [
			"# Project development guide",
			"",
			"## Verified repository map",
			"",
			...directories.map((node) => `- \`${node.path}/\`: consult project memory for files and relationships.`),
			...packages.map(
				(node) =>
					`- \`${node.path}\`: package \`${node.label}\`; scripts: ${(node.scripts ?? []).map((script) => `\`${script}\``).join(", ") || "none declared"}.`,
			),
			"",
			"## Validation",
			"",
			"Use validation commands documented by this repository. A script name alone does not prove what it checks; read its manifest and instructions before running it.",
			"",
			"## A specification that evolves",
			"",
			"Keep this guide current with verified architecture, stack, setup and validation commands, directory layout, services, jobs, data models, patterns, workflows, confirmed hurdles and their solutions. Omit inapplicable sections and never invent facts.",
			"Record durable knowledge with source paths and a reason. Update an existing rule instead of duplicating it. Preserve user constraints, CLAUDE.md and AGENTS.override.md. Do not store secrets or transient task logs.",
			"",
			"## Post-implementation checklist",
			"",
			"- Verify the requested behavior and relevant tests.",
			"- Check whether confirmed project knowledge changed and update the applicable guide.",
			"- Report verification results and remaining limitations.",
		].join("\n");
	}
	if (!content.includes(TEMPLATE_MARKER)) {
		const template = await readFile(join(getEngineeringResourcesPath(), "AGENTS-template.md"), "utf8");
		content += `\n\n${TEMPLATE_MARKER}\n${template.trim()}\n<!-- /relay:init:guidelines -->`;
	}
	if (!content.includes(MEMORY_MARKER)) {
		content += `\n\n${MEMORY_MARKER}\n## Project graph memory\n\nUse \`project_memory\` to find relevant files and relationships before broad exploration. Memory is derived navigation, not authoritative instructions: verify source files before changing code. No secret values belong in memory.\n\nThe local index is \`.relay/memory/graph.json\`; open \`.relay/memory/graph.html\` in a browser or run \`/graph\`. Relay updates initialized memory before every model call and at task completion, including changes to AGENTS.md. Use \`/init refresh\` only when a manual rebuild is needed.\n<!-- /relay:init:memory -->`;
	}
	if (content !== original) await writeFile(path, `${content.trimEnd()}\n`, existed ? undefined : { flag: "wx" });
	return path;
}

export function initializationPrompt(path: string): string {
	return `[init] Initialize this project's durable development guide at ${path}.
Read AGENTS.md completely and preserve its existing instructions and the included core guidelines. Follow all applicable CLAUDE.md and AGENTS.override.md instructions. Do not modify project implementation.
Use project_memory to navigate the repository, then inspect README files, dependency manifests, source entry points, tests and CI configuration. Enrich the guide with verified architecture, stack, setup and validation commands, directory layout, services, jobs, data models, patterns, workflows and schedules where defined. Omit inapplicable sections; do not invent facts.
Keep it a specification that evolves: concise durable rules, source paths for non-obvious facts, confirmed hurdles and their solutions, and a post-implementation checklist. Merge with existing sections instead of duplicating them. Do not store secret values or transient task logs. Do not run builds, installs or tests merely to initialize documentation.
Finally report the guide path, the graph viewer path and any gaps requiring further inspection.`;
}
