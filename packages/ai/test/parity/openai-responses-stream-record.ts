/**
 * Reference OpenAI Responses stream decoding, for the Rust decoder to match.
 *
 * Each case feeds a scripted server-sent event stream to the real `stream()` of
 * `openai-responses.ts` through `options.fetch` (so the OpenAI SDK parses it as it would a
 * server's), split into byte chunks at the given offsets, and records the events without their
 * live `partial` snapshot, and the final message. Times become 0.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OpenAIResponsesOptions, stream } from "../../src/api/openai-responses.ts";
import type { Message, Model, Tool, TranscriptContext } from "../../src/types.ts";
import { bodyChunks, byteOffset, everyBytes, sseFetch, zeroTimes } from "./stream-helpers.ts";

export const RESPONSES_STREAM_DIR = fileURLToPath(
	new URL("../../../../crates/fixtures/openai-responses-stream/", import.meta.url),
);

function model(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	};
}

const patchTool: Tool = {
	name: "apply_patch",
	description: "Apply a patch.",
	parameters: {
		type: "object",
		properties: { patch: { type: "string" } },
		required: ["patch"],
	} as unknown as Tool["parameters"],
	constrainedSampling: { type: "grammar", variants: { openai_lark: 'start: "*** Begin Patch" /[\\s\\S]*/' } },
};

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
	{ role: "system", content: "Be brief.", toolsAdded: [readTool, patchTool], timestamp: 0 },
	{ role: "user", content: "Go.", timestamp: 0 },
];

/** One SSE event named after its type. */
const sse = (data: Record<string, unknown>) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

const created = sse({ type: "response.created", response: { id: "resp_1", status: "in_progress" } });

function completed(
	usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
	extra: Record<string, unknown> = {},
): string {
	return sse({
		type: "response.completed",
		response: { id: "resp_1", status: "completed", usage, ...extra },
	});
}

const messageAdded = (index: number, id = "msg_1") =>
	sse({
		type: "response.output_item.added",
		output_index: index,
		item: { type: "message", id, role: "assistant", status: "in_progress", content: [] },
	});
const textDelta = (index: number, delta: string) =>
	sse({ type: "response.output_text.delta", output_index: index, content_index: 0, delta });
const messageDone = (index: number, text: string, extra: Record<string, unknown> = {}) =>
	sse({
		type: "response.output_item.done",
		output_index: index,
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text, annotations: [] }],
			...extra,
		},
	});
const functionAdded = (index: number, callId: string, name = "read") =>
	sse({
		type: "response.output_item.added",
		output_index: index,
		item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: "" },
	});
const argumentsDelta = (index: number, delta: string) =>
	sse({ type: "response.function_call_arguments.delta", output_index: index, delta });
const functionDone = (index: number, callId: string, args: string, extra: Record<string, unknown> = {}) =>
	sse({
		type: "response.output_item.done",
		output_index: index,
		item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "read", arguments: args, ...extra },
	});

export interface ResponsesStreamCase {
	name: string;
	description: string;
	model: Model<"openai-responses">;
	options: OpenAIResponsesOptions;
	messages: Message[];
	sse: string;
	splits: number[];
}

