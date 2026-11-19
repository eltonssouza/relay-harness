import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type SystemMessage,
	type TextContent,
	type TranscriptContext,
} from "@relay-harness/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../../src/extensions/subagents/index.ts";
import { createHarness, createTestUiContext, getToolResult, getUserTexts, type Harness } from "./harness.ts";

/** Text of the newest message of a request, harness state included. */
function lastMessageText(context: TranscriptContext): string {
	const content = context.messages.at(-1)?.content;
	if (typeof content === "string" || !Array.isArray(content)) return content ?? "";
	return content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

const systemMessages = (context: TranscriptContext) =>
	context.messages.filter((message): message is SystemMessage => message.role === "system");

/** The system prompt of a request: the text and sections of its system messages. */
function systemPrompt(context: TranscriptContext): string {
	return systemMessages(context)
		.flatMap((message) => [
			typeof message.content === "string"
				? message.content
				: message.content.map((block: TextContent) => block.text).join("\n"),
			...Object.values(message.sections ?? {}).filter((section): section is string => typeof section === "string"),
		])
		.join("\n");
}

/** Names of the tools a request declares. */
function toolNames(context: TranscriptContext): string[] {
	return systemMessages(context)
		.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name))
		.sort();
}

describe("subagents", () => {
	const harnesses: Harness[] = [];
	let agentHome = "";

	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Local services unavailable"));
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	async function setup(agents: Record<string, string>, settings: Record<string, unknown> = {}): Promise<Harness> {
		const harness = await createHarness({
			settings,
			extensionFactories: [{ name: "subagents", factory: subagentsExtension, builtin: true }],
		});
		harnesses.push(harness);
		agentHome = join(harness.tempDir, "agent-home");
		mkdirSync(join(agentHome, "agents"), { recursive: true });
		for (const [name, content] of Object.entries(agents))
			writeFileSync(join(agentHome, "agents", `${name}.md`), content);
		vi.stubEnv("RELAY_CODING_AGENT_DIR", agentHome);
		return harness;
	}

	const definition = (name: string, tools: string, body: string) =>
		`---\nname: ${name}\ndescription: ${name} for tests\ntools: ${tools}\nmodel: inherit\n---\n${body}\n`;

	it("runs the subagent with its prompt and tools, hands it the constraints, and returns its report", async () => {
		const harness = await setup({
			scout: definition("scout", "Read, Grep", "You are scout."),
		});
		await harness.session.bindExtensions({});
		let child: TranscriptContext | undefined;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("agent", { subagent_type: "scout", description: "Find", prompt: "Find the parser" }),
			),
			(context) => {
				child = context;
				return fauxAssistantMessage("The parser is in src/parser.ts.");
			},
			fauxAssistantMessage("It is in src/parser.ts."),
		]);

		await harness.session.prompt("Where is the parser? Never edit the tests.");

		const request = child as TranscriptContext;
		expect(systemPrompt(request)).toContain(`You are scout.\n\nWorking directory: ${harness.tempDir}`);
		expect(toolNames(request)).toEqual(["grep", "read"]);
		expect(lastMessageText(request)).toContain("Find the parser");
		// The developer's constraint reaches the child as harness state, not as the brief's words.
		expect(lastMessageText(request)).toContain("Never edit the tests.");
		const result = getToolResult(harness, "agent");
		expect(result.isError).toBe(false);
		expect(JSON.stringify(result.content)).toContain("The parser is in src/parser.ts.");
		expect(result.usage?.totalTokens).toBeGreaterThan(0);
	});

	it("lets a brief authorize nothing and asks the parent's UI, naming the agent", async () => {
		const harness = await setup({ worker: definition("worker", "Bash", "You are worker.") });
		const titles: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				confirm: async (title) => {
					titles.push(title);
					return false;
				},
			}),
			mode: "rpc",
		});
		let blocked = "";
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("agent", {
					subagent_type: "worker",
					description: "Clean",
					prompt: "Delete dist and push the branch.",
				}),
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf dist" })),
			(context) => {
				blocked = lastMessageText(context);
				return fauxAssistantMessage("I was not allowed to delete dist.");
			},
			fauxAssistantMessage("The worker could not delete dist."),
		]);

		await harness.session.prompt("Clean up the build output");

		expect(titles).toHaveLength(1);
		expect(titles[0]).toMatch(/^\[worker\] /);
		expect(blocked).toContain("the developer declined this destructive operation");
	});

	it("gates the parent's completion when the subagent wrote without a check", async () => {
		const harness = await setup({ writer: definition("writer", "Write", "You are writer.") });
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("agent", { subagent_type: "writer", description: "Fix", prompt: "Fix src/a.ts" }),
			),
			fauxAssistantMessage(fauxToolCall("write", { path: "src/a.ts", content: "export const a = 1;\n" })),
			fauxAssistantMessage("Fixed src/a.ts."),
			fauxAssistantMessage("Done, the bug is fixed."),
			fauxAssistantMessage("I have not run a check."),
		]);

		await harness.session.prompt("Fix the bug in src/a.ts");

		expect(getUserTexts(harness).some((text) => text.includes("[harness:evidence] Completion check"))).toBe(true);
		expect(harness.session.harnessCore.core.engine.pendingChanges()).toEqual(["src/a.ts"]);
	});

	it("stops delegating at the depth limit", async () => {
		const harness = await setup({
			orchestrator: definition("orchestrator", "Agent, Read", "You route work."),
			specialist: definition("specialist", "Agent, Read", "You do the work."),
		});
		await harness.session.bindExtensions({});
		const tools: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("agent", { subagent_type: "orchestrator", description: "Route", prompt: "Route it" }),
			),
			(context) => {
				tools.push(toolNames(context));
				return fauxAssistantMessage(
					fauxToolCall("agent", { subagent_type: "specialist", description: "Work", prompt: "Do it" }),
				);
			},
			(context) => {
				tools.push(toolNames(context));
				return fauxAssistantMessage("Specialist done.");
			},
			fauxAssistantMessage("Orchestrator done."),
			fauxAssistantMessage("All done."),
		]);

		await harness.session.prompt("Route the work");

		expect(tools).toEqual([["agent", "read"], ["read"]]);
		expect(JSON.stringify(getToolResult(harness, "agent").content)).toContain("Orchestrator done.");
	});

	it("names the available agents when the type is unknown", async () => {
		const harness = await setup({ scout: definition("scout", "Read", "You are scout.") });
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("agent", { subagent_type: "nope", description: "Find", prompt: "Find it" })),
			fauxAssistantMessage("No such agent."),
		]);

		await harness.session.prompt("Find it");

		const result = getToolResult(harness, "agent");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("Available agents: scout.");
	});

	it("declares the tool only when agent definitions exist", async () => {
		const empty = await setup({});
		await empty.session.bindExtensions({});
		expect(empty.session.getActiveToolNames()).not.toContain("agent");
		const harness = await setup({ scout: definition("scout", "Read", "You are scout.") });
		await harness.session.bindExtensions({});
		expect(harness.session.getActiveToolNames()).toContain("agent");
	});
});
