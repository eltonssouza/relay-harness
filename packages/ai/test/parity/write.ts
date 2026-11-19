/**
 * Writes the `packages/ai` reference files in `crates/fixtures/` for the Rust port to match:
 * the JSON helpers, and the Anthropic and OpenAI Responses request bodies and stream decoding. Run through
 * `npm run parity:record`, after the agent scenarios, which the Anthropic bodies read.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANTHROPIC_DIR, anthropicCases, anthropicJson } from "./anthropic-record.ts";
import { ANTHROPIC_STREAM_DIR, streamCaseJson, streamCases } from "./anthropic-stream-record.ts";
import { JSON_DIR, jsonFixtureText } from "./json-record.ts";
import { OPENAI_RESPONSES_DIR, responsesCases, responsesJson } from "./openai-responses-record.ts";
import { RESPONSES_STREAM_DIR, responsesStreamCases, responsesStreamJson } from "./openai-responses-stream-record.ts";

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
console.log(
	`wrote the JSON helpers, ${anthropicCases().length} Anthropic bodies, ${streamCases().length} Anthropic streams, ${responsesCases().length} Responses bodies and ${responsesStreamCases().length} Responses streams to crates/fixtures/`,
);
