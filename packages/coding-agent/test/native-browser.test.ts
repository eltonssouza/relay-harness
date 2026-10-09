import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { McpClient, StdioTransport } from "@relay-harness/mcp";
import { describe, expect, it } from "vitest";
import { chromeDevtoolsConfig } from "../src/extensions/browser/index.ts";

describe("native Chrome DevTools server", () => {
	it.skipIf(process.env.RELAY_NATIVE_BROWSER_SMOKE !== "1")(
		"drives an isolated Chrome against a local page",
		async () => {
			const server = createServer((_request, response) => {
				response.writeHead(200, { "Content-Type": "text/html" });
				response.end(
					"<!doctype html><title>Relay native browser smoke</title><button onclick=\"document.getElementById('count').textContent='Count 1'\">Increment</button><p id=\"count\">Count 0</p>",
				);
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const config = chromeDevtoolsConfig();
			const client = new McpClient({
				name: "relay-local-browser-smoke",
				version: "1.0.0",
				requestTimeoutMs: 20_000,
			});
			try {
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("Missing local server address");
				await client.connect(new StdioTransport({ command: config.command, args: config.args, env: config.env }));
				const opened = await client.callTool("new_page", { url: `http://127.0.0.1:${address.port}/` });
				expect(opened.isError).not.toBe(true);
				const pageText = opened.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				const pageIdText = /^(\d+): Relay native browser smoke/m.exec(pageText)?.[1];
				expect(pageIdText, pageText).toBeDefined();
				const pageId = Number(pageIdText);
				const snapshot = await client.callTool("take_snapshot", { pageId });
				const text = snapshot.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				const uid = /uid=(\S+)[^\n]*button "Increment"/.exec(text)?.[1];
				expect(uid, text).toBeDefined();
				const clicked = await client.callTool("click", { uid, pageId });
				expect(clicked.isError).not.toBe(true);
				const updated = await client.callTool("take_snapshot", { pageId });
				expect(JSON.stringify(updated.content)).toContain("Count 1");
			} finally {
				await client.close();
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		},
	);
	it("uses installed pinned assets, isolated browser and deferred exposure", () => {
		const config = chromeDevtoolsConfig();
		expect(existsSync(config.args![0])).toBe(true);
		expect(config.args).toEqual(
			expect.arrayContaining(["--isolated", "--headless", "--no-usage-statistics", "--no-performance-crux"]),
		);
		expect(config.exposure).toBe("deferred");
		expect(chromeDevtoolsConfig(false).args).not.toContain("--headless");
	});
	it("connects through Relay MCP and discovers upstream browser tools without launching Chrome", async () => {
		const config = chromeDevtoolsConfig();
		const transport = new StdioTransport({ command: config.command, args: config.args, env: config.env });
		const client = new McpClient({ name: "relay-native-browser-test", version: "1.0.0" });
		try {
			const initialized = await client.connect(transport);
			expect(initialized.serverInfo.version).toBe("1.10.1");
			const tools = await client.listTools();
			expect(tools.map((tool) => tool.name)).toEqual(
				expect.arrayContaining([
					"take_snapshot",
					"take_screenshot",
					"list_console_messages",
					"list_network_requests",
					"performance_start_trace",
				]),
			);
		} finally {
			await client.close();
		}
	});
});
