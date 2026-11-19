/**
 * Reference HTTP requests and HTTP error messages of each adapter's real `stream()`, for the Rust
 * port to match.
 *
 * Request cases capture what the SDK hands to `fetch` (a custom `options.fetch`, or a stand-in
 * `globalThis.fetch` for Google, whose adapter rejects a custom one): the method, the URL, the
 * headers and the body text. The SDKs' telemetry headers (`x-stainless-*`, Google's
 * `x-goog-api-client`) describe the JavaScript runtime, so they are listed under `omitted`
 * rather than recorded, and the platform part of Relay's user agent becomes `<os>`.
 *
 * Error cases answer the request with a scripted HTTP error (with the reason phrase an HTTP/1.1
 * server sends, unless the case gives its own), or fail the connection, and record the message the
 * adapter reports.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stream as anthropicStream } from "../../src/api/anthropic-messages.ts";
import { stream as googleStream } from "../../src/api/google-generative-ai.ts";
import { stream as completionsStream } from "../../src/api/openai-completions.ts";
import { stream as responsesStream } from "../../src/api/openai-responses.ts";
import type { Api, Message, Model, TranscriptContext } from "../../src/types.ts";

export const HTTP_DIR = fileURLToPath(new URL("../../../../crates/fixtures/http/", import.meta.url));

type Adapter = "anthropic" | "responses" | "completions" | "google";

const API: Record<Adapter, Api> = {
	anthropic: "anthropic-messages",
	responses: "openai-responses",
	completions: "openai-completions",
	google: "google-generative-ai",
};

const BASE_URL: Record<Adapter, string> = {
	anthropic: "https://api.anthropic.com",
	responses: "https://api.openai.com/v1",
	completions: "https://api.openai.com/v1",
	google: "https://generativelanguage.googleapis.com/v1beta",
};

const PROVIDER: Record<Adapter, string> = {
	anthropic: "anthropic",
	responses: "openai",
	completions: "openai",
	google: "google",
};

function model(adapter: Adapter, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: adapter === "google" ? "gemini-2.5-flash" : "test-model",
		name: "Test",
		api: API[adapter],
		provider: PROVIDER[adapter],
		baseUrl: BASE_URL[adapter],
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 1000,
		...overrides,
	};
}

const MESSAGES: Message[] = [
	{ role: "system", content: "Be brief.", timestamp: 0 },
	{ role: "user", content: "Go.", timestamp: 0 },
];

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const AGENT_TURN: Message[] = [
	...MESSAGES,
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } }],
		api: "openai-completions",
		provider: "github-copilot",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	},
	{
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "image", data: IMAGE, mimeType: "image/png" }],
		isError: false,
		timestamp: 0,
	},
];

/** A scripted answer: an HTTP error, or a failed connection. */
type Answer =
	| { status: number; statusText?: string; body: string; headers?: Record<string, string> }
	| "connection-failure";

export interface HttpCase {
	name: string;
	description: string;
	adapter: Adapter;
	model: Model<Api>;
	options: Record<string, unknown>;
	messages: Message[];
	/** Set for an error case. */
	answer?: Answer;
}

