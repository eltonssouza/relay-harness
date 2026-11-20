/**
 * Reference Google Gemini requests, for the Rust adapter to match.
 *
 * Each case runs the real `stream()` of `google-generative-ai.ts` and records two things: the
 * parameters the adapter builds (`onPayload`, matched byte for byte), and the HTTP request the
 * `@google/genai` SDK makes from them, captured by a stand-in `globalThis.fetch` that throws
 * before anything is sent (the URL matched exactly; the body by content, since the SDK orders
 * keys by its own schema and Gemini reads JSON regardless of order).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GoogleOptions, stream } from "../../src/api/google-generative-ai.ts";
import type { Message, Model, Tool, TranscriptContext } from "../../src/types.ts";

export const GOOGLE_DIR = fileURLToPath(new URL("../../../../crates/fixtures/google/", import.meta.url));
const SCENARIOS_DIR = fileURLToPath(new URL("../../../../crates/fixtures/scenarios/", import.meta.url));

type GoogleModel = Model<"google-generative-ai">;

function model(overrides: Partial<GoogleModel> = {}): GoogleModel {
	return {
		id: "gemini-2.5-flash",
		name: "Gemini",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
		...overrides,
	};
}

const gemini3 = (overrides: Partial<GoogleModel> = {}) => model({ id: "gemini-3-pro-preview", ...overrides });

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
const strictTool = tool(
	"search",
	{ query: { type: "string" }, kind: { type: "string" } },
	{ constrainedSampling: { type: "json_schema", strict: "prefer" } },
);
const schemaTool: Tool = {
	name: "lookup",
	description: "Look up.",
	parameters: {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		type: "object",
		properties: { key: { anyOf: [{ type: "string" }, { type: "number" }] } },
		required: ["key"],
	} as unknown as Tool["parameters"],
};

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const SIGNATURE = "c2lnbmF0dXJlLTE=";

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
		api: from.api ?? "google-generative-ai",
		provider: from.provider ?? "google",
		model: from.model ?? "gemini-2.5-flash",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	} as Message;
}

const result = (toolCallId: string, toolName: string, content: unknown[], isError = false): Message =>
	({ role: "toolResult", toolCallId, toolName, content, isError, timestamp: 0 }) as Message;

/** Signatures, thinking across models, tool call ids, results with images and errors. */
function edgeTranscript(modelId: string): Message[] {
	return [
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
				{ type: "text", text: "Look." },
				{ type: "image", data: IMAGE, mimeType: "image/png" },
			],
			timestamp: 0,
		},
		{ role: "user", content: [], timestamp: 0 },
		assistant(
			[
				{ type: "thinking", thinking: "Signed thought.", thinkingSignature: SIGNATURE },
				{ type: "thinking", thinking: "Bad signature.", thinkingSignature: "not base64!" },
				{ type: "thinking", thinking: "", thinkingSignature: SIGNATURE },
				{ type: "thinking", thinking: "   " },
				{ type: "text", text: "", textSignature: SIGNATURE },
				{ type: "text", text: " " },
				{ type: "text", text: "Reading.", textSignature: "bad" },
				{
					type: "toolCall",
					id: "call|1+x",
					name: "read",
					arguments: { path: "a.ts" },
					thoughtSignature: SIGNATURE,
				},
				{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "b.ts" } },
			],
			{ model: modelId },
		),
		result("call|1+x", "read", [
			{ type: "text", text: "a" },
			{ type: "image", data: IMAGE, mimeType: "image/png" },
		]),
		result("call_2", "read", [{ type: "text", text: "missing" }], true),
		{ role: "system", content: "Later instructions.", timestamp: 0 },
		assistant(
			[
				{ type: "thinking", thinking: "Claude's thought.", thinkingSignature: "sig" },
				{ type: "text", text: "From Claude." },
				{ type: "toolCall", id: "toolu_01", name: "read", arguments: { path: "c.ts" } },
			],
			{ provider: "anthropic", api: "anthropic-messages", model: "claude-test" },
		),
		result("toolu_01", "read", [{ type: "image", data: IMAGE, mimeType: "image/png" }]),
		{ role: "user", content: "Continue.", timestamp: 0 },
	];
}

const STRICT_TRANSCRIPT: Message[] = [
	{ role: "system", content: "Search.", toolsAdded: [strictTool, schemaTool], timestamp: 0 },
	{ role: "user", content: "Find.", timestamp: 0 },
];

function scenarioRequest(name: string, index: number): Message[] {
	const recording = JSON.parse(readFileSync(join(SCENARIOS_DIR, `${name}.json`), "utf8")) as {
		requests: Message[][];
	};
	return recording.requests[index]!;
}

export interface GoogleCase {
	name: string;
	description: string;
	model: GoogleModel;
	options: GoogleOptions;
	messages: Message[];
}

