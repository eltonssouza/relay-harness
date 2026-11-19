import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	RESPONSES_STREAM_DIR,
	readResponsesStreamCase,
	responsesStreamCases,
	responsesStreamJson,
} from "./openai-responses-stream-record.ts";

describe("reference OpenAI Responses stream decoding for the Rust decoder", () => {
	it("has a file for each case and no others", () => {
		const files = readdirSync(RESPONSES_STREAM_DIR).sort();
		expect(files).toEqual(
			responsesStreamCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of responsesStreamCases()) {
		it(`${testCase.name} matches the TypeScript adapter; run \`npm run parity:record\` after changing it`, async () => {
			expect(readResponsesStreamCase(testCase.name)).toBe(await responsesStreamJson(testCase));
		});
	}
});
