/**
 * Reference behavior of `HarnessCore` installed on an `Agent`, for the Rust port to match: the
 * agent-level scenarios of `harness.test.ts`, on the TypeScript pillars.
 *
 * Each case builds an agent with scripted tools and responses, installs the harness with the
 * case's options and sends its prompts. The case records:
 *
 * - each request the stream function received;
 * - every harness event;
 * - what the authorizer was asked;
 * - the transcript and the developer constraints at the end.
 *
 * Times become 0.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, Model } from "@relay-harness/ai";
import { Type } from "typebox";
import { Agent } from "../../src/agent.ts";
import { HarnessCore, type HarnessCoreOptions } from "../../src/harness/index.ts";
import type { AgentMessage, AgentTool, AgentToolCall } from "../../src/types.ts";
import {
	type Block,
	call,
	clone,
	eventStream,
	MODEL,
	type Response,
	responseEvents,
	text,
	zeroTimes,
} from "./loop-record.ts";

export const HARNESS_DIR = fileURLToPath(new URL("../../../../crates/fixtures/harness/", import.meta.url));

interface HarnessToolSpec {
	name: string;
	/** The result text; `<name> ok` by default. */
	output?: string;
	isError?: boolean;
	/** Tool calls a delegated agent ran, recorded while this tool runs. */
	delegate?: { toolCall: AgentToolCall; isError: boolean }[];
	/** A developer message steered while this tool runs. */
	steer?: string;
}

type Prompt = { text: string } | { message: AgentMessage } | { messages: AgentMessage[] };

export interface HarnessCase {
	name: string;
	description: string;
	tools: HarnessToolSpec[];
	/** Each response's blocks; a response with a tool call stops for tool use. */
	responses: Block[][];
	prompts: Prompt[];
	options?: {
		evidence?: false;
		context?: false | { keepRecent: number; batchSize: number; minElideChars: number };
		/** What the authorizer answers; no authorizer when absent. */
		authorize?: boolean | null;
		/** The agent's own `beforeToolCall` blocks calls of this tool, under the harness. */
		previousBlocks?: string;
	};
}

const toolParameters = Type.Object({}, { additionalProperties: true });

