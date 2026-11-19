/**
 * Reference Anthropic stream decoding, for the Rust decoder to match.
 *
 * Each case feeds a scripted server-sent event stream to the real `stream()` of
 * `anthropic-messages.ts` through `options.fetch`, split into byte chunks at the given offsets
 * (some inside a line, a CRLF pair or a multi-byte character), and records the events it emits
 * without their live `partial` snapshot, and the final message. Times become 0.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stream } from "../../src/api/anthropic-messages.ts";
import type { Message, Model, Tool, TranscriptContext } from "../../src/types.ts";

export const ANTHROPIC_STREAM_DIR = fileURLToPath(
	new URL("../../../../crates/fixtures/anthropic-stream/", import.meta.url),
);

const API_KEY = "sk-ant-api03-parity";
const OAUTH_TOKEN = "sk-ant-oat01-parity";

function model(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
		...overrides,
	};
}

const readTool: Tool = {
	name: "read",
	description: "Read a file.",
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	} as unknown as Tool["parameters"],
};

const MESSAGES: Message[] = [
	{ role: "system", content: "Be brief.", toolsAdded: [readTool], timestamp: 0 },
	{ role: "user", content: "Read a.ts.", timestamp: 0 },
];

/** One SSE event with JSON data. */
function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(usage: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
	return sse("message_start", {
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-test",
			content: [],
			stop_reason: null,
			usage: { input_tokens: 120, output_tokens: 1, ...usage },
			...extra,
		},
	});
}

const blockStart = (index: number, block: Record<string, unknown>) =>
	sse("content_block_start", { type: "content_block_start", index, content_block: block });
const delta = (index: number, value: Record<string, unknown>) =>
	sse("content_block_delta", { type: "content_block_delta", index, delta: value });
const blockStop = (index: number) => sse("content_block_stop", { type: "content_block_stop", index });
const messageDelta = (stopReason: string | null, usage: Record<string, unknown> = { output_tokens: 30 }, extra = {}) =>
	sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, ...extra }, usage });
const messageStop = sse("message_stop", { type: "message_stop" });
const text = (index: number, ...parts: string[]) =>
	blockStart(index, { type: "text", text: "" }) +
	parts.map((part) => delta(index, { type: "text_delta", text: part })).join("") +
	blockStop(index);

export interface StreamCase {
	name: string;
	description: string;
	model: Model<"anthropic-messages">;
	apiKey: string;
	messages: Message[];
	sse: string;
	/** Byte offsets where the body is split into chunks. */
	splits: number[];
}

/** The UTF-8 byte offset of `part` in `text`. */
function byteOffset(text: string, part: string): number {
	const index = text.indexOf(part);
	if (index === -1) throw new Error(`${part} is not in the stream`);
	return new TextEncoder().encode(text.slice(0, index)).length;
}

function everyBytes(sseText: string, step: number): number[] {
	const length = new TextEncoder().encode(sseText).length;
	const splits: number[] = [];
	for (let offset = step; offset < length; offset += step) splits.push(offset);
	return splits;
}

