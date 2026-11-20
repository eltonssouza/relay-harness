import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOOP_DIR, loopCases, loopJson, readLoopCase } from "./loop-record.ts";

describe("reference agent loop behavior for the Rust port", () => {
	it("has a file for each case and no others", () => {
		expect(readdirSync(LOOP_DIR).sort()).toEqual(
			loopCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of loopCases()) {
		it(`${testCase.name} matches the TypeScript loop; run \`npm run parity:record\` after changing it`, async () => {
			expect(readLoopCase(testCase.name)).toBe(await loopJson(testCase));
		});
	}
});
