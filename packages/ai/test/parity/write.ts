/**
 * Writes the `packages/ai` reference files in `crates/fixtures/` for the Rust port to match:
 * the JSON helpers, the Anthropic request bodies and the Anthropic stream decoding. Run through
 * `npm run parity:record`, after the agent scenarios, which the Anthropic bodies read.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANTHROPIC_DIR, anthropicCases, anthropicJson } from "./anthropic-record.ts";
import { ANTHROPIC_STREAM_DIR, streamCaseJson, streamCases } from "./anthropic-stream-record.ts";
import { JSON_DIR, jsonFixtureText } from "./json-record.ts";

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
console.log(
	`wrote the JSON helpers, ${anthropicCases().length} Anthropic bodies and ${streamCases().length} Anthropic streams to crates/fixtures/`,
);
