import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OAUTH_DIR, oauthCases, oauthJson, readOAuthCase } from "./oauth-record.ts";

describe("reference OAuth refreshes for the Rust port", () => {
	it("has a file for each case and no others", () => {
		const files = readdirSync(OAUTH_DIR).sort();
		expect(files).toEqual(
			oauthCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of oauthCases()) {
		it(`${testCase.name} matches the TypeScript provider; run \`npm run parity:record\` after changing it`, async () => {
			expect(readOAuthCase(testCase.name)).toBe(await oauthJson(testCase));
		});
	}
});
