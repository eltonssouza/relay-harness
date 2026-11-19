/**
 * Reference retry behavior of `retryProviderRequest` (`src/utils/provider-retry.ts`), the
 * OpenAI and Anthropic SDK retry policy every adapter wraps its request in, for the Rust port to
 * match.
 *
 * Each case answers attempts from a script (`attempts`): an HTTP error (a status, or none for a connection
 * failure, and headers) or a success. Timers fire at once and record the delay asked for;
 * `Math.random` and `Date.now` return fixed values, so jitter and HTTP-date delays are exact.
 * Each case records how many attempts ran (`tries`), the delays, and the result or error.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { retryProviderRequest } from "../../src/utils/provider-retry.ts";

export const RETRY_FILE = fileURLToPath(new URL("../../../../crates/fixtures/retry.json", import.meta.url));

export const NOW = 1_700_000_000_000;

type Attempt = { status?: number; headers?: Record<string, string> } | "ok";

export interface RetryCase {
	name: string;
	attempts: Attempt[];
	maxRetries?: number;
	maxRetryDelayMs?: number;
	random?: number;
	/** Abort while the attempt with this index fails. */
	abortOnAttempt?: number;
}

const fail = (status?: number, headers: Record<string, string> = {}): Attempt => ({
	...(status !== undefined ? { status } : {}),
	headers,
});

export function retryCases(): RetryCase[] {
	const many = (attempt: Attempt, count: number) => Array.from({ length: count }, () => attempt);
	return [
		{ name: "no-retries-by-default", attempts: [fail(429), "ok"] },
		{ name: "rate-limit-backoff", attempts: many(fail(429), 4), maxRetries: 3, random: 0.5 },
		{ name: "backoff-cap", attempts: many(fail(503), 8), maxRetries: 7, random: 0 },
		{ name: "full-jitter", attempts: [fail(500), fail(500), "ok"], maxRetries: 5, random: 0.999 },
		{ name: "retryable-statuses", attempts: [fail(408), fail(409), fail(500), fail(599), "ok"], maxRetries: 9 },
		{ name: "connection-failure", attempts: [fail(undefined), "ok"], maxRetries: 1 },
		{ name: "client-error", attempts: [fail(400), "ok"], maxRetries: 3 },
		{ name: "not-found", attempts: [fail(404), "ok"], maxRetries: 3 },
		{
			name: "should-retry-header",
			attempts: [fail(400, { "x-should-retry": "true" }), fail(503, { "x-should-retry": "false" }), "ok"],
			maxRetries: 3,
		},
		{
			name: "should-retry-other-value",
			attempts: [fail(400, { "x-should-retry": "yes" }), "ok"],
			maxRetries: 3,
		},
		{ name: "retry-after-ms", attempts: [fail(429, { "retry-after-ms": "1500" }), "ok"], maxRetries: 1 },
		{ name: "retry-after-ms-prefix", attempts: [fail(429, { "retry-after-ms": "250.5ms" }), "ok"], maxRetries: 1 },
		{
			name: "retry-after-ms-invalid",
			attempts: [fail(429, { "retry-after-ms": "soon", "retry-after": "3" }), "ok"],
			maxRetries: 1,
		},
		{ name: "retry-after-seconds", attempts: [fail(429, { "retry-after": "2" }), "ok"], maxRetries: 1 },
		{ name: "retry-after-fraction", attempts: [fail(503, { "retry-after": " 0.25 " }), "ok"], maxRetries: 1 },
		{ name: "retry-after-words", attempts: [fail(503, { "retry-after": "5 seconds" }), "ok"], maxRetries: 1 },
		{ name: "retry-after-negative", attempts: [fail(503, { "retry-after": "-1" }), "ok"], maxRetries: 1 },
		{
			name: "retry-after-http-date",
			attempts: [fail(503, { "retry-after": "Tue, 14 Nov 2023 22:13:30 GMT" }), "ok"],
			maxRetries: 1,
		},
		{
			name: "retry-after-past-date",
			attempts: [fail(503, { "retry-after": "Tue, 14 Nov 2023 22:13:00 GMT" }), "ok"],
			maxRetries: 1,
		},
		{
			name: "retry-after-rfc850-date",
			attempts: [fail(503, { "retry-after": "Tuesday, 14-Nov-23 22:13:27 GMT" }), "ok"],
			maxRetries: 1,
		},
		{
			name: "retry-after-lowercase-date",
			attempts: [fail(503, { "retry-after": "tue, 14 nov 2023 22:13:22 gmt" }), "ok"],
			maxRetries: 1,
		},
		{
			name: "retry-after-iso-date",
			attempts: [fail(503, { "retry-after": "2023-11-14T22:13:25.500Z" }), "ok"],
			maxRetries: 1,
		},
		{
			name: "retry-after-garbage",
			attempts: [fail(503, { "retry-after": "later" }), "ok"],
			maxRetries: 1,
			random: 0,
		},
		{
			name: "retry-after-infinity",
			attempts: [fail(503, { "retry-after": "Infinity" }), "ok"],
			maxRetries: 1,
			random: 0,
		},
		{ name: "retry-after-too-long", attempts: [fail(429, { "retry-after": "120" }), "ok"], maxRetries: 2 },
		{
			name: "retry-after-ms-too-long",
			attempts: [fail(429, { "retry-after-ms": "60001" }), "ok"],
			maxRetries: 2,
		},
		{
			name: "retry-after-at-limit",
			attempts: [fail(429, { "retry-after": "60" }), "ok"],
			maxRetries: 2,
		},
		{
			name: "custom-limit",
			attempts: [fail(429, { "retry-after": "5" }), "ok"],
			maxRetries: 2,
			maxRetryDelayMs: 4000,
		},
		{
			name: "no-limit",
			attempts: [fail(429, { "retry-after": "600" }), "ok"],
			maxRetries: 2,
			maxRetryDelayMs: 0,
		},
		{ name: "aborted", attempts: [fail(500), "ok"], maxRetries: 3, abortOnAttempt: 0 },
		{ name: "aborted-client-error", attempts: [fail(400), "ok"], maxRetries: 3, abortOnAttempt: 0 },
	];
}

