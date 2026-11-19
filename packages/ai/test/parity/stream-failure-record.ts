/**
 * Reference events of each adapter's real `stream()` when the request fails, for the Rust port to
 * match: an HTTP error before any event, an abort before the response, an abort while the body
 * streams, and a connection that drops mid-body.
 *
 * The body is the first half of the events of a recorded stream (`crates/fixtures/*-stream/`).
 * When the adapter has processed it and reads again, the request aborts and the read fails as
 * undici's does (`AbortError: This operation was aborted`), or the connection drops and it fails
 * with undici's `TypeError: terminated`. Events are recorded without
 * their live `partial` snapshot and with times as 0.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stream as anthropicStream } from "../../src/api/anthropic-messages.ts";
import { stream as googleStream } from "../../src/api/google-generative-ai.ts";
import { stream as completionsStream } from "../../src/api/openai-completions.ts";
import { stream as responsesStream } from "../../src/api/openai-responses.ts";
import type { Api, Message, Model, TranscriptContext } from "../../src/types.ts";
import { zeroTimes } from "./stream-helpers.ts";

export const STREAM_FAILURE_DIR = fileURLToPath(
	new URL("../../../../crates/fixtures/stream-failures/", import.meta.url),
);
const FIXTURES = fileURLToPath(new URL("../../../../crates/fixtures/", import.meta.url));

type Adapter = "anthropic" | "responses" | "completions" | "google";
type Failure = "http-error" | "abort-before-response" | "abort-mid-stream" | "connection-drop";

const SOURCE: Record<Adapter, string> = {
	anthropic: "anthropic-stream/text.json",
	responses: "openai-responses-stream/reasoning-text-and-tool.json",
	completions: "openai-completions-stream/text.json",
	google: "google-stream/text.json",
};

const API_KEY: Record<Adapter, string> = {
	anthropic: "sk-ant-api03-parity",
	responses: "sk-parity",
	completions: "sk-parity",
	google: "google-parity-key",
};

export interface StreamFailureCase {
	name: string;
	adapter: Adapter;
	failure: Failure;
	model: Model<Api>;
	messages: Message[];
	apiKey: string;
	/** What the server sends before the failure. */
	sse: string;
	/** The error answer of an `http-error` case. */
	answer?: { status: number; statusText: string; body: string; headers: Record<string, string> };
}

/** The first half of a recorded stream's events, each with its blank line. */
function firstHalf(sse: string): string {
	const events = sse.split(/(?<=\n\n)/);
	return events.slice(0, Math.ceil(events.length / 2)).join("");
}

export function streamFailureCases(): StreamFailureCase[] {
	const cases: StreamFailureCase[] = [];
	for (const adapter of Object.keys(SOURCE) as Adapter[]) {
		const source = JSON.parse(readFileSync(join(FIXTURES, SOURCE[adapter]), "utf8")) as {
			model: Model<Api>;
			messages: Message[];
			sse: string;
		};
		for (const failure of [
			"http-error",
			"abort-before-response",
			"abort-mid-stream",
			"connection-drop",
		] as Failure[]) {
			cases.push({
				name: `${adapter}-${failure}`,
				adapter,
				failure,
				model: source.model,
				messages: source.messages,
				apiKey: API_KEY[adapter],
				sse: failure === "http-error" || failure === "abort-before-response" ? "" : firstHalf(source.sse),
				...(failure === "http-error"
					? {
							answer: {
								status: 500,
								statusText: "Internal Server Error",
								body: JSON.stringify({ error: { message: "Server exploded.", type: "server_error" } }),
								headers: { "content-type": "application/json" },
							},
						}
					: {}),
			});
		}
	}
	return cases;
}

const STREAM = {
	anthropic: anthropicStream,
	responses: responsesStream,
	completions: completionsStream,
	google: googleStream,
};

const abortError = () => new DOMException("This operation was aborted", "AbortError");

/** Time for an adapter to process a chunk before the next read fails. */
const PROCESSING_MS = 100;

export async function recordFailure(testCase: StreamFailureCase): Promise<unknown[]> {
	const controller = new AbortController();
	const fetch = (async (_input: unknown, init?: RequestInit) => {
		const signal = init?.signal ?? undefined;
		if (signal?.aborted) throw abortError();
		const answer = testCase.answer;
		if (answer) {
			return new Response(answer.body, {
				status: answer.status,
				statusText: answer.statusText,
				headers: answer.headers,
			});
		}
		// The first read gets the data; the next one fails once the adapter has processed it: a
		// dropped connection, or an abort. (Erroring the stream while data is queued would
		// discard it.)
		let reads = 0;
		const body = new ReadableStream<Uint8Array>({
			async pull(stream) {
				if (reads++ === 0) {
					stream.enqueue(new TextEncoder().encode(testCase.sse));
					return;
				}
				// A stream asks for the next chunk as soon as it reads one; wait until the adapter
				// has processed what arrived.
				await new Promise((resolve) => setTimeout(resolve, PROCESSING_MS));
				if (testCase.failure === "connection-drop") {
					stream.error(new TypeError("terminated"));
					return;
				}
				controller.abort();
				stream.error(abortError());
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as typeof globalThis.fetch;
	const original = globalThis.fetch;
	if (testCase.adapter === "google") globalThis.fetch = fetch;
	if (testCase.failure === "abort-before-response") controller.abort();
	const events: unknown[] = [];
	try {
		const run = STREAM[testCase.adapter] as (
			model: Model<Api>,
			context: TranscriptContext,
			options: Record<string, unknown>,
		) => AsyncIterable<{ type: string; partial?: unknown }>;
		const output = run(testCase.model, { messages: testCase.messages } as TranscriptContext, {
			apiKey: testCase.apiKey,
			signal: controller.signal,
			...(testCase.adapter === "google" ? {} : { fetch }),
		});
		for await (const event of output) {
			const { partial: _partial, ...rest } = event;
			events.push(rest);
		}
	} finally {
		globalThis.fetch = original;
	}
	return zeroTimes(events) as unknown[];
}

export async function streamFailureJson(testCase: StreamFailureCase): Promise<string> {
	return `${JSON.stringify({ ...testCase, events: await recordFailure(testCase) }, null, "\t")}\n`;
}

export function readStreamFailureCase(name: string): string {
	return readFileSync(join(STREAM_FAILURE_DIR, `${name}.json`), "utf8");
}