export function streamCases(): StreamCase[] {
	const base = { model: model(), apiKey: API_KEY, messages: MESSAGES, splits: [] as number[] };
	const toolsAndThinking =
		messageStart({
			input_tokens: 50,
			cache_read_input_tokens: 1000,
			cache_creation_input_tokens: 200,
			cache_creation: { ephemeral_1h_input_tokens: 150 },
		}) +
		blockStart(0, { type: "thinking", thinking: "", signature: "" }) +
		delta(0, { type: "thinking_delta", thinking: "Read the " }) +
		delta(0, { type: "thinking_delta", thinking: "file first." }) +
		delta(0, { type: "signature_delta", signature: "sig-" }) +
		delta(0, { type: "signature_delta", signature: "abc" }) +
		blockStop(0) +
		text(1, "Reading ", "a.ts.") +
		blockStart(2, { type: "tool_use", id: "toolu_1", name: "read", input: {} }) +
		delta(2, { type: "input_json_delta", partial_json: '{"pa' }) +
		delta(2, { type: "input_json_delta", partial_json: 'th": "a.' }) +
		delta(2, { type: "input_json_delta", partial_json: 'ts"}' }) +
		blockStop(2) +
		messageDelta("tool_use", { output_tokens: 80, output_tokens_details: { thinking_tokens: 12 } }) +
		messageStop;
	const framed = [
		": comment line\r\n",
		"event: ping\r\ndata: {}\r\n\r\n",
		"event: message_start\r\ndata: ",
		JSON.stringify({
			type: "message_start",
			message: { id: "msg_2", model: "claude-test", usage: { input_tokens: 9, output_tokens: 0 } },
		}),
		"\r\n\r\n",
		"event:content_block_start\ndata:",
		JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		"\n\n",
		'event: content_block_delta\ndata: {"type": "content_block_delta", "index": 0,\ndata: "delta": {"type": "text_delta", "text": "café 🙈 "}}\n\n',
		'event: unknown_event\ndata: {"type": "unknown_event"}\n\n',
		"retry\nid: 7\n",
		delta(0, { type: "text_delta", text: "done" }),
		blockStop(0),
		messageDelta("end_turn", { output_tokens: 4 }),
		'event: message_stop\ndata: {"type": "message_stop"}',
	].join("");
	return [
		{
			...base,
			name: "text",
			description: "A plain text answer.",
			sse: messageStart() + text(0, "Hello", ", world.") + messageDelta("end_turn") + messageStop,
		},
		{
			...base,
			name: "tools-and-thinking",
			description: "Thinking with a signature, text and a tool call; cache and reasoning usage.",
			sse: toolsAndThinking,
		},
		{
			...base,
			name: "tools-and-thinking-chunked",
			description: "The same stream in 7-byte chunks.",
			sse: toolsAndThinking,
			splits: everyBytes(toolsAndThinking, 7),
		},
		{
			...base,
			name: "redacted-thinking",
			description: "A redacted thinking block.",
			sse:
				messageStart() +
				blockStart(0, { type: "redacted_thinking", data: "opaque-payload" }) +
				blockStop(0) +
				text(1, "Done.") +
				messageDelta("end_turn") +
				messageStop,
		},
		{
			...base,
			name: "oauth-tool-name",
			description: "An OAuth response names tools as Claude Code does; they map back to the session's.",
			apiKey: OAUTH_TOKEN,
			sse:
				messageStart() +
				blockStart(0, { type: "tool_use", id: "toolu_2", name: "Read", input: {} }) +
				delta(0, { type: "input_json_delta", partial_json: '{"path":"a.ts"}' }) +
				blockStop(0) +
				blockStart(1, { type: "tool_use", id: "toolu_3", name: "Grep", input: {} }) +
				blockStop(1) +
				messageDelta("tool_use") +
				messageStop,
		},
		{
			...base,
			name: "sse-error",
			description: "An error event in the middle of a tool call keeps the partial arguments.",
			sse:
				messageStart() +
				text(0, "Partial") +
				blockStart(1, { type: "tool_use", id: "toolu_4", name: "read", input: {} }) +
				delta(1, { type: "input_json_delta", partial_json: '{"path": "src/' }) +
				'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
		},
		{
			...base,
			name: "no-message-stop",
			description: "The stream ends before message_stop.",
			sse: messageStart() + text(0, "Cut") + messageDelta("end_turn"),
		},
		{
			...base,
			name: "no-stop-reason",
			description: "message_stop arrives without a stop reason.",
			sse: messageStart() + text(0, "Hm") + messageDelta(null) + messageStop,
		},
		{
			...base,
			name: "empty-stream",
			description: "A body with no events.",
			sse: ": nothing here\n\n",
		},
		{
			...base,
			name: "refusal",
			description: "A refusal with an explanation.",
			sse:
				messageStart() +
				text(0, "I can't") +
				messageDelta("refusal", { output_tokens: 3 }, { stop_details: { explanation: "Policy." } }) +
				messageStop,
		},
		{
			...base,
			name: "refusal-plain",
			description: "A refusal without an explanation.",
			sse: messageStart() + messageDelta("refusal") + messageStop,
		},
		{
			...base,
			name: "max-tokens",
			description: "The answer hits the output limit.",
			sse: messageStart() + text(0, "Long") + messageDelta("max_tokens") + messageStop,
		},
		{
			...base,
			name: "pause-turn",
			description: "pause_turn ends the turn like end_turn.",
			sse: messageStart() + text(0, "Paused") + messageDelta("pause_turn") + messageStop,
		},
		{
			...base,
			name: "unknown-stop-reason",
			description: "A stop reason the adapter does not know.",
			sse: messageStart() + text(0, "?") + messageDelta("weird_reason") + messageStop,
		},
		{
			...base,
			name: "fallback",
			description: "A server-side fallback before any output, priced at the fallback model.",
			model: model({
				compat: {
					allowedFallbackModels: [
						{
							provider: "anthropic",
							model: "claude-fallback",
							cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
						},
					],
				},
			}),
			sse:
				messageStart({ input_tokens: 1000 }, { model: "claude-fallback" }) +
				blockStart(0, { type: "fallback" }) +
				blockStop(0) +
				text(1, "From the fallback.") +
				messageDelta("end_turn", { output_tokens: 500 }) +
				messageStop,
		},
		{
			...base,
			name: "fallback-mid-output",
			description: "A fallback after output has started is an error.",
			sse: messageStart() + text(0, "Started") + blockStart(1, { type: "fallback" }) + blockStop(1) + messageStop,
		},
		{
			...base,
			name: "input-transformations",
			description: "Input transformations become a diagnostic; the message delta's list replaces the start's.",
			sse:
				messageStart(
					{},
					{ input_transformations: [{ type: "truncate", path: "messages[0]", reason: "Too long." }] },
				) +
				text(0, "Ok") +
				sse("message_delta", {
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 2 },
					input_transformations: [
						{ type: "truncate", path: "messages[0]", reason: "Too long." },
						{ type: null, path: "tools[1]", reason: null },
					],
				}) +
				messageStop,
		},
		{
			...base,
			name: "framing",
			description: "CRLF, comments, pings, unknown events, fields without a space or a value, multi-line data.",
			sse: framed,
			// At the start, between the \r and \n of a pair, inside the multi-byte characters.
			splits: [
				1,
				byteOffset(framed, "\r\n\r\n") + 1,
				byteOffset(framed, "é") + 1,
				byteOffset(framed, "🙈") + 1,
				byteOffset(framed, "🙈") + 3,
			],
		},
		{
			...base,
			name: "repaired-json",
			description: "Event data with a raw control character is repaired.",
			sse:
				messageStart() +
				blockStart(0, { type: "text", text: "" }) +
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"tab\there"}}\n\n' +
				blockStop(0) +
				messageDelta("end_turn") +
				messageStop,
		},
		{
			...base,
			name: "ignored-deltas",
			description: "Deltas after a block stops, for unknown blocks or of unknown types are ignored.",
			sse:
				messageStart() +
				blockStart(0, { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} }) +
				delta(0, { type: "input_json_delta", partial_json: '{"q":"x"}' }) +
				blockStop(0) +
				blockStart(1, { type: "text", text: "Start " }) +
				delta(1, { type: "citations_delta", citation: { type: "char_location" } }) +
				delta(1, { type: "text_delta", text: "middle" }) +
				blockStop(1) +
				delta(1, { type: "text_delta", text: " after stop" }) +
				delta(9, { type: "text_delta", text: "no block" }) +
				messageDelta("end_turn", { input_tokens: null, output_tokens: 7, cache_read_input_tokens: null }) +
				messageStop,
		},
		{
			...base,
			name: "tiered-cost",
			description: "Usage above a pricing tier's threshold uses the tier's rates.",
			model: model({
				cost: {
					input: 3,
					output: 15,
					cacheRead: 0.3,
					cacheWrite: 3.75,
					tiers: [
						{ inputTokensAbove: 100000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 },
						{ inputTokensAbove: 50000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
					],
				},
			}),
			sse:
				messageStart({ input_tokens: 150000, cache_read_input_tokens: 20000 }) +
				text(0, "Big") +
				messageDelta("end_turn", { output_tokens: 3000 }) +
				messageStop,
		},
	];
}

