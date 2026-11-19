/**
 * Reference OpenAI Responses request bodies, for the Rust adapter to match byte for byte.
 *
 * Each case runs the real `stream()` of `openai-responses.ts` and captures the body in
 * `onPayload`, which throws before any request is sent. Transcripts: the agent's request from the
 * read-file scenario, and ones written here for ids, text signatures, reasoning items, tool
 * additions and grammar tools. The files live in `crates/fixtures/openai-responses/`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OpenAIResponsesOptions, stream } from "../../src/api/openai-responses.ts";
import type { Message, Model, Tool, TranscriptContext } from "../../src/types.ts";

export const OPENAI_RESPONSES_DIR = fileURLToPath(
	new URL("../../../../crates/fixtures/openai-responses/", import.meta.url),
);
const SCENARIOS_DIR = fileURLToPath(new URL("../../../../crates/fixtures/scenarios/", import.meta.url));

const API_KEY = "sk-parity";
const ADAPTER_ENV = ["RELAY_CACHE_RETENTION"];

function model(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	};
}

const reasoningModel = (overrides: Partial<Model<"openai-responses">> = {}) =>
	model({ id: "gpt-reasoning", reasoning: true, ...overrides });

const tool = (name: string, properties: Record<string, unknown>, extra: Partial<Tool> = {}): Tool => ({
	name,
	description: `The ${name} tool.`,
	parameters: {
		type: "object",
		properties,
		required: Object.keys(properties).slice(0, 1),
	} as unknown as Tool["parameters"],
	...extra,
});

const readTool = tool("read", { path: { type: "string" }, limit: { type: "number" } });
const writeTool = tool("write", { path: { type: "string" }, content: { type: "string" } });
const strictTool = tool(
	"search",
	{ query: { type: "string" }, kind: { type: "string" } },
	{ constrainedSampling: { type: "json_schema", strict: "prefer" } },
);
const patchTool = tool(
	"apply_patch",
	{ patch: { type: "string" } },
	{ constrainedSampling: { type: "grammar", variants: { openai_lark: 'start: "*** Begin Patch" /[\\s\\S]*/' } } },
);

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: unknown[], from: Partial<{ provider: string; api: string; model: string }> = {}): Message {
	return {
		role: "assistant",
		content,
		api: from.api ?? "openai-responses",
		provider: from.provider ?? "openai",
		model: from.model ?? "gpt-test",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	} as Message;
}

const result = (toolCallId: string, toolName: string, content: unknown[]): Message =>
	({ role: "toolResult", toolCallId, toolName, content, isError: false, timestamp: 0 }) as Message;

/** Ids, text signatures, reasoning items and results in their many forms. */
const EDGE_TRANSCRIPT: Message[] = [
	{
		role: "system",
		content: "Base prompt.",
		sections: { rules: "<rules>Be brief.</rules>" },
		toolsAdded: [readTool, writeTool],
		timestamp: 0,
	},
	{
		role: "user",
		content: [
			{ type: "text", text: "Look." },
			{ type: "image", data: IMAGE, mimeType: "image/png" },
		],
		timestamp: 0,
	},
	{ role: "user", content: [], timestamp: 0 },
	assistant([
		{
			type: "thinking",
			thinking: "Plan.",
			thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" }),
		},
		{ type: "thinking", thinking: "No signature." },
		{ type: "text", text: "Signed v1.", textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }) },
		{ type: "text", text: "Legacy id.", textSignature: "msg_legacy" },
		{ type: "text", text: "Long id.", textSignature: `msg_${"x".repeat(70)}` },
		{ type: "text", text: "No signature." },
		{ type: "toolCall", id: "call_1|fc_item1", name: "read", arguments: { path: "a.ts", limit: 20 } },
		{ type: "toolCall", id: "call_2|bad_item", name: "read", arguments: { path: "b.ts" }, namespace: "files" },
	]),
	result("call_1|fc_item1", "read", [{ type: "text", text: "a" }]),
	result("call_2|bad_item", "read", [
		{ type: "text", text: "with image" },
		{ type: "image", data: IMAGE, mimeType: "image/png" },
	]),
	{
		role: "system",
		content: "Later instructions.",
		toolsAdded: [strictTool],
		toolsRemoved: [{ name: "write" }],
		timestamp: 0,
	},
	assistant([{ type: "toolCall", id: "call_3|fc_item3", name: "read", arguments: { path: "c.ts" } }], {
		model: "gpt-other",
	}),
	result("call_3|fc_item3", "read", []),
	assistant(
		[
			{ type: "text", text: "From Claude." },
			{ type: "toolCall", id: "toolu_01AbC", name: "read", arguments: { path: "d.ts" } },
			{ type: "toolCall", id: "call_9|item+9/🙈", name: "read", arguments: { path: "e.ts" } },
		],
		{ provider: "anthropic", api: "anthropic-messages", model: "claude-test" },
	),
	result("toolu_01AbC", "read", [{ type: "image", data: IMAGE, mimeType: "image/png" }]),
	{ role: "user", content: "Continue.", timestamp: 0 },
];

