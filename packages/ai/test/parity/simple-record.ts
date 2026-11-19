/**
 * Reference results of each adapter's `streamSimple`, for the Rust port to match: the
 * provider-neutral options (a reasoning level, thinking budgets, an output limit) turned into the
 * adapter's own, then into the request. Each case captures what the adapter sends in
 * `onPayload` (for Google, the SDK parameters), which throws before any request is made.
 * The output limit is clamped to the context window with the context estimate, so some cases
 * use a small window and assistant usage.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { streamSimple as anthropicSimple } from "../../src/api/anthropic-messages.ts";
import { streamSimple as googleSimple } from "../../src/api/google-generative-ai.ts";
import { streamSimple as completionsSimple } from "../../src/api/openai-completions.ts";
import { streamSimple as responsesSimple } from "../../src/api/openai-responses.ts";
import type { Api, Message, Model, SimpleStreamOptions, TranscriptContext } from "../../src/types.ts";

export const SIMPLE_DIR = fileURLToPath(new URL("../../../../crates/fixtures/simple/", import.meta.url));
const SCENARIOS_DIR = fileURLToPath(new URL("../../../../crates/fixtures/scenarios/", import.meta.url));

type Adapter = "anthropic" | "responses" | "completions" | "google";

const API: Record<Adapter, Api> = {
	anthropic: "anthropic-messages",
	responses: "openai-responses",
	completions: "openai-completions",
	google: "google-generative-ai",
};

function model(adapter: Adapter, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-model",
		name: "Test",
		api: API[adapter],
		provider: adapter === "google" ? "google" : adapter === "anthropic" ? "anthropic" : "openai",
		baseUrl: adapter === "google" ? "https://generativelanguage.googleapis.com/v1beta" : "http://127.0.0.1:9/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200000,
		maxTokens: 64000,
		...overrides,
	};
}

function scenarioRequest(name: string, index: number): Message[] {
	const recording = JSON.parse(readFileSync(join(SCENARIOS_DIR, `${name}.json`), "utf8")) as {
		requests: Message[][];
	};
	return recording.requests[index]!;
}

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** A conversation whose last valid assistant usage replaces the estimate of what came before. */
const USAGE_TRANSCRIPT: Message[] = [
	{ role: "system", content: "Prompt.", timestamp: 1 },
	{ role: "user", content: "x".repeat(4000), timestamp: 2 },
	{
		role: "assistant",
		content: [{ type: "text", text: "Answer." }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 9000,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 9500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 3,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "Failed." }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 99999,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: 4,
	},
	{
		role: "user",
		content: [
			{ type: "text", text: "Look at this café 🙈." },
			{ type: "image", data: IMAGE, mimeType: "image/png" },
		],
		timestamp: 5,
	},
];

export interface SimpleCase {
	name: string;
	description: string;
	adapter: Adapter;
	model: Model<Api>;
	options: SimpleStreamOptions;
	messages: Message[];
}

