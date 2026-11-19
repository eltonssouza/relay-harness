import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_STREAM_DIR, readStreamCase, streamCaseJson, streamCases } from "./anthropic-stream-record.ts";
import { jsonFixtureText, readJsonFixture } from "./json-record.ts";

describe("reference Anthropic stream decoding for the Rust decoder", () => {
	it("has a file for each case and no others", () => {
		const files = readdirSync(ANTHROPIC_STREAM_DIR).sort();
		expect(files).toEqual(
			streamCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of streamCases()) {
		it(`${testCase.name} matches the TypeScript adapter; run \`npm run parity:record\` after changing it`, async () => {
			expect(readStreamCase(testCase.name)).toBe(await streamCaseJson(testCase));
		});
	}
});

describe("reference JSON helper results for the Rust port", () => {
	it("match parseStreamingJson and parseJsonWithRepair; run `npm run parity:record` after changing them", () => {
		expect(readJsonFixture()).toBe(jsonFixtureText());
	});
});