/** Tools only added later, which models with additional tools or tool search load in place. */
const ADDITIONS_TRANSCRIPT: Message[] = [
	{ role: "system", content: "Base prompt.", toolsAdded: [readTool], timestamp: 0 },
	{ role: "user", content: "Start.", timestamp: 0 },
	assistant([{ type: "text", text: "Ready." }]),
	{ role: "system", content: "", toolsAdded: [writeTool, strictTool], timestamp: 0 },
	{ role: "user", content: "Write.", timestamp: 0 },
];

/** A grammar tool and a call to it. */
const GRAMMAR_TRANSCRIPT: Message[] = [
	{ role: "system", content: "Patch files.", toolsAdded: [patchTool, readTool], timestamp: 0 },
	{ role: "user", content: "Fix it.", timestamp: 0 },
	assistant([
		{ type: "toolCall", id: "call_p|ctc_1", name: "apply_patch", arguments: { patch: "*** Begin Patch\n..." } },
		{ type: "toolCall", id: "call_r|fc_2", name: "read", arguments: { path: "a.ts" } },
	]),
	result("call_p|ctc_1", "apply_patch", [{ type: "text", text: "applied" }]),
	result("call_r|fc_2", "read", [{ type: "text", text: "a" }]),
];

function scenarioRequest(name: string, index: number): Message[] {
	const recording = JSON.parse(readFileSync(join(SCENARIOS_DIR, `${name}.json`), "utf8")) as {
		requests: Message[][];
	};
	return recording.requests[index]!;
}

export interface ResponsesCase {
	name: string;
	description: string;
	model: Model<"openai-responses">;
	apiKey: string;
	options: OpenAIResponsesOptions;
	messages: Message[];
}

