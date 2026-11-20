/**
 * Reference behavior of the agent loop (`runAgentLoop`, `runAgentLoopContinue`), for the Rust
 * port to match.
 *
 * Each case is data: tools with scripted behavior, scripted assistant responses, the hook decisions
 * (blocked tools, result overrides, turn decisions, steering and follow-up messages per poll,
 * messages prepared for the next turn). The stream function turns each response into provider
 * events (`start`, each block's start, delta and end, `done` or `error`), each with its own partial
 * snapshot. The case records every event the loop emitted, every hook call and queue poll, what
 * each tool executed with, what the stream function received, and the messages the run returned.
 * Times become 0.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type ToolCall,
} from "@relay-harness/ai";
import { Type } from "typebox";
import { runAgentLoop, runAgentLoopContinue } from "../../src/agent-loop.ts";
import type {
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	ThinkingLevel,
} from "../../src/types.ts";

export const LOOP_DIR = fileURLToPath(new URL("../../../../crates/fixtures/loop/", import.meta.url));

type Schema = Record<string, unknown>;

interface ToolSpec {
	name: string;
	parameters: Schema;
	/** The schema is TypeBox's own, as the built-in tools' are. */
	typebox?: boolean;
	executionMode?: "sequential" | "parallel";
	/** `prepareArguments` fills these defaults into the raw arguments. */
	prepare?: Record<string, unknown>;
	run?: {
		delayMs?: number;
		updates?: string[];
		result?: AgentToolResult<unknown>;
		throws?: string;
		/** Abort the run while executing. */
		abort?: boolean;
	};
}

type Block =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

interface Response {
	content: Block[];
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}

export interface LoopCase {
	name: string;
	description: string;
	tools: ToolSpec[];
	responses: Response[];
	context: AgentMessage[];
	/** Prompt messages; none continues the context. */
	prompts?: AgentMessage[];
	toolExecution?: "sequential" | "parallel";
	/** The requested level; none is off. */
	reasoning?: Exclude<ThinkingLevel, "off">;
	block?: Record<string, { reason?: string; terminate?: boolean }>;
	after?: Record<string, AfterToolCallResult>;
	/** `finishTurn` decisions, one per completed turn. */
	finishTurn?: (("continue" | "end") | null)[];
	/** Steering messages per poll. */
	steering?: AgentMessage[][];
	/** Follow-up messages per poll. */
	followUps?: AgentMessage[][];
	/** What `prepareNextTurn` returns, per call. */
	prepareNextTurn?: ({ messages?: AgentMessage[]; thinkingLevel?: ThinkingLevel } | null)[];
	/** What `prepareRequest` replaces, per call; `model` is a model id. */
	prepareRequest?: ({ thinkingLevel?: ThinkingLevel; model?: string } | null)[];
	/** `transformContext` keeps the system messages and this many of the latest others. */
	transformKeepLast?: number;
	apiKey?: string;
	/** What `getApiKey` returns, per call. */
	apiKeys?: (string | null)[];
	/** The hook that throws for a tool. */
	throwIn?: Record<string, "before" | "after">;
}

const MODEL: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

const usage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });
const system = (text: string, tools: ToolSpec[] = []): AgentMessage => ({
	role: "system",
	content: text,
	...(tools.length > 0
		? {
				toolsAdded: tools.map((tool) => ({
					name: tool.name,
					description: `${tool.name} tool`,
					parameters: tool.parameters,
				})),
			}
		: {}),
	timestamp: 0,
});
const text = (value: string): Block => ({ type: "text", text: value });
const call = (id: string, name: string, args: Record<string, unknown>): Block => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
	type: "object",
	properties,
	required,
});

const echo: ToolSpec = { name: "echo", parameters: object({ text: { type: "string" } }, ["text"]) };
const readTool: ToolSpec = {
	name: "read",
	typebox: true,
	parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()) }) as unknown as Schema,
};

