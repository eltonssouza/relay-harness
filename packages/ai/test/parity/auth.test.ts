import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTH_DIR, authCases, authJson, readAuthCase } from "./auth-record.ts";

describe("reference provider auth resolution for the Rust port", () => {
	it("has a file for each case and no others", () => {
		const files = readdirSync(AUTH_DIR).sort();
		expect(files).toEqual(
			authCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of authCases()) {
		it(`${testCase.name} matches the TypeScript provider; run \`npm run parity:record\` after changing it`, async () => {
			expect(readAuthCase(testCase.name)).toBe(await authJson(testCase));
		});
	}
});
