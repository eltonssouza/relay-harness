import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	GOOGLE_STREAM_DIR,
	googleStreamCases,
	googleStreamJson,
	readGoogleStreamCase,
} from "./google-stream-record.ts";

describe("reference Google Gemini stream decoding for the Rust decoder", () => {
	it("has a file for each case and no others", () => {
		const files = readdirSync(GOOGLE_STREAM_DIR).sort();
		expect(files).toEqual(
			googleStreamCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of googleStreamCases()) {
		it(`${testCase.name} matches the TypeScript adapter; run \`npm run parity:record\` after changing it`, async () => {
			expect(readGoogleStreamCase(testCase.name)).toBe(await googleStreamJson(testCase));
		});
	}
});