export function harnessCases(): HarnessCase[] {
	const edit = { name: "edit" };
	const bash = { name: "bash" };
	return [
		{
			name: "verification-request",
			description: "A completion claim without a check gets one verification request; the check then verifies it.",
			tools: [edit, bash],
			responses: [
				[call("1", "edit", { path: "src/a.ts" })],
				[text("Done, the bug is fixed.")],
				[call("2", "bash", { command: "npm test" })],
				[text("Fixed; all tests pass.")],
			],
			prompts: [{ text: "Fix the bug in src/a.ts" }],
		},
		{
			name: "blocked-push",
			description: "An unauthorized push is blocked and the developer's constraint is restated in the request.",
			tools: [bash],
			responses: [[call("1", "bash", { command: "git push origin main" })], [text("I need approval to push.")]],
			prompts: [{ text: "Update the changelog. Never commit without asking." }],
		},
		{
			name: "authorizer-approves",
			description: "The authorizer is asked and the call it approves runs.",
			tools: [bash],
			responses: [[call("1", "bash", { command: "git push origin main" })], [text("Pushed.")]],
			prompts: [{ text: "Update the changelog" }],
			options: { evidence: false, authorize: true },
		},
		{
			name: "authorizer-declines",
			description: "The call the authorizer declines is blocked.",
			tools: [bash],
			responses: [[call("1", "bash", { command: "git push origin main" })], [text("Not pushed.")]],
			prompts: [{ text: "Update the changelog" }],
			options: { evidence: false, authorize: false },
		},
		{
			name: "authorizer-silent",
			description: "An authorizer that gives no answer leaves the call to the developer.",
			tools: [bash],
			responses: [[call("1", "bash", { command: "git push origin main" })], [text("Waiting.")]],
			prompts: [{ text: "Update the changelog" }],
			options: { evidence: false, authorize: null },
		},
		{
			name: "all-pillars",
			description: "Elided reads, a blocked push and a verification request in one run.",
			tools: [{ name: "read", output: "x".repeat(3000) }, edit, bash],
			responses: [
				[call("1", "read", { path: "src/a.ts" })],
				[call("2", "read", { path: "src/b.ts" })],
				[call("3", "edit", { path: "src/a.ts" })],
				[call("4", "bash", { command: "git push origin main" })],
				[text("Done, the bug is fixed.")],
				[call("5", "bash", { command: "npm test" })],
				[text("Fixed; all tests pass.")],
			],
			prompts: [{ text: "Fix the bug in src/a.ts. Never commit without asking." }],
			options: { context: { keepRecent: 1, batchSize: 1, minElideChars: 100 } },
		},
		{
			name: "brief-from-agent",
			description: "A brief a model wrote authorizes nothing and states no constraint.",
			tools: [bash],
			responses: [
				[call("1", "bash", { command: "rm -rf dist" })],
				[call("2", "bash", { command: "git push origin main" })],
				[text("Finished.")],
			],
			prompts: [
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "Delete dist and push the branch. Never edit the tests." }],
						timestamp: 0,
						origin: "agent",
					},
				},
			],
			options: { evidence: false },
		},
		{
			name: "brief-from-developer",
			description: "The same words from the developer authorize both calls and state the constraint.",
			tools: [bash],
			responses: [
				[call("1", "bash", { command: "rm -rf dist" })],
				[call("2", "bash", { command: "git push origin main" })],
				[text("Finished.")],
			],
			prompts: [{ text: "Delete dist and push the branch. Never edit the tests." }],
			options: { evidence: false },
		},
		{
			name: "delegated-unchecked",
			description: "A subagent's edit without a check gates the parent's completion.",
			tools: [
				{
					name: "agent",
					output: "go-expert: fixed src/a.go",
					delegate: [{ toolCall: call("c1", "edit", { path: "src/a.go" }) as AgentToolCall, isError: false }],
				},
			],
			responses: [
				[call("1", "agent", { subagent_type: "go-expert", description: "Fix", prompt: "Fix src/a.go" })],
				[text("Done, the bug is fixed.")],
				[text("Done.")],
			],
			prompts: [{ text: "Fix the bug in src/a.go" }],
		},
		{
			name: "delegated-checked",
			description: "A subagent's check after its edit backs the parent's completion.",
			tools: [
				{
					name: "agent",
					output: "go-expert: fixed src/a.go",
					delegate: [
						{ toolCall: call("c1", "edit", { path: "src/a.go" }) as AgentToolCall, isError: false },
						{ toolCall: call("c2", "bash", { command: "npm test" }) as AgentToolCall, isError: false },
					],
				},
			],
			responses: [
				[call("1", "agent", { subagent_type: "go-expert", description: "Fix", prompt: "Fix src/a.go" })],
				[text("Done, the bug is fixed.")],
			],
			prompts: [{ text: "Fix the bug in src/a.go" }],
		},
		{
			name: "extension-prompt",
			description: "An extension's prompt states no constraint; the developer's next prompt does.",
			tools: [],
			responses: [[text("ok")], [text("ok")]],
			prompts: [
				{
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: "Do not implement anything and do not change any file except the questionnaire.",
							},
						],
						timestamp: 0,
						origin: "extension",
					},
				},
				{ text: "Never touch the lockfile." },
			],
			options: { evidence: false, context: false },
		},
		{
			name: "extension-evidence",
			description: "An extension's prompt starts an evidence request.",
			tools: [edit],
			responses: [[call("1", "edit", { path: "src/a.ts" })], [text("Done.")], [text("Done, unverified.")]],
			prompts: [
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "Implement the plan" }],
						timestamp: 0,
						origin: "extension",
					},
				},
			],
		},
		{
			name: "correction",
			description:
				"A developer message after the agent worked is a correction, restated next to the latest message.",
			tools: [],
			responses: [[text("I changed the footer.")], [text("Changing the header instead.")]],
			prompts: [{ text: "Change the page title" }, { text: "No, I meant the header, not the footer." }],
			options: { evidence: false },
		},
		{
			name: "previous-hook",
			description: "The agent's own hook still runs under the harness and can block what the harness allows.",
			tools: [edit],
			responses: [[call("1", "edit", { path: "src/a.ts" })], [text("The edit was refused.")]],
			prompts: [{ text: "Fix the typo in src/a.ts" }],
			options: { evidence: false, previousBlocks: "edit" },
		},
		{
			name: "steered-message",
			description: "A developer message steered mid-run joins the request: the edit before it still needs a check.",
			tools: [{ name: "edit", steer: "Also keep the old function name." }],
			responses: [[call("1", "edit", { path: "src/a.ts" })], [text("Done, the bug is fixed.")], [text("Done.")]],
			prompts: [{ text: "Fix the bug in src/a.ts" }],
		},
		{
			name: "two-developer-messages",
			description:
				"Only the first developer message of a run starts the request; a question after it does not restart it.",
			tools: [edit],
			responses: [[call("1", "edit", { path: "src/a.ts" })], [text("Done, the bug is fixed.")], [text("Done.")]],
			prompts: [
				{
					messages: [
						{ role: "user", content: "Fix the bug in src/a.ts", timestamp: 0 },
						{ role: "user", content: "Is that clear?", timestamp: 0 },
					],
				},
			],
		},
		{
			name: "legacy-harness-prefix",
			description: "A message without an origin that starts with the old harness prefix is not the developer's.",
			tools: [],
			responses: [[text("Noted.")]],
			prompts: [{ text: "[harness] Never push to main." }],
			options: { evidence: false },
		},
		{
			name: "question-turn",
			description: "An edit in reply to a question is stopped.",
			tools: [edit],
			responses: [[call("1", "edit", { path: "src/a.ts" })], [text("It fails because of the import.")]],
			prompts: [{ text: "Why does src/a.ts fail?" }],
			options: { evidence: false },
		},
	];
}

