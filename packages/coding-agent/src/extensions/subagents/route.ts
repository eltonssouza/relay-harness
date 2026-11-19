/**
 * The `route_agent` tool: general-agents' deterministic router (`scripts/route.py`) running in
 * the Rust harness core, so an orchestrator routes without Python. It reads the routing catalog
 * and Portuguese alias table that the installed package ships (`scripts/catalog.json`,
 * `scripts/vocab_pt.json`) and answers what `route.py --json` prints.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callHarnessWasm } from "@relay-harness/agent-core/harness-wasm";
import { Type } from "typebox";
import { defineTool } from "../../core/extensions/types.ts";
import type { DefinitionSource } from "./definitions.ts";

export interface RouterData {
	/** The package that ships the router data. */
	packageRoot: string;
	agents: unknown[];
	vocabulary: { words: Array<[string, string]>; phrases: Array<[string, string]> };
}

/** The router data of the first package that ships it, or undefined. */
export function findRouterData(sources: readonly DefinitionSource[]): RouterData | undefined {
	for (const source of sources) {
		if (!source.packageRoot) continue;
		const catalog = join(source.packageRoot, "scripts", "catalog.json");
		const vocabulary = join(source.packageRoot, "scripts", "vocab_pt.json");
		if (!existsSync(catalog) || !existsSync(vocabulary)) continue;
		const { agents } = JSON.parse(readFileSync(catalog, "utf8")) as { agents?: unknown[] };
		const { words = {}, phrases = {} } = JSON.parse(readFileSync(vocabulary, "utf8")) as {
			words?: Record<string, string>;
			phrases?: Record<string, string>;
		};
		if (!Array.isArray(agents)) continue;
		// Object.entries keeps the file's order, which decides between overlapping phrases.
		return {
			packageRoot: source.packageRoot,
			agents,
			vocabulary: { words: Object.entries(words), phrases: Object.entries(phrases) },
		};
	}
	return undefined;
}

const RouteParams = Type.Object({
	request: Type.String({ description: "The request or subtask to route" }),
	top: Type.Optional(Type.Integer({ minimum: 1, description: "Most candidates to return (default 5)" })),
	domain: Type.Optional(Type.String({ description: "Keep agents whose catalog domain starts with this, such as 05" })),
});

/** Rank the catalog's agents for a request, as `route.py --json` does. */
export function routeRequest(data: RouterData, request: string, top = 5, domain?: string): unknown {
	return callHarnessWasm({
		method: "routeAgents",
		agents: data.agents,
		vocabulary: data.vocabulary,
		query: request,
		top,
		...(domain ? { domain } : {}),
	});
}

/** The `route_agent` tool over the router data `data` returns when it runs. */
export function routeAgentTool(data: () => RouterData | undefined) {
	return defineTool<typeof RouteParams, undefined>({
		name: "route_agent",
		label: "Route agent",
		description:
			"Rank the installed specialist agents for a request, deterministically: the same answer as general-agents' `scripts/route.py --json`, without Python. `clear_specialist: false` means no agent covers the request; an `exclusion_alert` term appears in a clause where the agent says it does not cover it. Confirm a candidate before delegating to it with the agent tool.",
		parameters: RouteParams,
		defaultActive: false,
		async execute(_toolCallId, params) {
			const router = data();
			if (!router) {
				return {
					content: [
						{
							type: "text",
							text: "No installed catalog ships routing data. Install general-agents with `relay agents install`.",
						},
					],
					details: undefined,
					isError: true,
				};
			}
			const result = routeRequest(router, params.request, params.top, params.domain);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }], details: undefined };
		},
	});
}
