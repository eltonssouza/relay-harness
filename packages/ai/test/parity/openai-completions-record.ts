/**
 * Reference OpenAI Chat Completions request bodies, for the Rust adapter to match byte for byte.
 *
 * Each case runs the real `stream()` of `openai-completions.ts` and captures the body in
 * `onPayload`, which throws before any request is sent. The cases reach each provider the adapter
 * detects from the provider id or base URL, each thinking format, and a transcript written here
 * for reasoning replay, tool call ids, tool result images and tool additions. The files live in
 * `crates/fixtures/openai-completions/`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OpenAICompletionsOptions, stream } from "../../src/api/openai-completions.ts";
import type { Message, Model, Tool, TranscriptContext } from "../../src/types.ts";

export const OPENAI_COMPLETIONS_DIR = fileURLToPath(
	new URL("../../../../crates/fixtures/openai-completions/", import.meta.url),
);
const SCENARIOS_DIR = fileURLToPath(new URL("../../../../crates/fixtures/scenarios/", import.meta.url));

const ADAPTER_ENV = ["RELAY_CACHE_RETENTION"];

type CompletionsModel = Model<"openai-completions">;

function model(overrides: Partial<CompletionsModel> = {}): CompletionsModel {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32000,
		...overrides,
	};
}

const reasoning = (overrides: Partial<CompletionsModel> = {}) => model({ reasoning: true, ...overrides });

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

const readTool = tool("read", { path: { type: "string" } });
const writeTool = tool("write", { path: { type: "string" }, content: { type: "string" } });
const strictTool = tool(
	"search",
	{ query: { type: "string" }, kind: { type: "string" } },
	{ constrainedSampling: { type: "json_schema", strict: "prefer" } },
);
const patchTool = tool(
	"apply_patch",
	{ patch: { type: "string" } },
	{ constrainedSampling: { type: "grammar", variants: { openai_regex: "^\\*\\*\\* Begin Patch[\\s\\S]*$" } } },
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
		api: from.api ?? "openai-completions",
		provider: from.provider ?? "custom",
		model: from.model ?? "test-model",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	} as Message;
}

const result = (toolCallId: string, toolName: string, content: unknown[]): Message =>
	({ role: "toolResult", toolCallId, toolName, content, isError: false, timestamp: 0 }) as Message;

const REASONING_DETAILS = JSON.stringify([
	{ type: "reasoning.summary", summary: "Planned the read.", id: "rd_1", format: "openai-responses-v1", index: 0 },
	{ type: "reasoning.encrypted", data: "enc-data", id: "rd_2", format: "openai-responses-v1", index: 1 },
]);

/** Reasoning replay, tool call ids, results with images, empty messages. */
const EDGE_TRANSCRIPT: Message[] = [
	{
		role: "system",
		content: "Base prompt.",
		sections: { rules: "<rules>Be brief.</rules>" },
		toolsAdded: [readTool],
		timestamp: 0,
	},
	{
		role: "user",
		content: [
			{ type: "text", text: "" },
			{ type: "text", text: "Look." },
			{ type: "image", data: IMAGE, mimeType: "image/png" },
		],
		timestamp: 0,
	},
	assistant([
		{ type: "thinking", thinking: "Raw reasoning.", thinkingSignature: "reasoning_content" },
		{ type: "thinking", thinking: "More reasoning." },
		{ type: "text", text: "Reading. " },
		{ type: "text", text: "  " },
		{ type: "text", text: "Now." },
		{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
	]),
	result("call_1", "read", [
		{ type: "text", text: "with image" },
		{ type: "image", data: IMAGE, mimeType: "image/png" },
	]),
	result("call_1b", "read", []),
	assistant([
		{ type: "thinking", thinking: "Summarized.", thinkingSignature: REASONING_DETAILS },
		{ type: "text", text: "Next." },
		{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "b.ts" } },
	]),
	result("call_2", "read", [{ type: "image", data: IMAGE, mimeType: "image/png" }]),
	{ role: "user", content: "Keep going.", timestamp: 0 },
	assistant([{ type: "text", text: "   " }]),
	assistant(
		[
			{ type: "thinking", thinking: "Foreign thought.", thinkingSignature: "sig" },
			{
				type: "toolCall",
				id: "call_abcdefghijklmnopqrstuvwxyz0123456789|fc_very+long/item=id",
				name: "read",
				arguments: { path: "c.ts" },
				thoughtSignature: JSON.stringify({ type: "reasoning.encrypted", id: "enc_1", data: "legacy-enc" }),
			},
			{ type: "toolCall", id: "call_short|fc_x", name: "read", arguments: { path: "d.ts" } },
			{
				type: "toolCall",
				id: "toolu_€ünïcödé_id_that_is_quite_a_bit_longer_than_forty",
				name: "read",
				arguments: {},
			},
		],
		{ provider: "openai", api: "openai-responses", model: "gpt-x" },
	),
	result("call_abcdefghijklmnopqrstuvwxyz0123456789|fc_very+long/item=id", "read", [{ type: "text", text: "c" }]),
	result("call_short|fc_x", "read", [{ type: "text", text: "d" }]),
	{ role: "user", content: "Done?", timestamp: 0 },
];

