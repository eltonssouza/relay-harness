import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_DIR, agentCases, agentJson, readAgentCase } from "./agent-record.ts";

describe("reference Agent class behavior for the Rust port", () => {
	it("has a file for each case and no others", () => {
		expect(readdirSync(AGENT_DIR).sort()).toEqual(
			agentCases()
				.map((testCase) => `${testCase.name}.json`)
				.sort(),
		);
	});

	for (const testCase of agentCases()) {
		it(`${testCase.name} matches the TypeScript Agent; run \`npm run parity:record\` after changing it`, async () => {
			expect(readAgentCase(testCase.name)).toBe(await agentJson(testCase));
		});
	}
});
