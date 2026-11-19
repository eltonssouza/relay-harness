/**
 * Reference Google Gemini stream decoding, for the Rust decoder to match.
 *
 * Each case answers the real `stream()` of `google-generative-ai.ts` with a scripted
 * server-sent event body through a stand-in `globalThis.fetch` (the adapter rejects a custom
 * `options.fetch`), so the `@google/genai` SDK parses it as it would Google's. The body is split
 * into byte chunks at the given offsets. Events are recorded without their live `partial`
 * snapshot. Times become 0, and tool call ids the adapter generates
 * (`<name>_<Date.now()>_<counter>`) become `<name>_0_<n>`, numbered per case.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stream } from "../../src/api/google-generative-ai.ts";
import type { Message, Model, Tool, TranscriptContext } from "../../src/types.ts";
import { bodyChunks, byteOffset, everyBytes, zeroTimes } from "./stream-helpers.ts";

export const GOOGLE_STREAM_DIR = fileURLToPath(new URL("../../../../crates/fixtures/google-stream/", import.meta.url));

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
	{ role: "user", content: "Go.", timestamp: 0 },
];

/** One SSE event with a response chunk. */
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

function response(parts: unknown[], extra: Record<string, unknown> = {}, finishReason?: string) {
	return data({
		candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}), index: 0 }],
		modelVersion: "gemini-2.5-flash",
		responseId: "resp-1",
		...extra,
	});
}

const usage = (prompt: number, candidates: number, extra: Record<string, unknown> = {}) => ({
	usageMetadata: {
		promptTokenCount: prompt,
		candidatesTokenCount: candidates,
		totalTokenCount: prompt + candidates,
		...extra,
	},
});

export interface GoogleStreamCase {
	name: string;
	description: string;
	model: GoogleModel;
	messages: Message[];
	sse: string;
	splits: number[];
}

