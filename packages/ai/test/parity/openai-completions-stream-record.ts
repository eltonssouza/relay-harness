/**
 * Reference OpenAI Chat Completions stream decoding, for the Rust decoder to match.
 *
 * Each case feeds a scripted server-sent event stream to the real `stream()` of
 * `openai-completions.ts` through `options.fetch` (the OpenAI SDK the adapter loads parses it),
 * split into byte chunks at the given offsets, and records the events without their live
 * `partial` snapshot, and the final message. Times become 0.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stream } from "../../src/api/openai-completions.ts";
import type { Message, Model, Tool, TranscriptContext } from "../../src/types.ts";
import { bodyChunks, byteOffset, everyBytes, sseFetch, zeroTimes } from "./stream-helpers.ts";

export const COMPLETIONS_STREAM_DIR = fileURLToPath(
	new URL("../../../../crates/fixtures/openai-completions-stream/", import.meta.url),
);

type CompletionsModel = Model<"openai-completions">;

function model(overrides: Partial<CompletionsModel> = {}): CompletionsModel {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.6 },
		contextWindow: 128000,
		maxTokens: 32000,
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

/** One data-only SSE event, as Chat Completions servers send them. */
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const done = "data: [DONE]\n\n";

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}, finish: string | null = null) {
	return data({
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		model: "test-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
		...extra,
	});
}

const finish = (reason: string) => chunk({}, {}, reason);
const usageChunk = (usage: Record<string, unknown>) =>
	data({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "test-model", choices: [], usage });
const toolDelta = (calls: unknown[]) => chunk({ tool_calls: calls });

export interface CompletionsStreamCase {
	name: string;
	description: string;
	model: CompletionsModel;
	messages: Message[];
	sse: string;
	splits: number[];
}

