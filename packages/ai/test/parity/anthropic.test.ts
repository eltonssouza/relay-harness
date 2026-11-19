import { describe, expect, it } from "vitest";
import { anthropicCases, anthropicJson, readAnthropicCase } from "./anthropic-record.ts";

describe("reference Anthropic request bodies for the Rust adapter", () => {
	for (const testCase of anthropicCases()) {
		it(`${testCase.name} matches the TypeScript adapter; run \`npm run parity:record\` after changing it`, async () => {
			expect(readAnthropicCase(testCase.name)).toBe(await anthropicJson(testCase));
		});
	}
});
