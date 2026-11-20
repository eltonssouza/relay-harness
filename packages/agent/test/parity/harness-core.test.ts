import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HARNESS_DIR, harnessCases, harnessJson, readHarnessCase } from "./harness-record.ts";

describe("reference HarnessCore behavior on an agent for the Rust port", () => {
	it("has a file for each case and no others", () => {
		expect(readdirSync(HARNESS_DIR).sort()).toEqual(
			harnessCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of harnessCases()) {
		it(`${testCase.name} matches the TypeScript harness; run \`npm run parity:record\` after changing it`, async () => {
			expect(readHarnessCase(testCase.name)).toBe(await harnessJson(testCase));
		});
	}
});