class ScriptedError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
	constructor(attempt: Exclude<Attempt, "ok">, index: number) {
		super(`attempt ${index} failed`);
		this.status = attempt.status;
		this.headers = new Headers(attempt.headers);
	}
}

export async function runRetryCase(testCase: RetryCase): Promise<unknown> {
	const delays: number[] = [];
	const originalSetTimeout = globalThis.setTimeout;
	const originalRandom = Math.random;
	const originalNow = Date.now;
	globalThis.setTimeout = ((callback: () => void, ms?: number) => {
		delays.push(ms ?? 0);
		queueMicrotask(callback);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	Math.random = () => testCase.random ?? 0.5;
	Date.now = () => NOW;
	const controller = new AbortController();
	let attempts = 0;
	try {
		const result = await retryProviderRequest(
			async () => {
				const index = attempts++;
				const attempt = testCase.attempts[index];
				if (attempt === undefined) throw new Error("script ran out");
				if (testCase.abortOnAttempt === index) controller.abort();
				if (attempt === "ok") return `attempt ${index} succeeded`;
				throw new ScriptedError(attempt, index);
			},
			{ maxRetries: testCase.maxRetries, maxRetryDelayMs: testCase.maxRetryDelayMs, signal: controller.signal },
		);
		return { tries: attempts, delays, result };
	} catch (error) {
		const failure = error as Error;
		return { tries: attempts, delays, error: { name: failure.name, message: failure.message } };
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		Math.random = originalRandom;
		Date.now = originalNow;
	}
}

export async function retryJson(): Promise<string> {
	const cases = [];
	for (const testCase of retryCases()) cases.push({ ...testCase, ...((await runRetryCase(testCase)) as object) });
	return `${JSON.stringify({ now: NOW, cases }, null, "\t")}\n`;
}

export function readRetryCases(): string {
	return readFileSync(RETRY_FILE, "utf8");
}
