/**
 * Reference Anthropic Messages request bodies, for the Rust adapter to match byte for byte.
 *
 * Each case runs the real `stream()` of `anthropic-messages.ts` with a model, options and a
 * transcript, and captures the body in `onPayload`, which throws before any request is sent. The
 * transcripts are the agent's own request from the read-file scenario (`crates/fixtures/scenarios/`)
 * and two written here to reach the conversion's branches. The files live in
 * `crates/fixtures/anthropic/`; `anthropic.test.ts` fails when they no longer match the TypeScript
 * code, so a change to the adapter regenerates them:
 *
 *   npm run parity:record
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AnthropicOptions, stream } from "../../src/api/anthropic-messages.ts";
import type { Message, Model, Tool, TranscriptContext } from "../../src/types.ts";

export const ANTHROPIC_DIR = fileURLToPath(new URL("../../../../crates/fixtures/anthropic/", import.meta.url));
const SCENARIOS_DIR = fileURLToPath(new URL("../../../../crates/fixtures/scenarios/", import.meta.url));

const API_KEY = "sk-ant-api03-parity";
const OAUTH_TOKEN = "sk-ant-oat01-parity";

/** Environment variables the adapter reads; recording runs without them so only `options.env` counts. */
const ADAPTER_ENV = [
	"RELAY_CACHE_RETENTION",
	"ANTHROPIC_FEDERATION_RULE_ID",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_ORGANIZATION_ID",
	"ANTHROPIC_SERVICE_ACCOUNT_ID",
	"ANTHROPIC_WORKSPACE_ID",
];

function model(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
		...overrides,
	};
}

const reasoningModel = (compat?: Model<"anthropic-messages">["compat"]) =>
	model({ id: "claude-thinking", reasoning: true, ...(compat ? { compat } : {}) });

const readTool: Tool = {
	name: "read",
	description: "Read a file.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path" },
			offset: { type: "number" },
			limit: { type: "number" },
		},
		required: ["path"],
	} as unknown as Tool["parameters"],
};

const notesTool: Tool = {
	name: "notes",
	description: "Keep a note.",
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	} as unknown as Tool["parameters"],
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};

const writeTool: Tool = {
	name: "write",
	description: "Write a file.",
	parameters: {
		type: "object",
		properties: { path: { type: "string" }, content: { type: "string" } },
		required: ["path", "content"],
	} as unknown as Tool["parameters"],
};

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Reaches the conversion's branches: blocks that are dropped, kept, converted or moved. */
const EDGE_TRANSCRIPT: Message[] = [
	{
		role: "system",
		content: "Base prompt.",
		sections: { intro: "<intro>Hello</intro>", rules: "<rules>Be brief.</rules>" },
		toolsAdded: [readTool, notesTool],
		timestamp: 0,
	},
	{ role: "user", content: "   ", timestamp: 0 },
	{
		role: "user",
		content: [
			{ type: "text", text: "Look at this." },
			{ type: "image", data: IMAGE, mimeType: "image/png" },
			{ type: "text", text: "  " },
			{ type: "text", text: "<harness>state</harness>", volatile: true },
		],
		timestamp: 0,
	},
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Plan the read.", thinkingSignature: "sig-1" },
			{ type: "thinking", thinking: "" },
			{ type: "thinking", thinking: "An unsigned thought." },
			{ type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
			{ type: "text", text: " " },
			{ type: "text", text: "Reading a.ts." },
			{ type: "toolCall", id: "call|weird|id", name: "read", arguments: { path: "a.ts" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		providerThinkingLevel: "medium",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	},
	{
		role: "toolResult",
		toolCallId: "call|weird|id",
		toolName: "read",
		content: [
			{ type: "text", text: "export const a = 1;" },
			{ type: "text", text: "<harness>after the read</harness>", volatile: true },
		],
		isError: false,
		timestamp: 0,
	},
	{
		role: "system",
		content: "Extra instructions.",
		sections: { rules: "<rules>Be thorough.</rules>", intro: null },
		toolsAdded: [writeTool],
		toolsRemoved: [{ name: "notes" }],
		timestamp: 0,
	},
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Another model's thinking.", thinkingSignature: "other" },
			{ type: "text", text: "From another model." },
			{
				type: "toolCall",
				id: "fc_123|abc+def==/🙈",
				name: "write",
				arguments: { path: "b.ts", content: "x" },
				thoughtSignature: "thought",
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "Partial answer" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage,
		stopReason: "error",
		errorMessage: "overloaded",
		timestamp: 0,
	},
	{ role: "user", content: "Continue 🙈", timestamp: 0 },
];

/** Tools for strict mode: one that converts, one with a keyword strict mode rejects, one plain. */
const STRICT_TRANSCRIPT: Message[] = [
	{
		role: "system",
		content: "Strict tools.",
		toolsAdded: [
			{
				name: "search",
				description: "Search.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string" },
						filters: {
							type: "object",
							properties: { kind: { type: "string", enum: ["a", "b"] }, tag: { type: "string" } },
							required: ["kind"],
						},
						tags: { type: "array", items: { type: "string" } },
					},
					required: ["query"],
				} as unknown as Tool["parameters"],
				constrainedSampling: { type: "json_schema", strict: "prefer" },
			},
			{
				name: "page",
				description: "Page through results.",
				parameters: {
					type: "object",
					properties: { page: { type: "number", minimum: 1 } },
					required: ["page"],
				} as unknown as Tool["parameters"],
				constrainedSampling: { type: "json_schema", strict: "prefer" },
			},
			readTool,
		],
		timestamp: 0,
	},
	{ role: "user", content: "Find a.", timestamp: 0 },
];

