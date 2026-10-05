/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   relay -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@relay-harness/coding-agent";
import { createBashTool } from "@relay-harness/coding-agent";

export default function (relay: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, RELAY_SPAWN_HOOK: "1" },
		}),
	});

	relay.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
