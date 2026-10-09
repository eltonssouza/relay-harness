import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, getEngineeringResourcesPath } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { AGENT_IDS, type AgentId } from "../laya/questions.ts";

/** Local profiles with the same name replace the shipped profile, only in trusted projects. */
export function loadAgentProfile(
	agent: AgentId,
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
): string | undefined {
	const paths = [
		...(ctx.isProjectTrusted() ? [join(ctx.cwd, CONFIG_DIR_NAME, "agents", `${agent}.md`)] : []),
		join(getAgentDir(), "agents", `${agent}.md`),
		join(getEngineeringResourcesPath(), "agents", `${agent}.md`),
	];
	const path = paths.find(existsSync);
	if (!path) return undefined;
	const { body } = parseFrontmatter(readFileSync(path, "utf8"));
	return `[harness:role] ${agent}\nApply this role to the current task. Repository instructions and user requirements take precedence. Context placeholders refer to the actual conversation and repository; do not invent their contents.\n${body}`;
}

export default function engineeringExtension(relay: ExtensionAPI): void {
	relay.on("resources_discover", () => ({ skillPaths: [join(getEngineeringResourcesPath(), "skills")] }));
	relay.registerCommand("agent", {
		description: "Load an engineering role for the next task",
		getArgumentCompletions: (prefix) =>
			AGENT_IDS.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const agent = AGENT_IDS.find((name) => name === args.trim());
			const profile = agent && loadAgentProfile(agent, ctx);
			if (!profile) {
				ctx.ui.notify(`Usage: /agent <role> (${AGENT_IDS.join(", ")})`, "warning");
				return;
			}
			relay.sendUserMessage(profile, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});
}
