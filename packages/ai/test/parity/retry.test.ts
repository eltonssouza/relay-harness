import { describe, expect, it } from "vitest";
import { readRetryCases, retryJson } from "./retry-record.ts";

describe("reference retry policy for the Rust port", () => {
	it("matches retryProviderRequest; run `npm run parity:record` after changing it", async () => {
		expect(readRetryCases()).toBe(await retryJson());
	});
});
