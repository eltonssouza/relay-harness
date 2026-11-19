/**
 * Subagents: the `agent` tool, which runs agent definitions in the Claude Code format in this
 * process. Definitions load from the project (`.relay/agents`, trusted projects only) and from
 * `<agent-dir>/agents`; a project definition replaces a user one of the same name. The tool is
 * declared to the model only in sessions that have at least one definition.
 */

import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionToolContext } from "../../core/extensions/types.ts";
import { type AgentCatalog, type DefinitionSource, loadAgentCatalog } from "./definitions.ts";
import { agentTool, DEFAULT_SUBAGENT_LIMITS, Limiter, type SubagentLimits } from "./tool.ts";

/** Directories that hold agent definitions, in precedence order. */
export function definitionSources(ctx: Pick<ExtensionToolContext, "cwd" | "isProjectTrusted">): DefinitionSource[] {
	return [
		...(ctx.isProjectTrusted() ? [{ directory: join(ctx.cwd, CONFIG_DIR_NAME, "agents") }] : []),
		{ directory: join(getAgentDir(), "agents") },
	];
}

export default function subagentsExtension(relay: ExtensionAPI): void {
	const limits = (): SubagentLimits => ({ ...DEFAULT_SUBAGENT_LIMITS, ...relay.getSettings().subagents });
	relay.registerTool(
		agentTool({
			depth: 1,
			get limits() {
				return limits();
			},
			catalog: (ctx): AgentCatalog => loadAgentCatalog(definitionSources(ctx)),
			settings: () => relay.getSettings(),
			limiter: new Limiter(() => limits().maxConcurrency),
		}),
	);
	relay.on("session_start", (_event, ctx) => {
		const active = relay.getActiveTools();
		if (active.includes("agent") || loadAgentCatalog(definitionSources(ctx)).agents.length === 0) return;
		relay.setActiveTools([...active, "agent"]);
	});
}