export function loopCases(): LoopCase[] {
	const base = { tools: [] as ToolSpec[], context: [system("Be brief.")], prompts: [user("Hi")] };
	return [
		{ ...base, name: "text-reply", description: "One text answer.", responses: [{ content: [text("Hello.")] }] },
		{
			...base,
			name: "thinking-and-reasoning",
			description: "A thinking block; the requested level is recorded on the answer.",
			reasoning: "high",
			responses: [{ content: [{ type: "thinking", thinking: "Hmm." }, text("Done.")] }],
		},
		{
			...base,
			name: "tool-call",
			description: "A tool call, its result, then the answer.",
			tools: [echo],
			context: [system("Be brief.", [echo])],
			responses: [
				{ content: [call("call_1", "echo", { text: "a" })], stopReason: "toolUse" },
				{ content: [text("Done.")] },
			],
		},
		{
			...base,
			name: "parallel-completion-order",
			description: "Parallel tools end in completion order; results stay in call order.",
			tools: [
				{ name: "slow", parameters: object({}), run: { delayMs: 60 } },
				{ name: "fast", parameters: object({}), run: { delayMs: 0 } },
			],
			responses: [
				{ content: [call("call_1", "slow", {}), call("call_2", "fast", {})], stopReason: "toolUse" },
				{ content: [text("Both done.")] },
			],
		},
		{
			...base,
			name: "sequential-tools",
			description: "Sequential execution runs each call to its end before the next.",
			toolExecution: "sequential",
			tools: [
				{ name: "slow", parameters: object({}), run: { delayMs: 30 } },
				{ name: "fast", parameters: object({}), run: { delayMs: 0 } },
			],
			responses: [
				{ content: [call("call_1", "slow", {}), call("call_2", "fast", {})], stopReason: "toolUse" },
				{ content: [text("Done.")] },
			],
		},
		{
			...base,
			name: "sequential-tool-mode",
			description: "One tool marked sequential makes the whole batch sequential.",
			tools: [
				{ name: "slow", parameters: object({}), run: { delayMs: 30 } },
				{ name: "fast", parameters: object({}), executionMode: "sequential" },
			],
			responses: [
				{ content: [call("call_1", "slow", {}), call("call_2", "fast", {})], stopReason: "toolUse" },
				{ content: [text("Done.")] },
			],
		},
		{
			...base,
			name: "tool-failures",
			description: "An unknown tool, invalid arguments, a throwing tool and an error result.",
			tools: [
				readTool,
				{ name: "boom", parameters: object({}), run: { throws: "it broke" } },
				{
					name: "soft",
					parameters: object({}),
					run: {
						result: { content: [{ type: "text", text: "not found" }], details: { code: 404 }, isError: true },
					},
				},
			],
			responses: [
				{
					content: [
						call("call_1", "missing", {}),
						call("call_2", "read", { path: 5, offset: "x" }),
						call("call_3", "read", { path: "a", offset: "3" }),
						call("call_4", "boom", {}),
						call("call_5", "soft", {}),
					],
					stopReason: "toolUse",
				},
				{ content: [text("Handled.")] },
			],
		},
		{
			...base,
			name: "tool-updates",
			description: "A tool streams partial results.",
			tools: [{ name: "progress", parameters: object({}), run: { updates: ["25%", "75%"] } }],
			responses: [
				{ content: [call("call_1", "progress", {})], stopReason: "toolUse" },
				{ content: [text("Done.")] },
			],
		},
		{
			...base,
			name: "hooks",
			description: "A blocked call, a blocked call with the default reason, and an overridden result.",
			tools: [echo, { name: "danger", parameters: object({}) }, { name: "quiet", parameters: object({}) }],
			block: { danger: { reason: "Not allowed here." }, quiet: {} },
			after: {
				echo: { content: [{ type: "text", text: "rewritten" }], isError: true, details: { rewritten: true } },
			},
			responses: [
				{
					content: [
						call("call_1", "echo", { text: "x" }),
						call("call_2", "danger", {}),
						call("call_3", "quiet", {}),
					],
					stopReason: "toolUse",
				},
				{ content: [text("Done.")] },
			],
		},
		{
			...base,
			name: "terminate-batch",
			description: "Every result asks to stop: the loop ends after the batch.",
			tools: [
				{ name: "stop", parameters: object({}), run: { result: { content: [], details: {}, terminate: true } } },
				{ name: "halt", parameters: object({}) },
			],
			block: { halt: { reason: "halted", terminate: true } },
			responses: [{ content: [call("call_1", "stop", {}), call("call_2", "halt", {})], stopReason: "toolUse" }],
		},
		{
			...base,
			name: "partial-terminate",
			description: "Only some results ask to stop: the loop continues.",
			tools: [
				{ name: "stop", parameters: object({}), run: { result: { content: [], details: {}, terminate: true } } },
				echo,
			],
			responses: [
				{ content: [call("call_1", "stop", {}), call("call_2", "echo", { text: "y" })], stopReason: "toolUse" },
				{ content: [text("Continued.")] },
			],
		},
		{
			...base,
			name: "length-stop",
			description: "A response cut by the output limit fails its tool calls.",
			tools: [echo],
			responses: [
				{ content: [text("Partial"), call("call_1", "echo", { text: "cut" })], stopReason: "length" },
				{ content: [text("Retried.")] },
			],
		},
		{
			...base,
			name: "error-stop",
			description: "An error response ends the run.",
			responses: [{ content: [text("Half")], stopReason: "error", errorMessage: "Server exploded." }],
		},
		{
			...base,
			name: "steering",
			description: "A steering message after the first turn goes before the next request.",
			tools: [echo],
			steering: [[], [user("Also do this.")]],
			responses: [
				{ content: [call("call_1", "echo", { text: "a" })], stopReason: "toolUse" },
				{ content: [text("Did both.")] },
			],
		},
		{
			...base,
			name: "steering-before-start",
			description: "A message steered before the run starts is sent with the prompt.",
			steering: [[user("Early note.")]],
			responses: [{ content: [text("Noted.")] }],
		},
		{
			...base,
			name: "follow-up",
			description: "A follow-up waits until the agent would stop, then runs another turn.",
			followUps: [[user("One more thing.")]],
			responses: [{ content: [text("First.")] }, { content: [text("Second.")] }],
		},
		{
			...base,
			name: "finish-turn-end",
			description: "finishTurn ends the run after a tool turn.",
			tools: [echo],
			finishTurn: ["end"],
			responses: [{ content: [call("call_1", "echo", { text: "a" })], stopReason: "toolUse" }],
		},
		{
			...base,
			name: "finish-turn-continue",
			description: "finishTurn asks for one more request after a plain answer.",
			finishTurn: ["continue", null],
			responses: [{ content: [text("First.")] }, { content: [text("Second.")] }],
		},
		{
			...base,
			name: "prepare-next-turn",
			description: "prepareNextTurn appends a message before the next turn.",
			tools: [echo],
			prepareNextTurn: [{ messages: [user("Prepared context.")], thinkingLevel: "low" }],
			responses: [
				{ content: [call("call_1", "echo", { text: "a" })], stopReason: "toolUse" },
				{ content: [text("Done.")] },
			],
		},
		{
			...base,
			name: "continue",
			description: "Continuing from a context that ends with a user message.",
			context: [system("Be brief."), user("Earlier question?")],
			prompts: undefined,
			responses: [{ content: [text("Answer.")] }],
		},
		{
			...base,
			name: "tool-declarations",
			description: "Tools the transcript does not declare are announced in a system message.",
			tools: [echo, readTool],
			context: [system("Be brief.", [echo])],
			responses: [{ content: [text("Ok.")] }],
		},
		{
			...base,
			name: "custom-messages",
			description: "A message the model cannot read stays in the transcript but not in the request.",
			context: [
				system("Be brief."),
				{ role: "custom", customType: "note", content: "ui only", timestamp: 0 } as never,
			],
			responses: [{ content: [text("Ok.")] }],
		},
		{
			...base,
			name: "abort-during-tool",
			description: "A tool aborts the run: the batch stops and the next request is aborted.",
			toolExecution: "sequential",
			tools: [{ name: "stopper", parameters: object({}), run: { abort: true } }, echo],
			responses: [
				{
					content: [call("call_1", "stopper", {}), call("call_2", "echo", { text: "never" })],
					stopReason: "toolUse",
				},
			],
		},
		{
			...base,
			name: "structured-content",
			description:
				"Replacing a result's content drops its structured content unless the override has its own; replacing only details keeps it.",
			tools: [
				{ name: "report", parameters: object({}), run: { result: structured } },
				{ name: "summary", parameters: object({}), run: { result: structured } },
				{ name: "table", parameters: object({}), run: { result: structured } },
			],
			after: {
				report: { content: [{ type: "text", text: "short" }] },
				summary: { details: { trimmed: true } },
				table: { content: [{ type: "text", text: "one row" }], structuredContent: { rows: 1 } },
			},
			responses: [
				{
					content: [call("call_1", "report", {}), call("call_2", "summary", {}), call("call_3", "table", {})],
					stopReason: "toolUse",
				},
				{ content: [text("Done.")] },
			],
		},
		{
			...base,
			name: "prepare-request",
			description: "prepareRequest changes the thinking level and the model of later requests.",
			reasoning: "high",
			tools: [echo],
			prepareRequest: [null, { thinkingLevel: "off", model: "mock-2" }],
			responses: [
				{ content: [call("call_1", "echo", { text: "a" })], stopReason: "toolUse" },
				{ content: [text("Done.")] },
			],
		},
		{
			...base,
			name: "transform-context",
			description: "transformContext prunes what the request carries, not the transcript.",
			context: [system("Be brief."), user("First?"), user("Second?")],
			transformKeepLast: 1,
			responses: [{ content: [text("Ok.")] }],
		},
		{
			...base,
			name: "api-key",
			description: "getApiKey answers each request; an empty key falls back to the configured one.",
			tools: [echo],
			apiKey: "configured",
			apiKeys: ["fresh", ""],
			responses: [
				{ content: [call("call_1", "echo", { text: "a" })], stopReason: "toolUse" },
				{ content: [text("Done.")] },
			],
		},
		{
			...base,
			name: "system-prompt-update",
			description: "A queued system message's tool fields become the change to what can run.",
			tools: [echo, readTool],
			context: [system("Be brief.", [echo])],
			prompts: [system("Use tools.", [{ name: "grep", parameters: object({}) }]), user("Hi")],
			responses: [{ content: [text("Ok.")] }],
		},
		{
			...base,
			name: "system-prompt-stale-removal",
			description: "A queued system message removing a tool that still runs loses its tool fields.",
			tools: [echo],
			context: [system("Be brief.", [echo])],
			prompts: [{ role: "system", content: "Changed.", toolsRemoved: [{ name: "echo" }], timestamp: 0 }, user("Hi")],
			responses: [{ content: [text("Ok.")] }],
		},
		{
			...base,
			name: "system-prompt-note",
			description: "A queued system message without tool changes stays as it is.",
			tools: [echo],
			context: [system("Be brief.", [echo])],
			prompts: [system("Note."), user("Hi")],
			responses: [{ content: [text("Ok.")] }],
		},
		{
			...base,
			name: "hook-errors",
			description: "A throwing beforeToolCall or afterToolCall fails the call with its message.",
			tools: [echo, { name: "other", parameters: object({}) }],
			throwIn: { echo: "before", other: "after" },
			responses: [
				{ content: [call("call_1", "echo", { text: "a" }), call("call_2", "other", {})], stopReason: "toolUse" },
				{ content: [text("Done.")] },
			],
		},
		{
			...base,
			name: "prepare-arguments",
			description: "prepareArguments fills raw arguments before validation; the hooks get the validated ones.",
			tools: [{ ...readTool, prepare: { path: "default.ts" } }],
			responses: [
				{ content: [call("call_1", "read", { offset: "2" })], stopReason: "toolUse" },
				{ content: [text("Done.")] },
			],
		},
	];
}