function scenarioRequest(name: string, index: number): Message[] {
	const recording = JSON.parse(readFileSync(join(SCENARIOS_DIR, `${name}.json`), "utf8")) as {
		requests: Message[][];
	};
	return recording.requests[index]!;
}

export interface AnthropicCase {
	name: string;
	description: string;
	model: Model<"anthropic-messages">;
	apiKey: string;
	options: AnthropicOptions;
	messages: Message[];
}

export function anthropicCases(): AnthropicCase[] {
	const readFile = scenarioRequest("read-file", 1);
	const base = { apiKey: API_KEY, options: {}, messages: readFile, model: model() };
	return [
		{ ...base, name: "api-key", description: "An API key and the read-file conversation." },
		{
			...base,
			name: "oauth",
			description: "An OAuth token: the Claude Code identity and tool names.",
			apiKey: OAUTH_TOKEN,
		},
		{
			...base,
			name: "thinking-budget",
			description: "Budget thinking with the interleaved thinking beta.",
			model: reasoningModel(),
			options: { thinkingEnabled: true, thinkingBudgetTokens: 2048, maxTokens: 8000 },
		},
		{
			...base,
			name: "thinking-adaptive",
			description: "Adaptive thinking with an effort and omitted display.",
			model: reasoningModel({ forceAdaptiveThinking: true }),
			options: { thinkingEnabled: true, effort: "medium", thinkingDisplay: "omitted" },
		},
		{
			...base,
			name: "thinking-disabled",
			description: "Thinking turned off on a reasoning model.",
			model: reasoningModel(),
			options: { thinkingEnabled: false },
		},
		{
			...base,
			name: "thinking-off-unsupported",
			description: "A model whose thinking cannot be turned off sends no thinking field.",
			model: { ...reasoningModel(), thinkingLevelMap: { off: null } },
			options: { thinkingEnabled: false },
		},
		{ ...base, name: "cache-long", description: "Long cache retention.", options: { cacheRetention: "long" } },
		{ ...base, name: "cache-none", description: "No cache markers.", options: { cacheRetention: "none" } },
		{
			...base,
			name: "cache-long-unsupported",
			description: "Long retention on a model without it falls back to the default TTL.",
			model: model({ compat: { supportsLongCacheRetention: false } }),
			options: { cacheRetention: "long" },
		},
		{
			...base,
			name: "cache-long-from-env",
			description: "RELAY_CACHE_RETENTION=long in the provider environment.",
			options: { env: { RELAY_CACHE_RETENTION: "long" } },
		},
		{
			...base,
			name: "request-options",
			description: "Temperature, tool choice, metadata and a configured beta header.",
			options: {
				temperature: 0.3,
				toolChoice: { type: "tool", name: "read" },
				metadata: { user_id: "user-1", ignored: 1 },
				headers: { "anthropic-beta": "beta-b, beta-a,beta-b" },
			},
		},
		{
			...base,
			name: "beta-header-null",
			description: "A null beta header removes every beta.",
			options: { headers: { "anthropic-beta": null }, toolChoice: "any" },
		},
		{
			...base,
			name: "fallbacks",
			description: "Server-side fallback models.",
			model: model({
				compat: { allowedFallbackModels: [{ model: "claude-fallback" } as never] },
			}),
		},
		{
			...base,
			name: "no-tool-cache",
			description: "No cache marker on tools and no eager input streaming.",
			model: model({ compat: { supportsCacheControlOnTools: false, supportsEagerToolInputStreaming: false } }),
		},
		{
			...base,
			name: "edge",
			description: "Blocks that are dropped, kept, converted or moved.",
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "edge-oauth",
			description: "The edge transcript with an OAuth token.",
			apiKey: OAUTH_TOKEN,
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
			name: "edge-empty-signature",
			description: "Unsigned thinking replayed with an empty signature.",
			model: model({ compat: { allowEmptySignature: true } }),
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "edge-managed-effort",
			description: "Managed effort: system messages carry each response's effort.",
			model: reasoningModel({ supportsMidConvoEffort: true }),
			options: { effort: "low", thinkingEnabled: true, temperature: 0.5 },
			messages: EDGE_TRANSCRIPT.map((message) =>
				message.role === "assistant" && message.provider === "anthropic"
					? { ...message, model: "claude-thinking" }
					: message,
			),
		},
		{
			...base,
			name: "edge-mid-system",
			description: "System messages in place, tool changes folded into the tool list.",
			model: model({ compat: { supportsMidConvoSystemMessages: true } }),
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "edge-native-tools",
			description: "System messages in place with tool_addition and tool_removal blocks.",
			model: model({ compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } }),
			messages: EDGE_TRANSCRIPT,
		},
		{
			...base,
			name: "strict-tools",
			description: "Strict tool schemas where the model supports them.",
			model: model({ compat: { supportsStrictTools: true } }),
			messages: STRICT_TRANSCRIPT,
		},
	];
}

