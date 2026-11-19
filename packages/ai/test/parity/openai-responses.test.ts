import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPENAI_RESPONSES_DIR, readResponsesCase, responsesCases, responsesJson } from "./openai-responses-record.ts";

describe("reference OpenAI Responses request bodies for the Rust adapter", () => {
	it("has a file for each case and no others", () => {
		const files = readdirSync(OPENAI_RESPONSES_DIR).sort();
		expect(files).toEqual(
			responsesCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of responsesCases()) {
		it(`${testCase.name} matches the TypeScript adapter; run \`npm run parity:record\` after changing it`, async () => {
			expect(readResponsesCase(testCase.name)).toBe(await responsesJson(testCase));
		});
	}
});