export function responsesCases(): ResponsesCase[] {
	const base = {
		apiKey: API_KEY,
		options: { sessionId: "session-1" } as OpenAIResponsesOptions,
		messages: scenarioRequest("read-file", 1),
		model: model(),
	};
	return [
		{ ...base, name: "api-key", description: "An API key and the read-file conversation." },
		{
			...base,
			name: "reasoning-effort",
			description: "A requested effort, mapped through the model's levels, with a summary.",
			model: reasoningModel({ thinkingLevelMap: { high: "xhigh", off: null } }),
			options: { reasoningEffort: "high", reasoningSummary: "concise" },
		},
		{
			...base,
			name: "reasoning-summary-only",
			description: "A summary alone asks for medium effort.",
			model: reasoningModel(),
			options: { reasoningSummary: "detailed" },
		},
		{
			...base,
			name: "reasoning-off",
			description: "No effort on a reasoning model sends the model's off level.",
			model: reasoningModel({ thinkingLevelMap: { off: "minimal" } }),
		},
		{
			...base,
			name: "reasoning-off-default",
			description: "No effort and no off level sends none.",
			model: reasoningModel(),
		},
		{
			...base,
			name: "reasoning-off-unsupported",
			description: "A model that cannot turn reasoning off sends no reasoning field.",
			model: reasoningModel({ thinkingLevelMap: { off: null } }),
		},
		{
			...base,
			name: "copilot-reasoning",
			description: "GitHub Copilot sends no off level.",
			model: reasoningModel({ provider: "github-copilot" }),
		},
		{
			...base,
			name: "xai-include",
			description: "xAI always asks for encrypted reasoning.",
			model: reasoningModel({ provider: "xai" }),
		},
		{
			...base,
			name: "chatgpt-sign-in",
			description: "A ChatGPT sign-in token omits the fields it rejects.",
			model: model({ baseUrl: "https://api.openai.com/v1" }),
			apiKey: "eyJhbGciOi.parity",
			options: { sessionId: "session-1", cacheRetention: "long", maxTokens: 4000, temperature: 0.2 },
		},
		{
			...base,
			name: "cache-long",
			description: "Long retention asks for 24h.",
			options: { sessionId: "session-1", cacheRetention: "long" },
		},
		{
			...base,
			name: "cache-none",
			description: "No retention sends no cache key.",
			options: { sessionId: "session-1", cacheRetention: "none" },
		},
		{
			...base,
			name: "cache-explicit-none",
			description: "Explicit cache mode with no retention.",
			model: model({ compat: { supportsExplicitPromptCacheMode: true } }),
			options: { sessionId: "session-1", cacheRetention: "none" },
		},
		{
			...base,
			name: "cache-explicit-long",
			description: "Explicit cache mode with long retention asks for 30m.",
			model: model({ compat: { supportsExplicitPromptCacheMode: true } }),
			options: { sessionId: "session-1", cacheRetention: "long" },
		},
		{
			...base,
			name: "long-session-key",
			description: "A cache key longer than 64 code points is cut.",
			options: { sessionId: `${"🙈".repeat(10)}${"k".repeat(60)}` },
		},
		{
			...base,
			name: "request-options",
			description: "Output limit (at least 16), temperature, service tier and tool choice.",
			options: {
				sessionId: "session-1",
				maxTokens: 8,
				temperature: 0.7,
				serviceTier: "flex",
				toolChoice: "required",
			},
		},
		{
			...base,
			name: "no-max-output-tokens",
			description: "A model without max_output_tokens.",
			model: model({ compat: { supportsMaxOutputTokens: false } }),
			options: { maxTokens: 1000 },
		},
		{
			...base,
			name: "sampling-params",
			description: "Model, thinking-level and request sampling parameters merged last.",
			model: reasoningModel({
				samplingParams: { top_p: 0.9, temperature: 1 },
				samplingParamsByThinkingLevel: { medium: { top_k: 20 } },
			}),
			options: { reasoningEffort: "medium", samplingParams: { top_p: 0.5, min_p: 0.1 }, temperature: 0.3 },
		},
		{
			...base,
			name: "edge",
			description: "Ids, signatures, reasoning items and results.",
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "edge-reasoning",
			description: "The edge transcript on a reasoning model: developer instructions.",
			model: reasoningModel({ id: "gpt-test" }),
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "edge-no-developer-role",
			description: "A reasoning model without the developer role.",
			model: reasoningModel({ id: "gpt-test", compat: { supportsDeveloperRole: false } }),
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "edge-mid-system",
			description: "Later system messages sent in place.",
			model: model({ compat: { supportsMidConvoSystemMessages: true } }),
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "edge-no-vision",
			description: "Images become placeholders on a text-only model.",
			model: model({ input: ["text"] }),
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "edge-other-provider",
			description: "A provider outside OpenAI's own normalizes whole ids.",
			model: model({ provider: "openrouter" }),
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "additional-tools",
			description: "Tools added later load in place with additional_tools.",
			model: model({ compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } }),
			messages: ADDITIONS_TRANSCRIPT,
		},
		{
			...base,
			name: "tool-search",
			description: "Tools added later load in place through a client tool search.",
			model: model({ compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true } }),
			messages: ADDITIONS_TRANSCRIPT,
		},
		{
			...base,
			name: "additions-folded",
			description: "Without either, the request carries the current tool list.",
			messages: ADDITIONS_TRANSCRIPT,
		},
		{
			...base,
			name: "strict-mode",
			description: "Strict mode where the model supports it.",
			model: model({ compat: { supportsStrictMode: true } }),
			messages: ADDITIONS_TRANSCRIPT,
		},
		{
			...base,
			name: "grammar-tools",
			description: "A grammar tool as a custom tool, with its call and result.",
			model: model({ compat: { supportsOpenAIGrammarTools: true } }),
			messages: GRAMMAR_TRANSCRIPT,
		},
		{
			...base,
			name: "grammar-unsupported",
			description: "The same transcript on a model without grammar tools.",
			messages: GRAMMAR_TRANSCRIPT,
		},
	];
}

export async function responsesBody(testCase: ResponsesCase): Promise<unknown> {
	const saved = ADAPTER_ENV.map((name) => [name, process.env[name]] as const);
	for (const name of ADAPTER_ENV) delete process.env[name];
	let body: unknown;
	let failure: string | undefined;
	try {
		const events = stream(testCase.model, { messages: testCase.messages } as TranscriptContext, {
			...testCase.options,
			apiKey: testCase.apiKey,
			onPayload: (payload) => {
				body = payload;
				throw new Error("body recorded");
			},
		});
		const message = await events.result();
		if (body === undefined) failure = message.errorMessage;
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
	if (body === undefined) throw new Error(`${testCase.name}: the adapter sent no body: ${failure}`);
	return body;
}

export async function responsesJson(testCase: ResponsesCase): Promise<string> {
	const { name, description, model: caseModel, apiKey, options, messages } = testCase;
	const fixture = {
		name,
		description,
		model: caseModel,
		apiKey,
		options,
		messages,
		body: await responsesBody(testCase),
	};
	return `${JSON.stringify(fixture, null, "\t")}\n`;
}

export function readResponsesCase(name: string): string {
	return readFileSync(join(OPENAI_RESPONSES_DIR, `${name}.json`), "utf8");
}