export function responsesStreamCases(): ResponsesStreamCase[] {
	const base = { model: model(), options: {}, messages: MESSAGES, splits: [] as number[] };
	const reasoningItem = {
		type: "reasoning",
		id: "rs_1",
		summary: [
			{ type: "summary_text", text: "First part." },
			{ type: "summary_text", text: "Second part." },
		],
		encrypted_content: "enc-1",
	};
	const full =
		created +
		sse({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "reasoning", id: "rs_1", summary: [] },
		}) +
		sse({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "First " }) +
		sse({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "part." }) +
		sse({ type: "response.reasoning_summary_part.done", output_index: 0, summary_index: 0 }) +
		sse({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 1, delta: "Second part." }) +
		sse({ type: "response.output_item.done", output_index: 0, item: reasoningItem }) +
		messageAdded(1) +
		textDelta(1, "Reading ") +
		textDelta(1, "the file.") +
		messageDone(1, "Reading the file.", { phase: "commentary" }) +
		functionAdded(2, "call_1") +
		argumentsDelta(2, '{"pa') +
		argumentsDelta(2, 'th":"a.ts"}') +
		sse({ type: "response.function_call_arguments.done", output_index: 2, arguments: '{"path":"a.ts"}' }) +
		functionDone(2, "call_1", '{"path":"a.ts"}') +
		completed({
			input_tokens: 1000,
			input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
			output_tokens: 300,
			output_tokens_details: { reasoning_tokens: 120 },
			total_tokens: 1300,
		});
	const framed = [
		": keep-alive\r\n\r\n",
		created.replace(/\n/g, "\r\n"),
		messageAdded(0).replace(/\n/g, "\r"),
		'event: response.output_text.delta\ndata: {"type": "response.output_text.delta",\ndata: "output_index": 0, "delta": "café 🙈"}\n\n',
		"id: 3\nretry: 10\n",
		textDelta(0, "!"),
		messageDone(0, "café 🙈!", { phase: "final_answer" }),
		completed(),
		"data: [DONE]\n\n",
		textDelta(0, " after done"),
	].join("");
	return [
		{
			...base,
			name: "text",
			description: "A plain text answer.",
			sse:
				created +
				messageAdded(0) +
				textDelta(0, "Hello") +
				textDelta(0, ", world.") +
				messageDone(0, "Hello, world.") +
				completed(),
		},
		{
			...base,
			name: "reasoning-text-and-tool",
			description: "A reasoning summary, text and a function call; cached and reasoning tokens.",
			sse: full,
		},
		{
			...base,
			name: "reasoning-text-and-tool-chunked",
			description: "The same stream in 5-byte chunks.",
			sse: full,
			splits: everyBytes(full, 5),
		},
		{
			...base,
			name: "reasoning-content",
			description: "Reasoning text deltas, and the item's content as the thinking.",
			sse:
				created +
				sse({
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "reasoning", id: "rs_2", summary: [] },
				}) +
				sse({ type: "response.reasoning_text.delta", output_index: 0, content_index: 0, delta: "Raw " }) +
				sse({ type: "response.reasoning_text.delta", output_index: 0, content_index: 0, delta: "thought" }) +
				sse({
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "reasoning",
						id: "rs_2",
						summary: [],
						content: [{ type: "reasoning_text", text: "Raw thought" }],
					},
				}) +
				messageAdded(1) +
				textDelta(1, "Done") +
				messageDone(1, "Done") +
				completed(),
		},
		{
			...base,
			name: "custom-tool",
			description: "A grammar tool call: input deltas become JSON argument deltas.",
			model: model({ compat: { supportsOpenAIGrammarTools: true } }),
			sse:
				created +
				sse({
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_p", name: "apply_patch", input: "" },
				}) +
				sse({ type: "response.custom_tool_call_input.delta", output_index: 0, delta: "*** Begin " }) +
				sse({ type: "response.custom_tool_call_input.delta", output_index: 0, delta: 'Patch\n"q"' }) +
				sse({ type: "response.custom_tool_call_input.done", output_index: 0, input: '*** Begin Patch\n"q"\tend' }) +
				sse({
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "custom_tool_call",
						id: "ctc_1",
						call_id: "call_p",
						name: "apply_patch",
						input: '*** Begin Patch\n"q"\tend',
					},
				}) +
				completed(),
		},
		{
			...base,
			name: "custom-tool-changed",
			description: "Custom tool input that changes non-monotonically is an error.",
			model: model({ compat: { supportsOpenAIGrammarTools: true } }),
			sse:
				created +
				sse({
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "custom_tool_call", id: "ctc_2", call_id: "call_q", name: "apply_patch", input: "" },
				}) +
				sse({ type: "response.custom_tool_call_input.delta", output_index: 0, delta: "abc" }) +
				sse({ type: "response.custom_tool_call_input.done", output_index: 0, input: "xyz" }) +
				completed(),
		},
		{
			...base,
			name: "refusal",
			description: "Refusal deltas become text; the item's refusal is the final text.",
			sse:
				created +
				messageAdded(0) +
				sse({ type: "response.refusal.delta", output_index: 0, content_index: 0, delta: "I can't " }) +
				sse({ type: "response.refusal.delta", output_index: 0, content_index: 0, delta: "help." }) +
				sse({
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_r",
						role: "assistant",
						content: [{ type: "refusal", refusal: "I can't help." }],
					},
				}) +
				completed(),
		},
		{
			...base,
			name: "incomplete-length",
			description: "Incomplete at the output limit.",
			sse:
				created +
				messageAdded(0) +
				textDelta(0, "Cut") +
				messageDone(0, "Cut") +
				sse({
					type: "response.incomplete",
					response: {
						id: "resp_1",
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					},
				}),
		},
		{
			...base,
			name: "incomplete-filter",
			description: "Incomplete for another reason is an error.",
			sse:
				created +
				sse({
					type: "response.incomplete",
					response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "content_filter" } },
				}),
		},
		{
			...base,
			name: "failed",
			description: "A failed response with an error.",
			sse:
				created +
				messageAdded(0) +
				textDelta(0, "Part") +
				sse({
					type: "response.failed",
					response: { id: "resp_1", status: "failed", error: { code: "server_error", message: "Boom." } },
				}),
		},
		{
			...base,
			name: "failed-details",
			description: "A failed response with only incomplete details.",
			sse:
				created +
				sse({ type: "response.failed", response: { status: "failed", incomplete_details: { reason: "x" } } }),
		},
		{
			...base,
			name: "failed-bare",
			description: "A failed response without details.",
			sse: created + sse({ type: "response.failed", response: {} }),
		},
		{
			...base,
			name: "error-event",
			description: "An error event.",
			sse: created + sse({ type: "error", code: "rate_limit_exceeded", message: "Slow down." }),
		},
		{
			...base,
			name: "data-error",
			description: "Event data with an error field is an API error.",
			sse: `${created}data: {"error": {"message": "Quota exceeded.", "type": "insufficient_quota"}}\n\n`,
		},
		{
			...base,
			name: "chatgpt-usage-limit",
			description: "The ChatGPT usage limit error points at the usage page.",
			sse: `${created}data: {"error": {"message": "subscription_sharing_usage_limit_exceeded: wait."}}\n\n`,
		},
		{
			...base,
			name: "no-terminal-event",
			description: "The stream ends before a terminal response event.",
			sse: created + messageAdded(0) + textDelta(0, "Hm") + messageDone(0, "Hm"),
		},
		{
			...base,
			name: "unfinished-tool-call",
			description: "A completed response with a tool call whose item never finished.",
			sse: created + functionAdded(0, "call_u") + argumentsDelta(0, '{"path":') + completed(),
		},
		{
			...base,
			name: "arguments-replaced",
			description: "Final arguments that do not extend the deltas send no delta; the item's arguments win.",
			sse:
				created +
				functionAdded(0, "call_r") +
				argumentsDelta(0, '{"path":"x"') +
				sse({ type: "response.function_call_arguments.done", output_index: 0, arguments: '{"path":"y"}' }) +
				functionDone(0, "call_r", '{"path":"z"}', { namespace: "files" }) +
				completed(),
		},
		{
			...base,
			name: "backfill-encrypted-reasoning",
			description: "Encrypted reasoning only in response.completed is backfilled into the signature.",
			sse:
				created +
				sse({
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "reasoning", id: "rs_3", summary: [{ type: "summary_text", text: "Think." }] },
				}) +
				messageAdded(1) +
				messageDone(1, "Ok") +
				completed(undefined, {
					output: [{ type: "reasoning", id: "rs_3", summary: [], encrypted_content: "late-enc" }],
				}),
		},
		{
			...base,
			name: "service-tier-flex",
			description: "The response's flex tier halves the cost.",
			sse:
				created +
				messageAdded(0) +
				messageDone(0, "Cheap") +
				completed({ input_tokens: 2000, output_tokens: 1000, total_tokens: 3000 }, { service_tier: "flex" }),
		},
		{
			...base,
			name: "service-tier-requested",
			description: "Without a tier in the response, the requested priority tier applies (2.5x for gpt-5.5).",
			model: model({ id: "gpt-5.5" }),
			options: { serviceTier: "priority" },
			sse:
				created +
				messageAdded(0) +
				messageDone(0, "Fast") +
				completed({ input_tokens: 2000, output_tokens: 1000, total_tokens: 3000 }),
		},
		{
			...base,
			name: "status-in-progress",
			description: "A terminal event with status in_progress maps to stop.",
			sse:
				created +
				messageAdded(0) +
				messageDone(0, "Ok") +
				sse({ type: "response.completed", response: { status: "in_progress" } }),
		},
		{
			...base,
			name: "status-unknown",
			description: "An unknown status is an error.",
			sse: created + sse({ type: "response.completed", response: { status: "strange" } }),
		},
		{
			...base,
			name: "framing",
			description: "CRLF and CR line ends, comments, multi-line data, unknown fields, events after [DONE].",
			sse: framed,
			splits: [
				2,
				byteOffset(framed, "\r\n") + 1,
				byteOffset(framed, "é") + 1,
				byteOffset(framed, "🙈") + 2,
				byteOffset(framed, "[DONE]") + 3,
			],
		},
	];
}

export async function decodeResponses(testCase: ResponsesStreamCase): Promise<{ events: unknown[] }> {
	const events: unknown[] = [];
	const output = stream(testCase.model, { messages: testCase.messages } as TranscriptContext, {
		...testCase.options,
		apiKey: "sk-parity",
		cacheRetention: "none",
		fetch: sseFetch(bodyChunks(testCase.sse, testCase.splits)),
	});
	for await (const event of output) {
		const { partial: _partial, ...rest } = event as { partial?: unknown };
		events.push(rest);
	}
	return zeroTimes(JSON.parse(JSON.stringify({ events }))) as { events: unknown[] };
}

export async function responsesStreamJson(testCase: ResponsesStreamCase): Promise<string> {
	const { name, description, model: caseModel, options, messages, sse: body, splits } = testCase;
	const fixture = {
		name,
		description,
		model: caseModel,
		options,
		messages,
		sse: body,
		splits,
		...(await decodeResponses(testCase)),
	};
	return `${JSON.stringify(fixture, null, "\t")}\n`;
}

export function readResponsesStreamCase(name: string): string {
	return readFileSync(join(RESPONSES_STREAM_DIR, `${name}.json`), "utf8");
}
