import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, getEngineeringResourcesPath } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";

type ProfileContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

const PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Profile directories in precedence order. Project profiles load only in trusted projects. */
function profileDirectories(ctx: ProfileContext): string[] {
	return [
		...(ctx.isProjectTrusted() ? [join(ctx.cwd, CONFIG_DIR_NAME, "agents")] : []),
		join(getAgentDir(), "agents"),
		join(getEngineeringResourcesPath(), "agents"),
	];
}

/** Names of the role profiles that exist; a local profile with a shipped name replaces the shipped one. */
export function listAgentProfiles(ctx: ProfileContext): string[] {
	const names = new Set<string>();
	for (const directory of profileDirectories(ctx)) {
		if (!existsSync(directory)) continue;
		for (const file of readdirSync(directory)) {
			const name = file.endsWith(".md") ? file.slice(0, -3) : undefined;
			if (name && PROFILE_NAME.test(name)) names.add(name);
		}
	}
	return [...names].sort();
}

export function loadAgentProfile(agent: string, ctx: ProfileContext): string | undefined {
	if (!PROFILE_NAME.test(agent)) return undefined;
	const path = profileDirectories(ctx)
		.map((directory) => join(directory, `${agent}.md`))
		.find(existsSync);
	if (!path) return undefined;
	const { body } = parseFrontmatter(readFileSync(path, "utf8"));
	return `[harness:role] ${agent}\nApply this role to the current task. Repository instructions and user requirements take precedence. Context placeholders refer to the actual conversation and repository; do not invent their contents.\n${body}`;
}

export default function engineeringExtension(relay: ExtensionAPI): void {
	relay.on("resources_discover", () => ({ skillPaths: [join(getEngineeringResourcesPath(), "skills")] }));
	relay.registerCommand("agent", {
		description: "Load an engineering role for the next task",
		getArgumentCompletions: (prefix) =>
			listAgentProfiles({ cwd: process.cwd(), isProjectTrusted: () => false })
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const roles = listAgentProfiles(ctx);
			const agent = roles.find((name) => name === args.trim());
			const profile = agent && loadAgentProfile(agent, ctx);
			if (!profile) {
				ctx.ui.notify(`Usage: /agent <role> (${roles.join(", ")})`, "warning");
				return;
			}
			relay.sendUserMessage(profile, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});
}
