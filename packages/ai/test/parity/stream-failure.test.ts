import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	readStreamFailureCase,
	STREAM_FAILURE_DIR,
	streamFailureCases,
	streamFailureJson,
} from "./stream-failure-record.ts";

describe("reference stream failures for the Rust port", () => {
	it("has a file for each case and no others", () => {
		const files = readdirSync(STREAM_FAILURE_DIR).sort();
		expect(files).toEqual(
			streamFailureCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of streamFailureCases()) {
		it(`${testCase.name} matches the TypeScript adapter; run \`npm run parity:record\` after changing it`, async () => {
			expect(readStreamFailureCase(testCase.name)).toBe(await streamFailureJson(testCase));
		});
	}
});
