import { describe, expect, it } from "vitest";
import { configValuesJson, readConfigValues } from "./config-value-record.ts";

describe("reference config values for the Rust port", () => {
	it("match the coding agent; run `npm run parity:record` after changing it", () => {
		expect(readConfigValues()).toBe(configValuesJson());
	});
});
