/**
 * Writes the `packages/ai` reference files in `crates/fixtures/` for the Rust port to match:
 * the JSON helpers, the Anthropic, OpenAI Responses and OpenAI Chat Completions request bodies
 * and stream decoding, the Google Gemini requests and stream decoding, and each adapter's
 * `streamSimple` option mapping. Run through
 * `npm run parity:record`, after the agent scenarios, which the Anthropic bodies read.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANTHROPIC_DIR, anthropicCases, anthropicJson } from "./anthropic-record.ts";
import { ANTHROPIC_STREAM_DIR, streamCaseJson, streamCases } from "./anthropic-stream-record.ts";
import { GOOGLE_DIR, googleCases, googleJson } from "./google-record.ts";
import { GOOGLE_STREAM_DIR, googleStreamCases, googleStreamJson } from "./google-stream-record.ts";
import { JSON_DIR, jsonFixtureText } from "./json-record.ts";
import { completionsCases, completionsJson, OPENAI_COMPLETIONS_DIR } from "./openai-completions-record.ts";
import {
	COMPLETIONS_STREAM_DIR,
	completionsStreamCases,
	completionsStreamJson,
} from "./openai-completions-stream-record.ts";
import { OPENAI_RESPONSES_DIR, responsesCases, responsesJson } from "./openai-responses-record.ts";
import { RESPONSES_STREAM_DIR, responsesStreamCases, responsesStreamJson } from "./openai-responses-stream-record.ts";
import { SIMPLE_DIR, simpleCases, simpleJson } from "./simple-record.ts";

async function writeCases<T extends { name: string }>(
	directory: string,
	cases: T[],
	json: (testCase: T) => Promise<string>,
): Promise<void> {
	// Rewritten whole, so a removed case does not leave a stale file behind.
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	for (const testCase of cases) writeFileSync(join(directory, `${testCase.name}.json`), await json(testCase));
}

mkdirSync(JSON_DIR, { recursive: true });
writeFileSync(join(JSON_DIR, "parse.json"), jsonFixtureText());
await writeCases(ANTHROPIC_DIR, anthropicCases(), anthropicJson);
await writeCases(ANTHROPIC_STREAM_DIR, streamCases(), streamCaseJson);
await writeCases(OPENAI_RESPONSES_DIR, responsesCases(), responsesJson);
await writeCases(RESPONSES_STREAM_DIR, responsesStreamCases(), responsesStreamJson);
await writeCases(OPENAI_COMPLETIONS_DIR, completionsCases(), completionsJson);
await writeCases(COMPLETIONS_STREAM_DIR, completionsStreamCases(), completionsStreamJson);
await writeCases(GOOGLE_DIR, googleCases(), googleJson);
await writeCases(GOOGLE_STREAM_DIR, googleStreamCases(), googleStreamJson);
await writeCases(SIMPLE_DIR, simpleCases(), simpleJson);
console.log(
	`wrote the JSON helpers, ${anthropicCases().length} Anthropic bodies, ${streamCases().length} Anthropic streams, ${responsesCases().length} Responses bodies, ${responsesStreamCases().length} Responses streams, ${completionsCases().length} Chat Completions bodies, ${completionsStreamCases().length} Chat Completions streams, ${googleCases().length} Google requests, ${googleStreamCases().length} Google streams and ${simpleCases().length} simple-option cases to crates/fixtures/`,
);
