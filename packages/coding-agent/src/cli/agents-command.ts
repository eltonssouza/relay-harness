/**
 * `relay agents`: install the pinned general-agents catalog and list the agent definitions the
 * `agent` tool can run.
 *
 *   relay agents install [--from <path>]
 *   relay agents list
 */

import { GENERAL_AGENTS, hasPython, installCatalog } from "../extensions/subagents/catalogs.ts";
import { loadAgentCatalog } from "../extensions/subagents/definitions.ts";
import { definitionSources, describeCatalog } from "../extensions/subagents/index.ts";

const USAGE = `Usage:
  relay agents install [--from <path>]   Install general-agents at commit ${GENERAL_AGENTS.commit.slice(0, 12)}
  relay agents list                      List the agents the agent tool can run

--from installs a local copy instead of fetching it, for offline machines. A copy with git history
must be at the pinned commit.`;

export interface AgentsCommandOptions {
	agentDir: string;
	cwd: string;
	log?: (line: string) => void;
	error?: (line: string) => void;
}

/** Run `relay agents <args>`; returns the exit code. */
export async function runAgentsCommand(args: string[], options: AgentsCommandOptions): Promise<number> {
	const log = options.log ?? console.log;
	const error = options.error ?? console.error;
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h")) {
		log(USAGE);
		return 0;
	}
	if (command === "install") {
		const fromIndex = rest.indexOf("--from");
		const from = fromIndex >= 0 ? rest[fromIndex + 1] : undefined;
		if (fromIndex >= 0 && !from) {
			error("--from needs a path");
			return 1;
		}
		try {
			log(
				from
					? `Installing general-agents from ${from}...`
					: `Fetching general-agents at ${GENERAL_AGENTS.commit}...`,
			);
			const result = installCatalog({ agentDir: options.agentDir, from });
			log(`Installed ${result.catalog.agents.length} agents into ${result.directory}.`);
			for (const rejected of result.catalog.rejected) log(`not loaded: ${rejected.filePath}: ${rejected.reason}`);
			if (!hasPython()) {
				log("Python 3 is not on PATH: the agents work, but their skill and lookup scripts cannot run.");
			}
			return 0;
		} catch (cause) {
			error(`relay agents install: ${cause instanceof Error ? cause.message : String(cause)}`);
			return 1;
		}
	}
	if (command === "list") {
		// Project definitions are listed only from a trusted session, as the tool loads them.
		const catalog = loadAgentCatalog(definitionSources({ cwd: options.cwd, isProjectTrusted: () => false }));
		for (const line of describeCatalog(catalog)) log(line);
		return 0;
	}
	error(USAGE);
	return 1;
}
