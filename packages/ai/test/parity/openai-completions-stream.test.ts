import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	COMPLETIONS_STREAM_DIR,
	completionsStreamCases,
	completionsStreamJson,
	readCompletionsStreamCase,
} from "./openai-completions-stream-record.ts";

describe("reference OpenAI Chat Completions stream decoding for the Rust decoder", () => {
	it("has a file for each case and no others", () => {
		const files = readdirSync(COMPLETIONS_STREAM_DIR).sort();
		expect(files).toEqual(
			completionsStreamCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of completionsStreamCases()) {
		it(`${testCase.name} matches the TypeScript adapter; run \`npm run parity:record\` after changing it`, async () => {
			expect(readCompletionsStreamCase(testCase.name)).toBe(await completionsStreamJson(testCase));
		});
	}
});