export function simpleCases(): SimpleCase[] {
	const readFile = scenarioRequest("read-file", 1);
	const make = (
		name: string,
		description: string,
		adapter: Adapter,
		options: SimpleStreamOptions,
		overrides: Partial<Model<Api>> = {},
		messages: Message[] = readFile,
	): SimpleCase => ({ name, description, adapter, model: model(adapter, overrides), options, messages });
	return [
		make("anthropic-no-reasoning", "No level turns thinking off; a tool choice.", "anthropic", {
			toolChoice: "none",
		}),
		make("anthropic-budget", "A level on a budget model: the budget fits under the output limit.", "anthropic", {
			reasoning: "medium",
		}),
		make("anthropic-budget-capped", "A requested output limit grows by the budget.", "anthropic", {
			reasoning: "high",
			maxTokens: 4000,
		}),
		make("anthropic-custom-budget", "Custom budgets and a small output limit.", "anthropic", {
			reasoning: "low",
			maxTokens: 500,
			thinkingBudgets: { low: 900 },
		}),
		make(
			"anthropic-adaptive",
			"Adaptive thinking maps the level to an effort.",
			"anthropic",
			{ reasoning: "minimal" },
			{ compat: { forceAdaptiveThinking: true } },
		),
		make(
			"anthropic-adaptive-mapped",
			"A mapped effort.",
			"anthropic",
			{ reasoning: "xhigh" },
			{ compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { xhigh: "max" } },
		),
		make(
			"anthropic-small-window",
			"The output limit is cut to what the context window leaves.",
			"anthropic",
			{ reasoning: "medium" },
			{ contextWindow: 12000 },
		),
		make("responses-level", "A level becomes the reasoning effort; cache options pass through.", "responses", {
			reasoning: "high",
			cacheRetention: "long",
			sessionId: "session-1",
		}),
		make(
			"responses-clamped",
			"A level the model lacks clamps to the nearest one.",
			"responses",
			{ reasoning: "xhigh" },
			{ thinkingLevelMap: { minimal: null } },
		),
		make(
			"responses-not-reasoning",
			"A level on a model without reasoning is off.",
			"responses",
			{ reasoning: "high" },
			{
				reasoning: false,
			},
		),
		make(
			"responses-sampling",
			"Sampling parameters merge in the base options and again in the body.",
			"responses",
			{ reasoning: "low", samplingParams: { top_p: 0.5 }, temperature: 0.4, maxTokens: 1000 },
			{ samplingParams: { top_k: 10 }, samplingParamsByThinkingLevel: { low: { min_p: 0.2 }, off: { min_p: 0.9 } } },
		),
		make(
			"responses-usage-window",
			"The estimate starts from the last valid assistant usage.",
			"responses",
			{},
			{ contextWindow: 16000, reasoning: false },
			USAGE_TRANSCRIPT,
		),
		make(
			"completions-max",
			"A max level through the model's map, with budgets and a budget field.",
			"completions",
			{ reasoning: "max", thinkingBudgets: { high: 5000 }, maxTokens: 12000 },
			{ thinkingLevelMap: { max: "max" }, compat: { thinkingTokenBudgetField: "thinking_budget" } },
		),
		make("completions-off", "No level.", "completions", { maxTokens: 300, temperature: 0, toolChoice: "auto" }),
		make(
			"completions-usage-window",
			"The estimate from usage, on a tiny window.",
			"completions",
			{ reasoning: "medium" },
			{ contextWindow: 10000 },
			USAGE_TRANSCRIPT,
		),
		make(
			"completions-no-window",
			"A model without a context window keeps the requested limit.",
			"completions",
			{ maxTokens: 70000 },
			{ contextWindow: 0 },
		),
		make(
			"google-no-reasoning",
			"No level turns thinking off; a tool choice.",
			"google",
			{ toolChoice: "none" },
			{
				id: "gemini-2.5-flash",
			},
		),
		make(
			"google-level",
			"Gemini 3 takes the level.",
			"google",
			{ reasoning: "medium" },
			{ id: "gemini-3-pro-preview" },
		),
		make(
			"google-level-mapped",
			"A mapped level.",
			"google",
			{ reasoning: "high" },
			{ id: "gemini-3-flash-preview", thinkingLevelMap: { high: "Low" } },
		),
		make(
			"google-budget-pro",
			"Gemini 2.5 Pro's budgets.",
			"google",
			{ reasoning: "minimal" },
			{ id: "gemini-2.5-pro" },
		),
		make(
			"google-budget-flash-lite",
			"Gemini 2.5 Flash Lite's budgets.",
			"google",
			{ reasoning: "high" },
			{
				id: "gemini-2.5-flash-lite",
			},
		),
		make(
			"google-budget-flash",
			"Gemini 2.5 Flash's budgets.",
			"google",
			{ reasoning: "high" },
			{ id: "gemini-2.5-flash" },
		),
		make(
			"google-budget-custom",
			"Custom budgets win.",
			"google",
			{ reasoning: "low", thinkingBudgets: { low: 777 } },
			{
				id: "gemini-2.5-pro",
			},
		),
		make(
			"google-budget-dynamic",
			"Other models think dynamically.",
			"google",
			{ reasoning: "low" },
			{
				id: "gemma-3-27b-it",
			},
		),
		make(
			"google-off",
			"A level clamped to off.",
			"google",
			{ reasoning: "high" },
			{ id: "gemini-2.5-flash", reasoning: false },
		),
	];
}

const SIMPLE: Record<
	Adapter,
	(
		model: Model<Api>,
		context: TranscriptContext,
		options: SimpleStreamOptions,
	) => {
		result(): Promise<{ errorMessage?: string }>;
	}
> = {
	anthropic: anthropicSimple as never,
	responses: responsesSimple as never,
	completions: completionsSimple as never,
	google: googleSimple as never,
};

export async function simpleBody(testCase: SimpleCase): Promise<unknown> {
	const saved = process.env.RELAY_CACHE_RETENTION;
	delete process.env.RELAY_CACHE_RETENTION;
	let body: unknown;
	try {
		const events = SIMPLE[testCase.adapter](testCase.model, { messages: testCase.messages } as TranscriptContext, {
			...testCase.options,
			apiKey: testCase.adapter === "anthropic" ? "sk-ant-api03-parity" : "sk-parity",
			onPayload: (payload) => {
				body = payload;
				throw new Error("body recorded");
			},
		});
		const message = await events.result();
		if (body === undefined) throw new Error(`${testCase.name}: no body: ${message.errorMessage}`);
	} finally {
		if (saved !== undefined) process.env.RELAY_CACHE_RETENTION = saved;
	}
	return JSON.parse(JSON.stringify(body));
}

export async function simpleJson(testCase: SimpleCase): Promise<string> {
	const { name, description, adapter, model: caseModel, options, messages } = testCase;
	const fixture = {
		name,
		description,
		adapter,
		model: caseModel,
		options,
		messages,
		body: await simpleBody(testCase),
	};
	return `${JSON.stringify(fixture, null, "\t")}\n`;
}

export function readSimpleCase(name: string): string {
	return readFileSync(join(SIMPLE_DIR, `${name}.json`), "utf8");
}
