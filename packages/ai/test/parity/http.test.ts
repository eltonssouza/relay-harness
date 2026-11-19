import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HTTP_DIR, httpCases, httpJson, readHttpCase } from "./http-record.ts";

describe("reference HTTP requests and errors for the Rust port", () => {
	it("has a file for each case and no others", () => {
		const files = readdirSync(HTTP_DIR).sort();
		expect(files).toEqual(
			httpCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of httpCases()) {
		it(`${testCase.name} matches the TypeScript adapter; run \`npm run parity:record\` after changing it`, async () => {
			expect(readHttpCase(testCase.name)).toBe(await httpJson(testCase));
		});
	}
});
