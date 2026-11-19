import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	completionsCases,
	completionsJson,
	OPENAI_COMPLETIONS_DIR,
	readCompletionsCase,
} from "./openai-completions-record.ts";

describe("reference OpenAI Chat Completions request bodies for the Rust adapter", () => {
	it("has a file for each case and no others", () => {
		const files = readdirSync(OPENAI_COMPLETIONS_DIR).sort();
		expect(files).toEqual(
			completionsCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of completionsCases()) {
		it(`${testCase.name} matches the TypeScript adapter; run \`npm run parity:record\` after changing it`, async () => {
			expect(readCompletionsCase(testCase.name)).toBe(await completionsJson(testCase));
		});
	}
});
