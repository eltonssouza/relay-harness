import { Type } from "typebox";
import { getNativeMcpEntrypoint, isBunRuntime } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { McpStdioServerConfig } from "../../core/mcp-servers.ts";
import { chromeDevtoolsConfig } from "../browser/index.ts";

export type NativeMcpServer = "context7" | "playwright" | "chrome-devtools";

export function nativeMcpConfig(server: NativeMcpServer): McpStdioServerConfig {
	if (server === "chrome-devtools") return chromeDevtoolsConfig();
	return {
		command: isBunRuntime ? "node" : process.execPath,
		args: [
			getNativeMcpEntrypoint(server),
			...(server === "context7" ? ["--transport", "stdio"] : ["--isolated", "--headless", "--browser", "chrome"]),
		],
		exposure: "deferred",
		description:
			server === "context7"
				? "Local Context7 MCP process: retrieves up-to-date library documentation from Context7's external service."
				: "Local Playwright MCP process: isolated browser automation, page inspection, screenshots and testing.",
	};
}

export default function nativeMcpExtension(relay: ExtensionAPI): void {
	relay.registerTool({
		name: "native_mcp",
		label: "Native MCP servers",
		description:
			"Start or stop installed local Context7, Playwright or Chrome DevTools MCP servers on demand. No npx, runtime package downloads or remote MCP connection. Context7 retrieves external documentation. After starting, discover server tools with tool_search; use /mcp for connection diagnostics. A matching mcp.json entry takes precedence.",
		exposure: "deferred",
		parameters: Type.Object({
			server: Type.Union([Type.Literal("context7"), Type.Literal("playwright"), Type.Literal("chrome-devtools")]),
			action: Type.Union([Type.Literal("start"), Type.Literal("stop")]),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			try {
				if (params.action === "stop") relay.unregisterMcpServer(params.server);
				else if (!relay.getMcpServers().some((entry) => entry.name === params.server))
					relay.registerMcpServer(params.server, nativeMcpConfig(params.server));
				return {
					content: [
						{
							type: "text",
							text:
								params.action === "start"
									? `${params.server} registered locally. Use tool_search to wait for discovery and load its tools; /mcp shows connection errors. A configured mcp.json server with this name takes precedence.`
									: `${params.server} native registration removed. Servers configured in mcp.json remain managed by /mcp.`,
						},
					],
					details: { server: params.server, action: params.action },
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot start native MCP: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: { server: params.server, action: params.action },
					isError: true,
				};
			}
		},
	});
	relay.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.native_mcp =
			"Native local MCP servers are installed: Context7 (external library documentation), Playwright (browser automation) and Chrome DevTools (browser inspection). They are not launched until requested. Discover native_mcp with tool_search, start the server you need, then discover its tools. No remote MCP endpoint or mcp.json setup is required.";
	});
}