/** Later tools added in place, which a model with tool additions loads as a system message. */
const ADDITIONS_TRANSCRIPT: Message[] = [
	{ role: "system", content: "Base prompt.", toolsAdded: [readTool], timestamp: 0 },
	{ role: "user", content: "Start.", timestamp: 0 },
	assistant([{ type: "text", text: "Ready." }]),
	{ role: "system", content: "More tools.", toolsAdded: [writeTool, strictTool], timestamp: 0 },
	{ role: "user", content: "Write.", timestamp: 0 },
];

const GRAMMAR_TRANSCRIPT: Message[] = [
	{ role: "system", content: "Patch files.", toolsAdded: [patchTool, readTool], timestamp: 0 },
	{ role: "user", content: "Fix it.", timestamp: 0 },
	assistant([{ type: "toolCall", id: "call_p", name: "apply_patch", arguments: { patch: "*** Begin Patch\n..." } }]),
	result("call_p", "apply_patch", [{ type: "text", text: "applied" }]),
];

/** Tool calls in the history, but no tools declared. */
const TOOL_HISTORY_TRANSCRIPT: Message[] = [
	{ role: "system", content: "No tools now.", timestamp: 0 },
	{ role: "user", content: "Earlier.", timestamp: 0 },
	assistant([{ type: "toolCall", id: "call_h", name: "read", arguments: { path: "a.ts" } }]),
	result("call_h", "read", [{ type: "text", text: "a" }]),
	{ role: "user", content: "Again.", timestamp: 0 },
];

function scenarioRequest(name: string, index: number): Message[] {
	const recording = JSON.parse(readFileSync(join(SCENARIOS_DIR, `${name}.json`), "utf8")) as {
		requests: Message[][];
	};
	return recording.requests[index]!;
}

export interface CompletionsCase {
	name: string;
	description: string;
	model: CompletionsModel;
	apiKey: string;
	options: OpenAICompletionsOptions;
	messages: Message[];
}

