import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESOURCES_DIR, readResourcesFile, resourcesFiles } from "./resources-record.ts";

describe("reference resource behavior for the Rust port", () => {
	it("matches the TypeScript system prompt and resources; run `npm run parity:record` after changing them", async () => {
		const files = await resourcesFiles();
		expect(readdirSync(RESOURCES_DIR).sort()).toEqual(Object.keys(files).sort());
		for (const [name, content] of Object.entries(files)) expect(readResourcesFile(name), name).toBe(content);
	});
});
