/**
 * The screen in a real browser (the system Chrome, through Playwright) against a scripted bridge:
 * the test plays relay's side of the RPC protocol and checks what the screen shows and sends.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(PACKAGE, "dist");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

/**
 * The system Chrome. `./test.sh` runs with a minimal environment, without the variables
 * Playwright's `channel: "chrome"` reads on Windows (`PROGRAMFILES`, `LOCALAPPDATA`), so the
 * standard install paths are checked here.
 */
function findChrome(): string {
	const drive = process.env.SystemDrive ?? process.env.SYSTEMDRIVE ?? "C:";
	const candidates =
		process.platform === "win32"
			? [
					process.env.PROGRAMFILES,
					`${drive}\\Program Files`,
					`${drive}\\Program Files (x86)`,
					process.env.LOCALAPPDATA,
				]
					.filter((root): root is string => root !== undefined)
					.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe"))
			: process.platform === "darwin"
				? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
				: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) throw new Error(`Chrome is required for the desktop screen tests; looked in ${candidates.join(", ")}`);
	return found;
}

interface Fixtures {
	responses: Record<string, unknown>;
}

declare global {
	interface Window {
		__sent: Array<Record<string, unknown>>;
		__fake: { emit(message: unknown): void; exit(code: number | null): void };
		__pwned?: number;
	}
}

/** Runs in the page before the app: relay's side of the bridge, answering from `fixtures`. */
function installFakeBridge(fixtures: Fixtures): void {
	const listeners: { message: Array<(message: unknown) => void>; exit: Array<(code: number | null) => void> } = {
		message: [],
		exit: [],
	};
	window.__sent = [];
	window.__fake = {
		emit: (message) => {
			for (const listener of listeners.message) listener(message);
		},
		exit: (code) => {
			for (const listener of listeners.exit) listener(code);
		},
	};
	window.__RELAY_BRIDGE__ = {
		send(command) {
			const value = command as Record<string, unknown>;
			window.__sent.push(value);
			if (value.type === "extension_ui_response") return;
			const data = fixtures.responses[String(value.type)];
			queueMicrotask(() =>
				window.__fake.emit({
					id: value.id,
					type: "response",
					command: value.type,
					success: true,
					...(data === undefined ? {} : { data }),
				}),
			);
		},
		onMessage(listener) {
			listeners.message.push(listener);
		},
		onExit(listener) {
			listeners.exit.push(listener);
		},
	};
}

const now = new Date().toISOString();
const FIXTURES: Fixtures = {
	responses: {
		get_state: {
			model: { provider: "anthropic", id: "claude-sonnet-5-5" },
			thinkingLevel: "medium",
			isStreaming: false,
			sessionFile: "/sessions/one.jsonl",
			sessionName: "Fix the parser",
		},
		list_sessions: {
			sessions: [
				{
					path: "/sessions/one.jsonl",
					id: "1",
					name: "Fix the parser",
					firstMessage: "The parser crashes",
					messageCount: 3,
					modified: now,
				},
				{
					path: "/sessions/two.jsonl",
					id: "2",
					firstMessage: "Port alignment to Rust",
					messageCount: 10,
					modified: now,
				},
			],
		},
		get_messages: {
			messages: [
				{ role: "user", content: "The parser crashes on empty input." },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I'll guard the empty case." },
						{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "src/parser.ts" } },
					],
				},
				{
					role: "toolResult",
					toolCallId: "e1",
					toolName: "edit",
					isError: false,
					content: [{ type: "text", text: "Edited src/parser.ts" }],
				},
				{ role: "user", origin: "harness", content: "[harness:evidence] Completion check: run the tests." },
			],
		},
		prompt: { disposition: "started" },
		steer: { disposition: "queued" },
		switch_session: { cancelled: false },
	},
};