function bodyChunks(sseText: string, splits: number[]): Uint8Array[] {
	const bytes = new TextEncoder().encode(sseText);
	const chunks: Uint8Array[] = [];
	let start = 0;
	for (const split of [...splits, bytes.length]) {
		if (split > start) chunks.push(bytes.slice(start, split));
		start = Math.max(start, split);
	}
	return chunks;
}

function zeroTimes(value: unknown, key?: string): unknown {
	if (key === "timestamp" && typeof value === "number") return 0;
	if (Array.isArray(value)) return value.map((item) => zeroTimes(item));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, zeroTimes(item, name)]));
	}
	return value;
}

export async function decode(testCase: StreamCase): Promise<{ events: unknown[] }> {
	const chunks = bodyChunks(testCase.sse, testCase.splits);
	const fetch = async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	const events: unknown[] = [];
	const output = stream(testCase.model, { messages: testCase.messages } as TranscriptContext, {
		apiKey: testCase.apiKey,
		cacheRetention: "none",
		fetch,
	});
	for await (const event of output) {
		const { partial: _partial, ...rest } = event as { partial?: unknown };
		events.push(rest);
	}
	return zeroTimes(JSON.parse(JSON.stringify({ events }))) as { events: unknown[] };
}

export async function streamCaseJson(testCase: StreamCase): Promise<string> {
	const { name, description, model: caseModel, apiKey, messages, sse: body, splits } = testCase;
	const fixture = {
		name,
		description,
		model: caseModel,
		apiKey,
		messages,
		sse: body,
		splits,
		...(await decode(testCase)),
	};
	return `${JSON.stringify(fixture, null, "\t")}\n`;
}

export function readStreamCase(name: string): string {
	return readFileSync(join(ANTHROPIC_STREAM_DIR, `${name}.json`), "utf8");
}
