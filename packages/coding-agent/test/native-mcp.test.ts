import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@relay-harness/ai";
import { McpClient, StdioTransport } from "@relay-harness/mcp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getNativeMcpEntrypoint } from "../src/config.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import nativeMcpExtension, { type NativeMcpServer, nativeMcpConfig } from "../src/extensions/native-mcp/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	vi.unstubAllEnvs();
});

it("does not launch or register native servers until requested, and supports start/stop", async () => {
	let relay!: ExtensionAPI;
	harness = await createHarness({
		extensionFactories: [
			(api) => {
				relay = api;
				nativeMcpExtension(api);
			},
		],
		settings: { harnessCore: { evidence: false } },
	});
	expect(relay.getMcpServers()).toEqual([]);
	relay.setActiveTools(["native_mcp"]);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("native_mcp", { server: "context7", action: "start" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Registered"),
	]);
	await harness.session.prompt("Start Context7");
	expect(relay.getMcpServers()).toEqual([
		expect.objectContaining({
			name: "context7",
			config: expect.objectContaining({ command: process.execPath, exposure: "deferred" }),
		}),
	]);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("native_mcp", { server: "context7", action: "stop" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Stopped"),
	]);
	await harness.session.prompt("Stop Context7");
	expect(relay.getMcpServers()).toEqual([]);
});

it.each(["context7", "playwright", "chrome-devtools"] as const)(
	"uses an installed local entrypoint for %s, never npx or remote MCP",
	(server) => {
		const config = nativeMcpConfig(server);
		expect(config.command).toBe(process.execPath);
		expect(config.exposure).toBe("deferred");
		expect(config).not.toHaveProperty("url");
		expect(existsSync(config.args?.[0] ?? "")).toBe(true);
	},
);

describe("native MCP local stdio handshake and distribution", () => {
	const directory = mkdtempSync(join(tmpdir(), "relay-native-mcp-"));
	const resourceDir = join(directory, "resources", "native-mcp");
	beforeAll(() => {
		execFileSync(process.execPath, [resolve("../../scripts/copy-native-mcp.mjs"), resourceDir], { timeout: 60000 });
	}, 65000);
	afterAll(() => {
		rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	it("resolves standalone server assets without depending on a source checkout", () => {
		vi.stubEnv("RELAY_PACKAGE_DIR", directory);
		for (const server of ["context7", "playwright"] as const) {
			const entry = getNativeMcpEntrypoint(server);
			expect(entry.startsWith(resourceDir)).toBe(true);
			expect(existsSync(entry)).toBe(true);
		}
	});

	it.each([
		["context7", "resolve-library-id"],
		["playwright", "browser_navigate"],
		["chrome-devtools", "list_pages"],
	] satisfies [NativeMcpServer, string][])(
		"initializes %s locally and lists its tools without browser launch or provider API calls",
		async (server, expectedTool) => {
			// New servers run from an isolated distribution, so missing transitive deps
			// cannot be accidentally supplied by the repository's node_modules.
			vi.stubEnv("RELAY_PACKAGE_DIR", directory);
			if (server === "chrome-devtools") vi.unstubAllEnvs();
			const config = nativeMcpConfig(server);
			const transport = new StdioTransport({
				command: config.command,
				args: config.args,
				cwd: directory,
				stderr: "pipe",
				inheritEnv: false,
				// Preserve native opt-outs so the handshake cannot launch an update-check subprocess.
				env: { ...config.env, DO_NOT_TRACK: "1", CONTEXT7_API_KEY: "" },
			});
			// Cold startup from copied dependencies can exceed 15 seconds under parallel Windows CI load.
			const client = new McpClient({ name: "relay-native-mcp-test", version: "1.0.0", requestTimeoutMs: 30000 });
			try {
				await client.connect(transport);
				const tools = await client.listTools();
				expect(tools.some((tool) => tool.name === expectedTool)).toBe(true);
			} finally {
				await client.close();
			}
		},
		// Cover both bounded requests (initialize and tools/list), plus process cleanup.
		75000,
	);
});
