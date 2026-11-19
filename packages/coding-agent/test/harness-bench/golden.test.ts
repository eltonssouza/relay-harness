import { describe, expect, it } from "vitest";
import { goldenJson, readGolden } from "./golden.ts";

describe("reference classifications for other harness implementations", () => {
	it("match the TypeScript harness; run `npm run harness:golden` after changing a rule", () => {
		expect(readGolden()).toBe(goldenJson());
	});
});
