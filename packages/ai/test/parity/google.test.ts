import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GOOGLE_DIR, googleCases, googleJson, readGoogleCase } from "./google-record.ts";

describe("reference Google Gemini requests for the Rust adapter", () => {
	it("has a file for each case and no others", () => {
		const files = readdirSync(GOOGLE_DIR).sort();
		expect(files).toEqual(
			googleCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of googleCases()) {
		it(`${testCase.name} matches the TypeScript adapter; run \`npm run parity:record\` after changing it`, async () => {
			expect(readGoogleCase(testCase.name)).toBe(await googleJson(testCase));
		});
	}
});
