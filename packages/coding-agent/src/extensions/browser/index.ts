import { getChromeDevtoolsEntrypoint, isBunRuntime } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { McpStdioServerConfig } from "../../core/mcp-servers.ts";

export function chromeDevtoolsConfig(headless = true): McpStdioServerConfig {
	return {
		command: isBunRuntime ? "node" : process.execPath,
		args: [
			getChromeDevtoolsEntrypoint(),
			"--isolated",
			...(headless ? ["--headless"] : []),
			"--no-usage-statistics",
			"--no-performance-crux",
		],
		env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: "1" },
		exposure: "deferred",
		description:
			"Native Chrome DevTools: inspect pages, console, network, screenshots and performance; automate browser interactions.",
	};
}

export default function browserExtension(relay: ExtensionAPI): void {
	// Resolving assets and starting the child process happen only on explicit activation.
	relay.registerCommand("browser", {
		description: "Start the bundled Chrome DevTools server: start, visible, stop, status",
		handler: async (args, ctx) => {
			switch (args.trim() || "status") {
				case "start":
				case "visible":
					relay.registerMcpServer("chrome-devtools", chromeDevtoolsConfig(args.trim() !== "visible"));
					ctx.ui.notify(
						"Chrome DevTools registered. Use /mcp for connection status and tool_search to load browser tools. An mcp.json entry takes precedence.",
					);
					return;
				case "stop":
					relay.unregisterMcpServer("chrome-devtools");
					ctx.ui.notify(
						"Removed the native Chrome DevTools registration. Servers defined in mcp.json remain managed by /mcp.",
					);
					return;
				case "status":
					ctx.ui.notify(
						"Use /mcp for connection status; /browser start activates isolated headless Chrome, /browser visible activates isolated visible Chrome.",
					);
					return;
				default:
					ctx.ui.notify("Usage: /browser [start|visible|stop|status]", "warning");
			}
		},
	});
}