export interface HarnessRecording {
	requests: unknown[];
	events: unknown[];
	asked: unknown[];
	messages: unknown[];
	constraints: unknown[];
}

export async function recordHarness(testCase: HarnessCase): Promise<HarnessRecording> {
	const requests: unknown[] = [];
	const events: unknown[] = [];
	const asked: unknown[] = [];
	let responseIndex = 0;
	let core: HarnessCore | undefined;

	const tools: AgentTool[] = testCase.tools.map((spec) => ({
		name: spec.name,
		label: spec.name,
		description: `${spec.name} tool`,
		parameters: toolParameters,
		execute: async () => {
			if (spec.steer) agent.steer({ role: "user", content: spec.steer, timestamp: 0 });
			if (spec.delegate) {
				const harness = core as HarnessCore;
				harness.recordDelegatedEffects(
					spec.delegate.map(({ toolCall, isError }) => ({
						effect: harness.classify(toolCall),
						isError,
						output: "ok",
					})),
				);
			}
			return {
				content: [{ type: "text", text: spec.output ?? `${spec.name} ok` }],
				details: {},
				isError: spec.isError ?? false,
			};
		},
	}));

	const streamFn = (model: Model<"openai-responses">, context: { messages: Message[] }) => {
		requests.push(clone(context.messages));
		const content = testCase.responses[responseIndex++] ?? [text("(no more responses)")];
		const response: Response = {
			content,
			stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		};
		return eventStream(responseEvents(response, model));
	};

	const agent = new Agent({
		initialState: { systemPrompt: "test", model: MODEL, tools },
		streamFn: streamFn as never,
	});
	const options = testCase.options ?? {};
	if (options.previousBlocks) {
		const blocked = options.previousBlocks;
		agent.beforeToolCall = async ({ toolCall }) =>
			toolCall.name === blocked ? { block: true, reason: "Blocked by the agent's own hook." } : undefined;
	}
	const harnessOptions: HarnessCoreOptions = {
		...(options.evidence === false ? { evidence: false as const } : {}),
		...(options.context !== undefined ? { context: options.context } : {}),
		...(options.authorize !== undefined
			? {
					alignment: {
						authorize: async (request) => {
							asked.push(clone(request));
							return options.authorize ?? undefined;
						},
					},
				}
			: {}),
		onEvent: (event) => events.push(clone(event)),
	};
	core = new HarnessCore(harnessOptions);
	core.install(agent);
	for (const prompt of testCase.prompts) {
		if ("text" in prompt) await agent.prompt(prompt.text);
		else if ("message" in prompt) await agent.prompt(clone(prompt.message));
		else await agent.prompt(clone(prompt.messages));
	}
	const constraints = core.engine.constraints();
	core.dispose();
	return {
		requests: zeroTimes(requests) as unknown[],
		events,
		asked,
		messages: zeroTimes(clone(agent.state.messages)) as unknown[],
		constraints: zeroTimes(clone(constraints)) as unknown[],
	};
}

export async function harnessJson(testCase: HarnessCase): Promise<string> {
	const recording = await recordHarness(testCase);
	return `${JSON.stringify({ ...testCase, parameters: clone(toolParameters), ...recording }, null, "\t")}\n`;
}

export function readHarnessCase(name: string): string {
	return readFileSync(join(HARNESS_DIR, `${name}.json`), "utf8");
}