export function httpCases(): HttpCase[] {
	const make = (
		name: string,
		description: string,
		adapter: Adapter,
		options: Record<string, unknown>,
		overrides: Partial<Model<Api>> = {},
		extra: Partial<HttpCase> = {},
	): HttpCase => ({
		name,
		description,
		adapter,
		model: model(adapter, overrides),
		options,
		messages: MESSAGES,
		...extra,
	});
	const anthropicKey = { apiKey: "sk-ant-api03-parity" };
	const openaiKey = { apiKey: "sk-parity" };
	const googleKey = { apiKey: "google-parity-key" };
	const error = (answer: Answer) => ({
		answer:
			answer === "connection-failure" || answer.statusText !== undefined
				? answer
				: { ...answer, statusText: STATUS_TEXT[answer.status] ?? "" },
	});
	const jsonError = (status: number, error: unknown, headers: Record<string, string> = {}) =>
		error === undefined
			? ({ status, body: "" } as Answer)
			: ({
					status,
					body: JSON.stringify(error),
					headers: { "content-type": "application/json", ...headers },
				} as Answer);
	return [
		make("anthropic-api-key", "An API key, with a session.", "anthropic", {
			...anthropicKey,
			sessionId: "session-1",
		}),
		make("anthropic-oauth", "An OAuth token: the Claude Code identity.", "anthropic", {
			apiKey: "sk-ant-oat01-parity",
		}),
		make("anthropic-auth-header", "Auth in a header, as ANTHROPIC_AUTH_TOKEN gives it.", "anthropic", {
			headers: { Authorization: "Bearer token-1" },
		}),
		make(
			"anthropic-headers",
			"Model and request headers; a null removes one; a configured beta list.",
			"anthropic",
			{ ...anthropicKey, headers: { "x-request": "r", "x-model": "request wins", accept: null } },
			{ headers: { "x-model": "m", "anthropic-beta": "files-api-2025-04-14, files-api-2025-04-14,b2" } },
		),
		make(
			"anthropic-session-affinity",
			"Session affinity headers in the OpenRouter format.",
			"anthropic",
			{ ...anthropicKey, sessionId: "session-1" },
			{
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api",
				compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
			},
		),
		make(
			"anthropic-thinking-beta",
			"Interleaved thinking moves its beta into a header.",
			"anthropic",
			{ ...anthropicKey, thinkingEnabled: true, thinkingBudgetTokens: 1024 },
			{ reasoning: true },
		),
		make(
			"anthropic-copilot",
			"GitHub Copilot: a bearer token and its own headers.",
			"anthropic",
			{ apiKey: "copilot-token" },
			{ provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com" },
		),
		make("anthropic-base-path", "A base URL with a path and a trailing slash.", "anthropic", anthropicKey, {
			baseUrl: "https://proxy.example/anthropic/",
		}),
		make("responses-api-key", "An API key, with a session.", "responses", { ...openaiKey, sessionId: "session-1" }),
		make(
			"responses-headers",
			"Model and request headers.",
			"responses",
			{ ...openaiKey, headers: { "x-request": "r" } },
			{
				headers: { "x-model": "m" },
			},
		),
		make(
			"responses-copilot",
			"GitHub Copilot: an agent turn with an image.",
			"responses",
			{ apiKey: "copilot-token" },
			{ provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com" },
			{ messages: AGENT_TURN },
		),
		make("completions-api-key", "An API key.", "completions", openaiKey),
		make(
			"completions-openrouter",
			"OpenRouter session affinity.",
			"completions",
			{ ...openaiKey, sessionId: "session-1" },
			{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
		),
		make(
			"completions-copilot",
			"GitHub Copilot: a user turn.",
			"completions",
			{ apiKey: "copilot-token" },
			{ provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com" },
		),
		make(
			"completions-headers",
			"Model and request headers on a local server.",
			"completions",
			{ ...openaiKey, headers: { "x-request": "r", "x-model": "request wins" } },
			{ provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", headers: { "x-model": "m" } },
		),
		make("google-api-key", "An API key.", "google", googleKey),
		make(
			"google-headers",
			"Model and request headers, and a custom base URL.",
			"google",
			{
				...googleKey,
				headers: { "x-request": "r" },
			},
			{ baseUrl: "https://proxy.example/gemini/v1", headers: { "x-model": "m" } },
		),

		make(
			"anthropic-error-json",
			"An Anthropic error body.",
			"anthropic",
			anthropicKey,
			{},
			error(
				jsonError(400, {
					type: "error",
					error: { type: "invalid_request_error", message: "max_tokens: too large" },
					request_id: "req_1",
				}),
			),
		),
		make(
			"anthropic-error-rate-limit",
			"A rate limit.",
			"anthropic",
			anthropicKey,
			{},
			error(
				jsonError(429, {
					type: "error",
					error: { type: "rate_limit_error", message: "Slow down." },
				}),
			),
		),
		make(
			"anthropic-error-empty",
			"An error without a body.",
			"anthropic",
			anthropicKey,
			{},
			error(jsonError(500, undefined)),
		),
		make(
			"anthropic-error-html",
			"A proxy's HTML page.",
			"anthropic",
			anthropicKey,
			{},
			error({
				status: 502,
				body: "<html><body>Bad gateway</body></html>",
				headers: { "content-type": "text/html" },
			}),
		),
		make("anthropic-error-connection", "No connection.", "anthropic", anthropicKey, {}, error("connection-failure")),
		make(
			"anthropic-error-message-object",
			"A body whose message is an object.",
			"anthropic",
			anthropicKey,
			{},
			error(jsonError(400, { message: { reason: "nested" } })),
		),
		make(
			"responses-error-json",
			"An OpenAI error body.",
			"responses",
			openaiKey,
			{},
			error(
				jsonError(400, {
					error: { message: "Invalid input.", type: "invalid_request_error", param: "input", code: "bad" },
				}),
			),
		),
		make(
			"responses-error-rate-limit",
			"A rate limit.",
			"responses",
			openaiKey,
			{},
			error(
				jsonError(429, {
					error: { message: "Rate limit reached.", type: "requests", code: "rate_limit_exceeded" },
				}),
			),
		),
		make(
			"responses-error-empty",
			"An error without a body.",
			"responses",
			openaiKey,
			{},
			error(jsonError(503, undefined)),
		),
		make(
			"responses-error-text",
			"A plain-text body.",
			"responses",
			openaiKey,
			{},
			error({
				status: 403,
				body: "Forbidden by proxy",
				headers: { "content-type": "text/plain" },
			}),
		),
		make("responses-error-connection", "No connection.", "responses", openaiKey, {}, error("connection-failure")),
		make(
			"responses-error-subscription-limit",
			"The ChatGPT subscription limit points at the usage page.",
			"responses",
			openaiKey,
			{},
			error(
				jsonError(429, {
					error: { message: "Usage limit reached.", code: "subscription_sharing_usage_limit_exceeded" },
				}),
			),
		),
		make(
			"completions-error-json",
			"An OpenAI-compatible error body.",
			"completions",
			openaiKey,
			{},
			error(
				jsonError(401, {
					error: {
						message: "Incorrect API key provided.",
						type: "invalid_request_error",
						code: "invalid_api_key",
					},
				}),
			),
		),
		make(
			"completions-error-other-shape",
			"A server's own error shape.",
			"completions",
			openaiKey,
			{
				provider: "ollama",
				baseUrl: "http://127.0.0.1:11434/v1",
			},
			error(jsonError(404, { error: "model 'x' not found" })),
		),
		make(
			"completions-error-detail",
			"A detail field.",
			"completions",
			openaiKey,
			{},
			error(
				jsonError(422, {
					detail: [{ loc: ["body", "model"], msg: "field required" }],
				}),
			),
		),
		make(
			"completions-error-empty",
			"An error without a body.",
			"completions",
			openaiKey,
			{},
			error(jsonError(500, undefined)),
		),
		make("completions-error-connection", "No connection.", "completions", openaiKey, {}, error("connection-failure")),
		make(
			"completions-error-message-object",
			"An error whose message is an object.",
			"completions",
			openaiKey,
			{},
			error(jsonError(400, { error: { message: { text: "nested" }, code: 400 } })),
		),
		make(
			"completions-error-openrouter-raw",
			"OpenRouter's raw provider error is appended.",
			"completions",
			openaiKey,
			{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
			error(
				jsonError(400, {
					error: {
						message: "Provider returned error",
						code: 400,
						metadata: { raw: "upstream said no", provider_name: "X" },
					},
				}),
			),
		),
		make(
			"google-error-json",
			"A Google error body.",
			"google",
			googleKey,
			{},
			error(
				jsonError(400, {
					error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" },
				}),
			),
		),
		make(
			"google-error-rate-limit",
			"Quota exhausted.",
			"google",
			googleKey,
			{},
			error(
				jsonError(429, {
					error: { code: 429, message: "Quota exceeded.", status: "RESOURCE_EXHAUSTED" },
				}),
			),
		),
		make("google-error-empty", "An error without a body.", "google", googleKey, {}, error(jsonError(500, undefined))),
		make(
			"google-error-text",
			"A plain-text body.",
			"google",
			googleKey,
			{},
			error({
				status: 503,
				body: "upstream unavailable",
				headers: { "content-type": "text/plain" },
			}),
		),
		make("google-error-connection", "No connection.", "google", googleKey, {}, error("connection-failure")),
		make(
			"google-error-http2",
			"A text body over HTTP/2, which has no status text.",
			"google",
			googleKey,
			{},
			error({
				status: 503,
				statusText: "",
				body: "overloaded",
			}),
		),
	];
}

const STREAM = {
	anthropic: anthropicStream,
	responses: responsesStream,
	completions: completionsStream,
	google: googleStream,
};

const TELEMETRY = /^(x-stainless-|x-goog-api-client$)/;

/** The reason phrases HTTP/1.1 servers send; HTTP/2 has none (`statusText` is empty). */
const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	422: "Unprocessable Entity",
	429: "Too Many Requests",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable",
};

function normalizeHeaders(headers: Headers): { headers: Record<string, string>; omitted: string[] } {
	const kept: Record<string, string> = {};
	const omitted: string[] = [];
	for (const [name, value] of headers.entries()) {
		if (TELEMETRY.test(name)) omitted.push(name);
		else kept[name] = name === "user-agent" ? value.replace(/^relay \(.*\)$/, "relay (<os>)") : value;
	}
	return { headers: kept, omitted };
}

export async function recordHttp(testCase: HttpCase): Promise<unknown> {
	let request: unknown;
	const fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
		const headers = new Headers(init?.headers ?? (input as Request).headers);
		request = {
			method: init?.method ?? "GET",
			url,
			...normalizeHeaders(headers),
			body: typeof init?.body === "string" ? init.body : null,
		};
		const answer = testCase.answer;
		if (answer === undefined) throw new Error("request recorded");
		if (answer === "connection-failure") throw new TypeError("fetch failed");
		return new Response(answer.body, {
			status: answer.status,
			statusText: answer.statusText,
			headers: answer.headers,
		});
	}) as typeof globalThis.fetch;
	const original = globalThis.fetch;
	if (testCase.adapter === "google") globalThis.fetch = fetch;
	const savedRetention = process.env.RELAY_CACHE_RETENTION;
	delete process.env.RELAY_CACHE_RETENTION;
	try {
		const run = STREAM[testCase.adapter] as (
			model: Model<Api>,
			context: TranscriptContext,
			options: Record<string, unknown>,
		) => { result(): Promise<{ stopReason: string; errorMessage?: string }> };
		const message = await run(testCase.model, { messages: testCase.messages } as TranscriptContext, {
			...testCase.options,
			...(testCase.adapter === "google" ? {} : { fetch }),
		}).result();
		if (request === undefined) throw new Error(`${testCase.name}: no request: ${message.errorMessage}`);
		return testCase.answer === undefined
			? { request }
			: { stopReason: message.stopReason, errorMessage: message.errorMessage };
	} finally {
		globalThis.fetch = original;
		if (savedRetention !== undefined) process.env.RELAY_CACHE_RETENTION = savedRetention;
	}
}

export async function httpJson(testCase: HttpCase): Promise<string> {
	return `${JSON.stringify({ ...testCase, ...((await recordHttp(testCase)) as object) }, null, "\t")}\n`;
}

export function readHttpCase(name: string): string {
	return readFileSync(join(HTTP_DIR, `${name}.json`), "utf8");
}