function serve(): Promise<Server> {
	const server = createServer((request, response) => {
		const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
		const file = join(DIST, path === "/" || path === "\\" ? "index.html" : path);
		if (!file.startsWith(DIST) || !existsSync(file)) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
		response.end(readFileSync(file));
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("the desktop screen", () => {
	let browser: Browser;
	let server: Server;
	let page: Page;
	let url: string;

	beforeAll(async () => {
		// The screen is tested as built: compile it when a test run starts from a clean checkout.
		if (!existsSync(join(DIST, "main.js"))) {
			execFileSync(
				process.execPath,
				[join(PACKAGE, "../../node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
				{ cwd: PACKAGE },
			);
			execFileSync(process.execPath, ["scripts/copy-assets.mjs"], { cwd: PACKAGE });
		}
		server = await serve();
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
		browser = await chromium.launch({ executablePath: findChrome(), headless: true });
	});

	afterAll(async () => {
		await browser?.close();
		server?.close();
	});

	beforeEach(async () => {
		const context = await browser.newContext();
		page = await context.newPage();
		await page.addInitScript(installFakeBridge, FIXTURES);
		await page.goto(url);
		await page.locator(".session").first().waitFor();
	});

	const sent = () => page.evaluate(() => window.__sent);
	const emit = (message: unknown) => page.evaluate((value) => window.__fake.emit(value), message);

	it("shows the sessions, the model and the conversation with its tool results", async () => {
		expect(await page.locator(".session").count()).toBe(2);
		expect(await page.locator(".session.active .name").textContent()).toBe("Fix the parser");
		expect(await page.locator(".crumb").textContent()).toContain("anthropic/claude-sonnet-5-5");
		expect(await page.locator(".msg.user").first().textContent()).toBe("The parser crashes on empty input.");
		const tool = page.locator("details.tool").first();
		expect(await tool.locator(".arg").textContent()).toBe("src/parser.ts");
		expect(await tool.locator('[data-role="status"]').textContent()).toBe("done");
		expect(await page.locator(".notice").textContent()).toContain("Completion check");
	});

	it("sends a prompt, streams the reply and shows a failed tool call", async () => {
		await page.locator("textarea").fill("Run the tests");
		await page.locator("textarea").press("Enter");
		await expect.poll(sent).toContainEqual(expect.objectContaining({ type: "prompt", message: "Run the tests" }));

		await emit({ type: "agent_start" });
		await emit({ type: "message_start", message: { role: "assistant", content: [] } });
		await emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Run" },
		});
		await emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ning." },
		});
		expect(await page.locator(".msg.agent.streaming .text").textContent()).toBe("Running.");
		expect(await page.locator("button[type=submit]").textContent()).toBe("Steer");
		expect(await page.locator("button.danger", { hasText: "Stop" }).isVisible()).toBe(true);

		await emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Running." },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } },
				],
			},
		});
		await emit({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "1 failing" }],
			},
		});
		await emit({ type: "agent_end" });

		const tool = page.locator("details.tool", { hasText: "npm test" });
		expect(await tool.locator('[data-role="status"]').textContent()).toBe("error");
		expect(await tool.locator("pre").textContent()).toBe("1 failing");
		expect(await page.locator(".msg.agent.streaming").count()).toBe(0);
		expect(await page.locator("button[type=submit]").textContent()).toBe("Send");
	});

	it("asks before a risky operation, names the subagent, and answers with the developer's choice", async () => {
		await emit({
			type: "extension_ui_request",
			id: "c1",
			method: "confirm",
			title: "[go-expert] Allow destructive operation?",
			message: "Deletes files recursively\n\nrm -rf build",
		});
		const dialog = page.getByRole("alertdialog");
		expect(await dialog.locator(".who").textContent()).toBe("go-expert (subagent)");
		expect(await dialog.locator("h2").textContent()).toBe("Allow destructive operation?");
		expect(await dialog.locator("pre").textContent()).toBe("rm -rf build");
		// The safe answer has the focus.
		expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Deny");
		await dialog.getByRole("button", { name: "Allow once" }).click();
		await expect.poll(sent).toContainEqual({ type: "extension_ui_response", id: "c1", confirmed: true });

		await emit({
			type: "extension_ui_request",
			id: "c2",
			method: "confirm",
			title: "Allow external operation?",
			message: "git push",
		});
		await page.getByRole("alertdialog").press("Escape");
		await expect.poll(sent).toContainEqual({ type: "extension_ui_response", id: "c2", confirmed: false });
		expect(await page.getByRole("alertdialog").count()).toBe(0);

		await emit({ type: "extension_ui_request", id: "s1", method: "select", title: "Pick", options: ["a", "b"] });
		await expect.poll(sent).toContainEqual({ type: "extension_ui_response", id: "s1", cancelled: true });
	});

	it("shows model text as text, never as markup", async () => {
		await emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: '<img src="x" onerror="window.__pwned = 1">' }],
			},
		});
		await page.locator(".msg.agent", { hasText: "onerror" }).waitFor();
		expect(await page.locator(".messages img").count()).toBe(0);
		expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
	});

	it("switches to another session and reloads its conversation", async () => {
		await page.locator(".session", { hasText: "Port alignment to Rust" }).click();
		await expect
			.poll(sent)
			.toContainEqual(expect.objectContaining({ type: "switch_session", sessionPath: "/sessions/two.jsonl" }));
		await expect.poll(async () => (await sent()).filter((command) => command.type === "get_messages").length).toBe(2);
	});

	it("says when relay stops and disables the composer", async () => {
		await page.evaluate(() => window.__fake.exit(1));
		expect(await page.locator(".notice.bad").textContent()).toContain("relay stopped (exit code 1)");
		expect(await page.locator("textarea").isDisabled()).toBe(true);
	});
});