export function googleCases(): GoogleCase[] {
	const base = { options: {} as GoogleOptions, messages: scenarioRequest("read-file", 1), model: model() };
	return [
		{ ...base, name: "basic", description: "Gemini 2.5 and the read-file conversation." },
		{
			...base,
			name: "request-options",
			description: "Temperature, output limit and a tool choice.",
			options: { temperature: 0.3, maxTokens: 2048, toolChoice: "any" },
		},
		{
			...base,
			name: "thinking-budget",
			description: "Budget thinking on Gemini 2.5.",
			options: { thinking: { enabled: true, budgetTokens: 4096 } },
		},
		{
			...base,
			name: "thinking-dynamic",
			description: "Dynamic thinking budget.",
			options: { thinking: { enabled: true, budgetTokens: -1 } },
		},
		{
			...base,
			name: "thinking-disabled",
			description: "Thinking off on Gemini 2.5 is a zero budget.",
			options: { thinking: { enabled: false } },
		},
		{
			...base,
			name: "thinking-level",
			description: "A thinking level on Gemini 3.",
			model: gemini3(),
			options: { thinking: { enabled: true, level: "HIGH" }, toolChoice: "none" },
		},
		{
			...base,
			name: "thinking-level-disabled",
			description: "Gemini 3 without an off level falls back to its lowest level.",
			model: gemini3({ thinkingLevelMap: { off: null, minimal: "low" } }),
			options: { thinking: { enabled: false } },
		},
		{
			...base,
			name: "thinking-level-off",
			description: "Gemini 3 that can turn thinking off sends a zero budget.",
			model: gemini3(),
			options: { thinking: { enabled: false } },
		},
		{
			...base,
			name: "not-reasoning",
			description: "Thinking options on a model without reasoning are ignored.",
			model: model({ reasoning: false }),
			options: { thinking: { enabled: true, budgetTokens: 1000 } },
		},
		{
			...base,
			name: "strict-tools",
			description: "A strict tool on Gemini 3 asks for validated function calling.",
			model: gemini3(),
			messages: STRICT_TRANSCRIPT,
		},
		{
			...base,
			name: "strict-tools-gemini-2",
			description: "The same tools on Gemini 2.5, without strict sampling.",
			messages: STRICT_TRANSCRIPT,
			options: { toolChoice: "auto" },
		},
		{
			...base,
			name: "edge-gemini-2",
			description: "Signatures, cross-model thinking, results and images on Gemini 2.5.",
			messages: edgeTranscript("gemini-2.5-flash"),
		},
		{
			...base,
			name: "edge-gemini-3",
			description: "The edge transcript on Gemini 3: tool call ids and images inside function responses.",
			model: gemini3(),
			messages: edgeTranscript("gemini-3-pro-preview"),
		},
		{
			...base,
			name: "edge-no-vision",
			description: "A text-only model drops tool result images.",
			model: model({ input: ["text"] }),
			messages: edgeTranscript("gemini-2.5-flash"),
		},
		{
			...base,
			name: "edge-claude",
			description: "A Claude model behind a Google API: ids and multimodal results.",
			model: model({ id: "claude-test-via-google" }),
			messages: edgeTranscript("claude-test-via-google"),
		},
		{
			...base,
			name: "custom-base-url",
			description: "A custom base URL is the API root.",
			model: model({ baseUrl: "https://proxy.example/gemini/v1" }),
		},
	];
}

export interface GoogleRecording {
	params: unknown;
	request: { url: string; body: unknown };
}

export async function googleRequest(testCase: GoogleCase): Promise<GoogleRecording> {
	let params: unknown;
	let request: GoogleRecording["request"] | undefined;
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
		request = { url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
		throw new Error("request recorded");
	}) as typeof globalThis.fetch;
	try {
		const events = stream(testCase.model, { messages: testCase.messages } as TranscriptContext, {
			...testCase.options,
			apiKey: "google-parity-key",
			onPayload: (payload) => {
				params = payload;
			},
		});
		const message = await events.result();
		if (params === undefined || request === undefined) {
			throw new Error(`${testCase.name}: no request: ${message.errorMessage}`);
		}
	} finally {
		globalThis.fetch = original;
	}
	return { params: JSON.parse(JSON.stringify(params)), request };
}

export async function googleJson(testCase: GoogleCase): Promise<string> {
	const { name, description, model: caseModel, options, messages } = testCase;
	const fixture = { name, description, model: caseModel, options, messages, ...(await googleRequest(testCase)) };
	return `${JSON.stringify(fixture, null, "\t")}\n`;
}

export function readGoogleCase(name: string): string {
	return readFileSync(join(GOOGLE_DIR, `${name}.json`), "utf8");
}
