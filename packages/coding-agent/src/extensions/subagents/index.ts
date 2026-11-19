/**
 * Subagents: the `agent` tool, which runs agent definitions in the Claude Code format in this
 * process. Definitions load from the project (`.relay/agents`, trusted projects only), from
 * `<agent-dir>/agents`, and from installed catalogs such as general-agents; an earlier source
 * replaces a definition of the same name in a later one. The tool is declared to the model only in
 * sessions that have at least one definition. `/agents` lists them.
 */

import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionToolContext } from "../../core/extensions/types.ts";
import { installedCatalogSources } from "./catalogs.ts";
import { type AgentCatalog, type DefinitionSource, loadAgentCatalog } from "./definitions.ts";
import { findRouterData, routeAgentTool } from "./route.ts";
import { agentTool, DEFAULT_SUBAGENT_LIMITS, Limiter, type SubagentLimits } from "./tool.ts";

/** Directories that hold agent definitions, in precedence order. */
export function definitionSources(ctx: Pick<ExtensionToolContext, "cwd" | "isProjectTrusted">): DefinitionSource[] {
	const agentDir = getAgentDir();
	return [
		...(ctx.isProjectTrusted() ? [{ directory: join(ctx.cwd, CONFIG_DIR_NAME, "agents") }] : []),
		{ directory: join(agentDir, "agents") },
		...installedCatalogSources(agentDir),
	];
}

/** The catalog as lines for `/agents` and `relay agents list`. */
export function describeCatalog(catalog: AgentCatalog): string[] {
	if (catalog.agents.length === 0 && catalog.rejected.length === 0) {
		return ["No agent definitions. Install general-agents with `relay agents install`."];
	}
	const model = (agent: AgentCatalog["agents"][number]) =>
		agent.model.kind === "inherit"
			? "session model"
			: agent.model.kind === "tier"
				? agent.model.tier
				: agent.model.ref;
	return [
		...catalog.agents.map((agent) => `${agent.name} (${model(agent)}; ${agent.tools.join(", ")})`),
		...catalog.rejected.map((rejected) => `not loaded: ${rejected.filePath}: ${rejected.reason}`),
	];
}

export default function subagentsExtension(relay: ExtensionAPI): void {
	const limits = (): SubagentLimits => ({ ...DEFAULT_SUBAGENT_LIMITS, ...relay.getSettings().subagents });
	const router = () => findRouterData(installedCatalogSources(getAgentDir()));
	relay.registerTool(
		agentTool({
			depth: 1,
			get limits() {
				return limits();
			},
			catalog: (ctx): AgentCatalog => loadAgentCatalog(definitionSources(ctx)),
			settings: () => relay.getSettings(),
			limiter: new Limiter(() => limits().maxConcurrency),
			router,
		}),
	);
	relay.registerTool(routeAgentTool(router));
	relay.registerCommand("agents", {
		description: "List the agents the agent tool can delegate to",
		handler: async (_args, ctx) => {
			ctx.ui.notify(describeCatalog(loadAgentCatalog(definitionSources(ctx))).join("\n"), "info");
		},
	});
	relay.on("session_start", (_event, ctx) => {
		const active = relay.getActiveTools();
		const added = [
			...(!active.includes("agent") && loadAgentCatalog(definitionSources(ctx)).agents.length > 0 ? ["agent"] : []),
			...(!active.includes("route_agent") && router() ? ["route_agent"] : []),
		];
		if (added.length > 0) relay.setActiveTools([...active, ...added]);
	});
}
