import { describe, expect, it } from "vitest";
import { readScenario, record, SCENARIOS, scenarioJson } from "./record.ts";

describe("reference scenarios for the Rust agent", () => {
	for (const scenario of SCENARIOS) {
		it(`${scenario.name} matches the TypeScript agent; run \`npm run parity:record\` after changing it`, async () => {
			expect(readScenario(scenario.name)).toBe(scenarioJson(await record(scenario)));
		});
	}
});
