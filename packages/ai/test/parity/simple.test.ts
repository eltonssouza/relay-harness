import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSimpleCase, SIMPLE_DIR, simpleCases, simpleJson } from "./simple-record.ts";

describe("reference streamSimple results for the Rust port", () => {
	it("has a file for each case and no others", () => {
		const files = readdirSync(SIMPLE_DIR).sort();
		expect(files).toEqual(
			simpleCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of simpleCases()) {
		it(`${testCase.name} matches the TypeScript adapter; run \`npm run parity:record\` after changing it`, async () => {
			expect(readSimpleCase(testCase.name)).toBe(await simpleJson(testCase));
		});
	}
});