export function completionsStreamCases(): CompletionsStreamCase[] {
	const base = { model: model(), messages: MESSAGES, splits: [] as number[] };
	const full =
		chunk({ role: "assistant", content: "" }) +
		chunk({ reasoning_content: "Read the " }) +
		chunk({ reasoning_content: "file." }) +
		chunk({ content: "Reading " }) +
		toolDelta([{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }]) +
		toolDelta([{ index: 0, function: { arguments: '{"pa' } }]) +
		chunk({ content: "now." }) +
		toolDelta([{ index: 0, function: { arguments: 'th":"a.ts"}' } }]) +
		finish("tool_calls") +
		usageChunk({
			prompt_tokens: 1000,
			completion_tokens: 200,
			prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 50 },
			completion_tokens_details: { reasoning_tokens: 80 },
		}) +
		done;
	return [
		{
			...base,
			name: "text",
			description: "A plain answer and a usage chunk.",
			sse:
				chunk({ role: "assistant", content: "Hello" }) +
				chunk({ content: ", world." }) +
				finish("stop") +
				usageChunk({ prompt_tokens: 20, completion_tokens: 4 }) +
				done,
		},
		{
			...base,
			name: "reasoning-text-and-tool",
			description: "Reasoning, interleaved text and a tool call; cached, cache-write and reasoning tokens.",
			sse: full,
		},
		{
			...base,
			name: "reasoning-text-and-tool-chunked",
			description: "The same stream in 6-byte chunks.",
			sse: full,
			splits: everyBytes(full, 6),
		},
		{
			...base,
			name: "reasoning-field-order",
			description: "The first non-empty reasoning field wins (chutes sends two).",
			sse:
				chunk({ reasoning_content: "", reasoning: "Dup " }) +
				chunk({ reasoning: "text", reasoning_text: "ignored" }) +
				chunk({ content: "Ok" }) +
				finish("stop") +
				done,
		},
		{
			...base,
			name: "opencode-go-reasoning",
			description: "opencode-go's reasoning field is replayed as reasoning_content.",
			model: model({ provider: "opencode-go" }),
			sse: chunk({ reasoning: "Thinking" }) + chunk({ content: "Done" }) + finish("stop") + done,
		},
		{
			...base,
			name: "reasoning-details",
			description: "Streamed reasoning details merge into the thinking signature.",
			sse:
				chunk({
					reasoning_details: [
						{ type: "reasoning.summary", summary: "First ", id: null, format: "openrouter", index: 0 },
					],
				}) +
				chunk({ reasoning_details: [{ type: "reasoning.summary", summary: "summary.", id: "rs_1", index: 0 }] }) +
				chunk({
					reasoning_details: [
						{ type: "reasoning.encrypted", data: "enc-1", id: "rs_2", format: "openrouter", index: 1 },
						{ type: "reasoning.text", text: "Raw ", index: 2 },
						{ type: "reasoning.unknown", text: "dropped" },
						{ type: "reasoning.text", text: "thought.", signature: "sig-1", format: "openrouter", index: 2 },
					],
				}) +
				chunk({ reasoning: "Visible reasoning." }) +
				chunk({ content: "Answer." }) +
				finish("stop") +
				done,
		},
		{
			...base,
			name: "parallel-tool-calls",
			description: "Two tool calls by stream index; a later delta matched by id only.",
			sse:
				toolDelta([
					{ index: 0, id: "call_a", type: "function", function: { name: "read", arguments: '{"path":' } },
					{ index: 1, id: "call_b", type: "function", function: { name: "", arguments: "" } },
				]) +
				toolDelta([{ index: 1, function: { name: "read", arguments: '{"path":"b' } }]) +
				toolDelta([{ index: 0, function: { arguments: '"a"}' } }]) +
				toolDelta([{ id: "call_b", function: { arguments: '.ts"}' } }]) +
				toolDelta([{ index: 2, function: { name: "read" } }]) +
				finish("tool_calls") +
				done,
		},
		{
			...base,
			name: "custom-tool",
			description: "A grammar tool call: custom input deltas become JSON argument deltas.",
			model: model({ compat: { supportsOpenAIGrammarTools: true } }),
			sse:
				toolDelta([
					{ index: 0, id: "call_p", type: "custom", custom: { name: "apply_patch", input: "*** Begin " } },
				]) +
				toolDelta([{ index: 0, custom: { input: 'Patch\n"x"' } }]) +
				finish("tool_calls") +
				done,
		},
		{
			...base,
			name: "finish-length",
			description: "The answer hits the output limit.",
			sse: chunk({ content: "Long" }) + finish("length") + done,
		},
		{
			...base,
			name: "finish-content-filter",
			description: "A content filter stop is an error, after the blocks end.",
			sse: chunk({ content: "Part" }) + finish("content_filter") + done,
		},
		{
			...base,
			name: "finish-unknown",
			description: "An unknown finish reason is an error.",
			sse: chunk({ content: "?" }) + finish("weird") + done,
		},
		{
			...base,
			name: "no-finish-reason",
			description: "A stream without a finish reason is an error.",
			sse: chunk({ content: "Hm" }) + done,
		},
		{
			...base,
			name: "no-finish-reason-allowed",
			description: "A server without finish reasons: the stop reason comes from the content.",
			model: model({ compat: { supportsFinishReason: false } }),
			sse:
				chunk({ content: "Calling" }) +
				toolDelta([{ index: 0, id: "call_n", function: { name: "read", arguments: '{"path":"x"}' } }]) +
				done,
		},
		{
			...base,
			name: "usage-in-choice",
			description: "Usage inside the choice (Moonshot), with top-level cached tokens.",
			sse:
				chunk({ content: "Hi" }) +
				data({
					id: "chatcmpl-1",
					model: "moonshot-v1",
					choices: [
						{
							index: 0,
							delta: {},
							finish_reason: "stop",
							usage: { prompt_tokens: 50, completion_tokens: 5, cached_tokens: 30 },
						},
					],
				}) +
				done,
		},
		{
			...base,
			name: "usage-deepseek",
			description: "DeepSeek's prompt_cache_hit_tokens.",
			sse:
				chunk({ content: "Hi" }) +
				finish("stop") +
				usageChunk({ prompt_tokens: 500, completion_tokens: 10, prompt_cache_hit_tokens: 400 }) +
				done,
		},
		{
			...base,
			name: "api-error",
			description: "Event data with an error field is an API error; OpenRouter's raw metadata is appended.",
			sse:
				chunk({ content: "Part" }) +
				data({ error: { message: "Provider failed.", code: 502, metadata: { raw: "upstream timeout" } } }),
		},
		{
			...base,
			name: "malformed-json",
			description: "Malformed event JSON.",
			sse: `${chunk({ content: "Part" })}data: {"choices": [\n\n`,
		},
		{
			...base,
			name: "odd-chunks",
			description: "Non-object data and chunks without choices are skipped; text after [DONE] is not read.",
			sse:
				"data: 42\n\n" +
				data({ id: "chatcmpl-9", model: "test-model" }) +
				chunk({ content: "Kept" }) +
				finish("stop") +
				done +
				chunk({ content: " not read" }),
		},
		{
			...base,
			name: "framing",
			description: "CRLF line ends, comments and a split multi-byte character.",
			sse: `: ping\r\n\r\n${chunk({ content: "café 🙈" }).replace(/\n/g, "\r\n")}${finish("stop")}${done}`,
			splits: [3, 40, 41],
		},
	].map((testCase) =>
		testCase.name === "framing"
			? { ...testCase, splits: [3, byteOffset(testCase.sse, "é") + 1, byteOffset(testCase.sse, "🙈") + 2] }
			: testCase,
	);
}

export async function decodeCompletions(testCase: CompletionsStreamCase): Promise<{ events: unknown[] }> {
	const events: unknown[] = [];
	const output = stream(testCase.model, { messages: testCase.messages } as TranscriptContext, {
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

export async function completionsStreamJson(testCase: CompletionsStreamCase): Promise<string> {
	const { name, description, model: caseModel, messages, sse: body, splits } = testCase;
	const fixture = {
		name,
		description,
		model: caseModel,
		messages,
		sse: body,
		splits,
		...(await decodeCompletions(testCase)),
	};
	return `${JSON.stringify(fixture, null, "\t")}\n`;
}

export function readCompletionsStreamCase(name: string): string {
	return readFileSync(join(COMPLETIONS_STREAM_DIR, `${name}.json`), "utf8");
}