const structured: AgentToolResult<unknown> = {
	content: [{ type: "text", text: "full" }],
	details: {},
	structuredContent: { rows: 3 },
};

function zeroTimes(value: unknown, key?: string): unknown {
	if (key === "timestamp" && typeof value === "number") return 0;
	if (Array.isArray(value)) return value.map((item) => zeroTimes(item));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, zeroTimes(item, name)]));
	}
	return value;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Provider events for a response, each with its own snapshot. */
function responseEvents(response: Response, model: Model<"openai-responses">): AssistantMessageEvent[] {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: response.stopReason ?? "stop",
		...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
		timestamp: 0,
	};
	const events: AssistantMessageEvent[] = [];
	const partial = () => clone({ ...message, stopReason: "pending" as const, errorMessage: undefined });
	events.push({ type: "start", partial: partial() });
	response.content.forEach((block, contentIndex) => {
		if (block.type === "text") {
			message.content.push({ type: "text", text: "" });
			events.push({ type: "text_start", contentIndex, partial: partial() });
			(message.content[contentIndex] as { text: string }).text = block.text;
			events.push({ type: "text_delta", contentIndex, delta: block.text, partial: partial() });
			events.push({ type: "text_end", contentIndex, content: block.text, partial: partial() });
		} else if (block.type === "thinking") {
			message.content.push({ type: "thinking", thinking: "" });
			events.push({ type: "thinking_start", contentIndex, partial: partial() });
			(message.content[contentIndex] as { thinking: string }).thinking = block.thinking;
			events.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial: partial() });
			events.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: partial() });
		} else {
			const toolCall: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: {} };
			message.content.push(toolCall);
			events.push({ type: "toolcall_start", contentIndex, partial: partial() });
			toolCall.arguments = block.arguments as ToolCall["arguments"];
			events.push({
				type: "toolcall_delta",
				contentIndex,
				delta: JSON.stringify(block.arguments),
				partial: partial(),
			});
			events.push({ type: "toolcall_end", contentIndex, toolCall: clone(toolCall), partial: partial() });
		}
	});
	const final = clone(message);
	if (final.stopReason === "error" || final.stopReason === "aborted") {
		events.push({ type: "error", reason: final.stopReason, error: final });
	} else {
		events.push({ type: "done", reason: final.stopReason as "stop" | "length" | "toolUse", message: final });
	}
	return events;
}