export function googleStreamCases(): GoogleStreamCase[] {
	const base = { model: model(), messages: MESSAGES, splits: [] as number[] };
	const full =
		response([{ text: "Planning the read.", thought: true, thoughtSignature: "c2lnLTE=" }]) +
		response([{ text: " More.", thought: true }]) +
		response([{ text: "Reading " }]) +
		response([{ text: "a.ts.", thoughtSignature: "dGV4dC1zaWc=" }]) +
		response(
			[{ functionCall: { name: "read", args: { path: "a.ts" }, id: "call-1" }, thoughtSignature: "Y2FsbC1zaWc=" }],
			usage(1200, 40, { cachedContentTokenCount: 800, thoughtsTokenCount: 30, totalTokenCount: 1270 }),
			"STOP",
		);
	return [
		{
			...base,
			name: "text",
			description: "A plain answer with usage.",
			sse: response([{ text: "Hello" }]) + response([{ text: ", world." }], usage(20, 5), "STOP"),
		},
		{
			...base,
			name: "thinking-text-and-tool",
			description: "Thinking with a signature, text with one, a tool call; cached and thought tokens.",
			sse: full,
		},
		{
			...base,
			name: "thinking-text-and-tool-chunked",
			description: "The same stream in 9-byte chunks.",
			sse: full,
			splits: everyBytes(full, 9),
		},
		{
			...base,
			name: "generated-ids",
			description: "Tool calls without ids, or with a repeated one, get generated ids.",
			sse: response(
				[
					{ functionCall: { name: "read", args: { path: "a" } } },
					{ functionCall: { name: "read", args: { path: "b" }, id: "dup" } },
					{ functionCall: { name: "read", args: { path: "c" }, id: "dup" } },
					{ functionCall: { args: {} } },
				],
				{},
				"STOP",
			),
		},
		{
			...base,
			name: "alternating-parts",
			description: "Text and thinking parts alternate within one chunk.",
			sse: response(
				[{ text: "A" }, { text: "think", thought: true }, { text: "B" }, { text: "", thought: true }],
				{},
				"STOP",
			),
		},
		{
			...base,
			name: "max-tokens",
			description: "The answer hits the output limit.",
			sse: response([{ text: "Long" }], {}, "MAX_TOKENS"),
		},
		{
			...base,
			name: "safety",
			description: "A safety stop is an error.",
			sse: response([{ text: "Part" }], {}, "SAFETY"),
		},
		{
			...base,
			name: "malformed-call",
			description: "A malformed function call stop is an error.",
			sse: response([], {}, "MALFORMED_FUNCTION_CALL"),
		},
		{
			...base,
			name: "unknown-finish",
			description: "An unknown finish reason.",
			sse: response([{ text: "?" }], {}, "SOMETHING_NEW"),
		},
		{
			...base,
			name: "no-finish-reason",
			description: "A stream without a finish reason.",
			sse: response([{ text: "Hm" }]),
		},
		{
			...base,
			name: "no-candidates",
			description: "Chunks without candidates or parts; usage-only last chunk.",
			sse:
				data({ modelVersion: "gemini-2.5-flash" }) +
				data({ candidates: [{ index: 0 }] }) +
				response([{ text: "Ok" }], {}, "STOP") +
				data({ ...usage(10, 2), responseId: "resp-2" }),
		},
		{
			...base,
			name: "api-error-chunk",
			description: "A network chunk that is a JSON error with an HTTP code.",
			sse: `${response([{ text: "Part" }])}{"error": {"code": 429, "message": "Quota.", "status": "RESOURCE_EXHAUSTED"}}`,
			splits: [],
		},
		{
			...base,
			name: "incomplete-segment",
			description: "Text after the last event is an error.",
			sse: `${response([{ text: "Ok" }], {}, "STOP")}data: {"partial"`,
		},
		{
			...base,
			name: "framing",
			description: "CR and CRLF delimiters, an event without data, extra spaces, a split multi-byte character.",
			sse: [
				": keep-alive\r\r",
				`data:${JSON.stringify({ candidates: [{ content: { parts: [{ text: "caf\u00e9 " }] }, index: 0 }] })}\r\n\r\n`,
				"event: ping\n\n",
				`data:   ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "🙈" }] }, finishReason: "STOP", index: 0 }] })}   \n\n`,
			].join(""),
			splits: [],
		},
	].map((testCase) => {
		if (testCase.name === "api-error-chunk") {
			return { ...testCase, splits: [byteOffset(testCase.sse, '{"error"')] };
		}
		if (testCase.name === "framing") {
			return {
				...testCase,
				splits: [
					byteOffset(testCase.sse, "\u00e9") + 1,
					byteOffset(testCase.sse, "🙈") + 2,
					byteOffset(testCase.sse, "\r\r") + 1,
				],
			};
		}
		return testCase;
	});
}

/** Generated tool call ids, numbered by first appearance. */
function normalizeGeneratedIds(text: string): string {
	const numbers = new Map<string, number>();
	return text.replace(/"([^"\\]*)_(\d{13})_(\d+)"/g, (match, name: string) => {
		if (!numbers.has(match)) numbers.set(match, numbers.size + 1);
		return `"${name}_0_${numbers.get(match)}"`;
	});
}

export async function decodeGoogle(testCase: GoogleStreamCase): Promise<{ events: unknown[] }> {
	const chunks = bodyChunks(testCase.sse, testCase.splits);
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		)) as typeof globalThis.fetch;
	const events: unknown[] = [];
	try {
		const output = stream(testCase.model, { messages: testCase.messages } as TranscriptContext, {
			apiKey: "google-parity-key",
		});
		for await (const event of output) {
			const { partial: _partial, ...rest } = event as { partial?: unknown };
			events.push(rest);
		}
	} finally {
		globalThis.fetch = original;
	}
	const normalized = normalizeGeneratedIds(JSON.stringify({ events }));
	return zeroTimes(JSON.parse(normalized)) as { events: unknown[] };
}

export async function googleStreamJson(testCase: GoogleStreamCase): Promise<string> {
	const { name, description, model: caseModel, messages, sse: body, splits } = testCase;
	const fixture = {
		name,
		description,
		model: caseModel,
		messages,
		sse: body,
		splits,
		...(await decodeGoogle(testCase)),
	};
	return `${JSON.stringify(fixture, null, "\t")}\n`;
}

export function readGoogleStreamCase(name: string): string {
	return readFileSync(join(GOOGLE_STREAM_DIR, `${name}.json`), "utf8");
}