export function completionsCases(): CompletionsCase[] {
	const base = {
		apiKey: "sk-parity",
		options: {} as OpenAICompletionsOptions,
		messages: scenarioRequest("read-file", 1),
		model: model(),
	};
	const openai = (overrides: Partial<CompletionsModel> = {}) =>
		model({ provider: "openai", baseUrl: "https://api.openai.com/v1", ...overrides });
	const chatTemplateKwargs = {
		enable_thinking: { $var: "thinking.enabled" },
		reasoning_effort: { $var: "thinking.effort" },
		budget: { $var: "thinking.budget", omitWhenOff: true },
		fixed: "on",
		count: 2,
		empty: null,
	} as const;
	return [
		{ ...base, name: "custom", description: "A generic OpenAI-compatible server and the read-file conversation." },
		{
			...base,
			name: "openai",
			description: "OpenAI itself: store, cache key and output limit.",
			model: openai(),
			options: { sessionId: "session-1", maxTokens: 4000, temperature: 0.4, toolChoice: "auto" },
		},
		{
			...base,
			name: "openai-reasoning",
			description: "A reasoning effort through the model's levels; developer instructions.",
			model: openai({ reasoning: true, thinkingLevelMap: { high: "xhigh" } }),
			options: { reasoningEffort: "high", sessionId: "session-1", cacheRetention: "long" },
		},
		{
			...base,
			name: "openai-reasoning-off",
			description: "No effort sends the model's off level.",
			model: openai({ reasoning: true, thinkingLevelMap: { off: "minimal" } }),
		},
		{
			...base,
			name: "deepseek",
			description: "DeepSeek thinking with an effort, max_tokens and reasoning_content on assistants.",
			model: reasoning({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1" }),
			options: { reasoningEffort: "medium", maxTokens: 8000 },
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "deepseek-off",
			description: "DeepSeek without an effort disables thinking.",
			model: reasoning({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1" }),
		},
		{
			...base,
			name: "zai",
			description: "Z.ai thinking and tool streaming.",
			model: reasoning({
				provider: "zai",
				baseUrl: "https://api.z.ai/api/paas/v4",
				compat: { zaiToolStream: true, supportsReasoningEffort: true },
			}),
			options: { reasoningEffort: "low", maxTokens: 2000 },
		},
		{
			...base,
			name: "zai-off",
			description: "Z.ai without an effort.",
			model: reasoning({ provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4" }),
		},
		{
			...base,
			name: "qwen",
			description: "Qwen's enable_thinking with an effort.",
			model: reasoning({ compat: { thinkingFormat: "qwen", supportsReasoningEffort: true } }),
			options: { reasoningEffort: "high" },
		},
		{
			...base,
			name: "qwen-chat-template",
			description: "Qwen thinking through chat template arguments.",
			model: reasoning({ compat: { thinkingFormat: "qwen-chat-template" } }),
		},
		{
			...base,
			name: "chat-template",
			description: "Chat template values resolved from the effort and the thinking budget.",
			model: reasoning({
				thinkingLevelMap: { medium: "mid" },
				compat: {
					thinkingFormat: "chat-template",
					chatTemplateKwargs,
					thinkingTokenBudgetField: "thinking_budget",
				},
			}),
			options: { reasoningEffort: "medium", maxTokens: 6000, thinkingBudgets: { medium: 3000 } },
		},
		{
			...base,
			name: "chat-template-off",
			description: "Chat template values without an effort.",
			model: reasoning({
				thinkingLevelMap: { off: "none" },
				compat: { thinkingFormat: "chat-template", chatTemplateKwargs },
			}),
		},
		{
			...base,
			name: "baseten",
			description: "Baseten's chat template arguments and effort.",
			model: reasoning({
				compat: {
					thinkingFormat: "baseten",
					chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
					supportsReasoningEffort: true,
					supportsThinkingTokenBudget: true,
				},
			}),
			options: { reasoningEffort: "xhigh", maxTokens: 9000 },
		},
		{
			...base,
			name: "openrouter-anthropic",
			description: "OpenRouter with an Anthropic model: developer role, cache markers, routing.",
			model: reasoning({
				id: "anthropic/claude-test",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				compat: { openRouterRouting: { order: ["anthropic"], allow_fallbacks: false } },
			}),
			options: { reasoningEffort: "high", sessionId: "session-1", cacheRetention: "long" },
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "openrouter-off",
			description: "OpenRouter reasoning off.",
			model: reasoning({ id: "qwen/qwen3", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }),
		},
		{
			...base,
			name: "ant-ling",
			description: "Ant Ling's mapped effort.",
			model: reasoning({
				provider: "ant-ling",
				baseUrl: "https://api.ant-ling.com/v1",
				thinkingLevelMap: { low: "light" },
			}),
			options: { reasoningEffort: "low" },
		},
		{
			...base,
			name: "together",
			description: "Together's reasoning switch.",
			model: reasoning({ provider: "together", baseUrl: "https://api.together.xyz/v1" }),
			options: { reasoningEffort: "medium" },
		},
		{
			...base,
			name: "string-thinking",
			description: "Thinking as a string field.",
			model: reasoning({ compat: { thinkingFormat: "string-thinking" }, thinkingLevelMap: { off: "off-mode" } }),
		},
		{
			...base,
			name: "xai",
			description: "xAI: no store, no reasoning effort.",
			model: reasoning({ provider: "xai", baseUrl: "https://api.x.ai/v1" }),
			options: { reasoningEffort: "high", maxTokens: 1000 },
		},
		{
			...base,
			name: "moonshot",
			description: "Moonshot: max_tokens and no reasoning effort.",
			model: reasoning({ provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" }),
			options: { reasoningEffort: "high", maxTokens: 1000 },
		},
		{
			...base,
			name: "cloudflare-gateway",
			description: "Cloudflare AI Gateway: no long retention.",
			model: model({
				provider: "cloudflare-ai-gateway",
				baseUrl: "https://gateway.ai.cloudflare.com/v1/x/y/openai",
			}),
			options: { cacheRetention: "long", sessionId: "session-1", maxTokens: 500 },
		},
		{
			...base,
			name: "vercel-gateway",
			description: "Vercel AI Gateway routing.",
			model: model({ compat: { vercelGatewayRouting: { only: ["anthropic"], order: ["anthropic", "bedrock"] } } }),
		},
		{
			...base,
			name: "compat-overrides",
			description: "No tools, no usage in streaming, max_tokens, vLLM priority.",
			model: model({
				compat: {
					supportsTools: false,
					supportsUsageInStreaming: false,
					maxTokensField: "max_tokens",
					vllmPriority: 5,
				},
			}),
			options: { maxTokens: 300 },
		},
		{
			...base,
			name: "edge",
			description: "Reasoning replay, tool call ids, tool result images.",
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "edge-openai",
			description: "The edge transcript on OpenAI: tool call ids cut to 40 characters.",
			model: openai({ reasoning: true }),
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "edge-strict-providers",
			description: "Thinking as text, a bridge after tool results, tool result names.",
			model: reasoning({
				input: ["text"],
				compat: {
					requiresThinkingAsText: true,
					requiresAssistantAfterToolResult: true,
					requiresToolResultName: true,
				},
			}),
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "edge-opencode-go",
			description: "opencode-go replays reasoning signatures as reasoning_content.",
			model: model({ provider: "opencode-go" }),
			messages: EDGE_TRANSCRIPT.map((message) =>
				message.role === "assistant" && message.provider === "custom"
					? { ...message, provider: "opencode-go" }
					: message,
			) as Message[],
		},
		{
			...base,
			name: "tool-additions",
			description: "Tools added later load in place as a system message.",
			model: model({ compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true } }),
			messages: ADDITIONS_TRANSCRIPT,
		},
		{
			...base,
			name: "tool-additions-folded",
			description: "Without tool additions, the request carries the current tool list.",
			messages: ADDITIONS_TRANSCRIPT,
		},
		{
			...base,
			name: "strict-mode",
			description: "Strict tools where the model supports them.",
			model: model({ compat: { supportsStrictMode: true } }),
			messages: ADDITIONS_TRANSCRIPT,
		},
		{
			...base,
			name: "grammar-tools",
			description: "A grammar tool and its call as custom tools.",
			model: model({ compat: { supportsOpenAIGrammarTools: true } }),
			messages: GRAMMAR_TRANSCRIPT,
		},
		{
			...base,
			name: "tool-history",
			description: "Tool calls in the history without declared tools send an empty tool list.",
			messages: TOOL_HISTORY_TRANSCRIPT,
		},
		{
			...base,
			name: "sampling-params",
			description: "Sampling parameters merged last.",
			model: reasoning({
				samplingParams: { top_p: 0.9, temperature: 1 },
				samplingParamsByThinkingLevel: { low: { top_k: 40 } },
			}),
			options: { reasoningEffort: "low", samplingParams: { min_p: 0.05 }, temperature: 0.2 },
		},
	];
}

export async function completionsBody(testCase: CompletionsCase): Promise<unknown> {
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

export async function completionsJson(testCase: CompletionsCase): Promise<string> {
	const { name, description, model: caseModel, apiKey, options, messages } = testCase;
	const fixture = {
		name,
		description,
		model: caseModel,
		apiKey,
		options,
		messages,
		body: await completionsBody(testCase),
	};
	return `${JSON.stringify(fixture, null, "\t")}\n`;
}

export function readCompletionsCase(name: string): string {
	return readFileSync(join(OPENAI_COMPLETIONS_DIR, `${name}.json`), "utf8");
}
