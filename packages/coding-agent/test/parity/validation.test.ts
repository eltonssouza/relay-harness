import { describe, expect, it } from "vitest";
import { readValidation, validationJson } from "./validation-record.ts";

describe("reference tool-argument validation for the Rust port", () => {
	it("matches validateToolArguments; run `npm run parity:record` after changing it", () => {
		expect(readValidation()).toBe(validationJson());
	});
});