/** The body the adapter would send for one case. */
export async function anthropicBody(testCase: AnthropicCase): Promise<unknown> {
	const saved = ADAPTER_ENV.map((name) => [name, process.env[name]] as const);
	for (const name of ADAPTER_ENV) delete process.env[name];
	let body: unknown;
	try {
		const events = stream(testCase.model, { messages: testCase.messages } as TranscriptContext, {
			...testCase.options,
			apiKey: testCase.apiKey,
			onPayload: (payload) => {
				body = payload;
				throw new Error("body recorded");
			},
		});
		await events.result();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
	if (body === undefined) throw new Error(`${testCase.name}: the adapter sent no body`);
	return body;
}

export async function anthropicJson(testCase: AnthropicCase): Promise<string> {
	const { name, description, model: caseModel, apiKey, options, messages } = testCase;
	const fixture = {
		name,
		description,
		model: caseModel,
		apiKey,
		options,
		messages,
		body: await anthropicBody(testCase),
	};
	return `${JSON.stringify(fixture, null, "\t")}\n`;
}

export function readAnthropicCase(name: string): string {
	return readFileSync(join(ANTHROPIC_DIR, `${name}.json`), "utf8");
}

if (process.argv.includes("--write")) {
	mkdirSync(ANTHROPIC_DIR, { recursive: true });
	const cases = anthropicCases();
	for (const testCase of cases) {
		writeFileSync(join(ANTHROPIC_DIR, `${testCase.name}.json`), await anthropicJson(testCase));
	}
	console.log(`wrote ${cases.length} Anthropic cases to ${ANTHROPIC_DIR}`);
}