function eventStream(events: AssistantMessageEvent[]): EventStream<AssistantMessageEvent, AssistantMessage> {
	const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => (event.type === "done" ? event.message : event.type === "error" ? event.error : (undefined as never)),
	);
	queueMicrotask(() => {
		for (const event of events) stream.push(clone(event));
		stream.end();
	});
	return stream;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LoopRecording {
	events: unknown[];
	calls: unknown[];
	hooks: unknown[];
	executions: unknown[];
	messages: unknown[];
}

export async function recordLoop(testCase: LoopCase): Promise<LoopRecording> {
	const events: unknown[] = [];
	const calls: unknown[] = [];
	const hooks: unknown[] = [];
	const executions: unknown[] = [];
	const controller = new AbortController();
	let responseIndex = 0;
	let turn = 0;
	let steeringPoll = 0;
	let followUpPoll = 0;
	let preparePoll = 0;
	let requestPoll = 0;
	let apiKeyPoll = 0;

	const tools: AgentTool[] = testCase.tools.map((spec) => ({
		name: spec.name,
		label: spec.name,
		description: `${spec.name} tool`,
		parameters: spec.parameters as never,
		...(spec.executionMode ? { executionMode: spec.executionMode } : {}),
		...(spec.prepare ? { prepareArguments: (args: unknown) => ({ ...spec.prepare, ...(args as object) }) } : {}),
		execute: async (toolCallId, params, signal, onUpdate) => {
			executions.push({ tool: spec.name, toolCallId, params: clone(params), aborted: signal?.aborted ?? false });
			for (const update of spec.run?.updates ?? []) {
				onUpdate?.({ content: [{ type: "text", text: update }], details: {} });
			}
			if (spec.run?.delayMs) await sleep(spec.run.delayMs);
			if (spec.run?.abort) controller.abort();
			if (spec.run?.throws) throw new Error(spec.run.throws);
			return clone(spec.run?.result ?? { content: [{ type: "text", text: `${spec.name} ok` }], details: {} });
		},
	}));

	const keepLast = testCase.transformKeepLast;
	const config: AgentLoopConfig = {
		model: MODEL,
		reasoning: testCase.reasoning,
		apiKey: testCase.apiKey,
		toolExecution: testCase.toolExecution ?? "parallel",
		convertToLlm: (messages) =>
			messages.filter((message): message is Message =>
				["system", "user", "assistant", "toolResult"].includes((message as { role: string }).role),
			),
		transformContext:
			keepLast === undefined
				? undefined
				: async (messages) => {
						hooks.push({ hook: "transformContext", messages: messages.length });
						const others = messages.filter((message) => message.role !== "system");
						const kept = new Set(others.slice(-keepLast));
						return messages.filter((message) => message.role === "system" || kept.has(message));
					},
		getApiKey: testCase.apiKeys
			? (provider) => {
					const key = testCase.apiKeys?.[apiKeyPoll] ?? undefined;
					hooks.push({ hook: "getApiKey", poll: apiKeyPoll++, provider });
					return key;
				}
			: undefined,
		prepareRequest: testCase.prepareRequest
			? async ({ context, model, thinkingLevel }) => {
					const update = testCase.prepareRequest?.[requestPoll] ?? null;
					hooks.push({
						hook: "prepareRequest",
						poll: requestPoll++,
						model: model.id,
						thinkingLevel,
						messages: context.messages.length,
					});
					if (!update) return undefined;
					return {
						...(update.thinkingLevel ? { thinkingLevel: update.thinkingLevel } : {}),
						...(update.model ? { model: { ...MODEL, id: update.model, name: update.model } } : {}),
					};
				}
			: undefined,
		beforeToolCall: async ({ toolCall, args }) => {
			hooks.push({ hook: "beforeToolCall", toolCallId: toolCall.id, args: clone(args) });
			if (testCase.throwIn?.[toolCall.name] === "before") throw new Error(`before ${toolCall.name} failed`);
			const block = testCase.block?.[toolCall.name];
			return block ? { block: true, ...block } : undefined;
		},
		afterToolCall: async ({ toolCall, isError }) => {
			hooks.push({ hook: "afterToolCall", toolCallId: toolCall.id, isError });
			if (testCase.throwIn?.[toolCall.name] === "after") throw new Error(`after ${toolCall.name} failed`);
			return testCase.after?.[toolCall.name];
		},
		finishTurn: async ({ message, toolResults }) => {
			hooks.push({ hook: "finishTurn", turn, stopReason: message.stopReason, toolResults: toolResults.length });
			const decision = testCase.finishTurn?.[turn++];
			return decision ? { action: decision } : undefined;
		},
		getSteeringMessages: async () => {
			const messages = testCase.steering?.[steeringPoll] ?? [];
			hooks.push({ hook: "getSteeringMessages", poll: steeringPoll++, count: messages.length });
			return clone(messages);
		},
		getFollowUpMessages: async () => {
			const messages = testCase.followUps?.[followUpPoll] ?? [];
			hooks.push({ hook: "getFollowUpMessages", poll: followUpPoll++, count: messages.length });
			return clone(messages);
		},
		prepareNextTurn: testCase.prepareNextTurn
			? async () => {
					const update = testCase.prepareNextTurn?.[preparePoll] ?? null;
					hooks.push({ hook: "prepareNextTurn", poll: preparePoll++ });
					return update ? clone(update) : undefined;
				}
			: undefined,
	};

	const streamFn = (
		model: Model<"openai-responses">,
		context: { messages: Message[] },
		options?: { reasoning?: string; apiKey?: string; signal?: AbortSignal },
	) => {
		calls.push({
			model: model.id,
			messages: clone(context.messages),
			reasoning: options?.reasoning ?? null,
			apiKey: options?.apiKey ?? null,
		});
		if (options?.signal?.aborted) {
			return eventStream(
				responseEvents({ content: [], stopReason: "aborted", errorMessage: "Request was aborted" }, model),
			);
		}
		const response = testCase.responses[responseIndex++];
		if (!response) throw new Error(`${testCase.name}: no response ${responseIndex}`);
		return eventStream(responseEvents(response, model));
	};

	const context: AgentContext = { messages: clone(testCase.context), tools };
	const emit = async (event: AgentEvent) => {
		events.push(zeroTimes(clone(event)));
	};
	const messages = testCase.prompts
		? await runAgentLoop(clone(testCase.prompts), context, config, emit, controller.signal, streamFn as never)
		: await runAgentLoopContinue(context, config, emit, controller.signal, streamFn as never);
	return {
		events,
		calls: zeroTimes(calls) as unknown[],
		hooks,
		executions,
		messages: zeroTimes(clone(messages)) as unknown[],
	};
}

export async function loopJson(testCase: LoopCase): Promise<string> {
	const recording = await recordLoop(testCase);
	const tools = testCase.tools.map((tool) => ({ ...tool, parameters: clone(tool.parameters) }));
	return `${JSON.stringify({ ...testCase, tools, ...recording }, null, "\t")}\n`;
}

export function readLoopCase(name: string): string {
	return readFileSync(join(LOOP_DIR, `${name}.json`), "utf8");
}
