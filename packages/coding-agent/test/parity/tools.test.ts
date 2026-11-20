import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readToolFile, TOOLS_DIR, toolFiles } from "./tools-record.ts";

describe("reference file tool outputs for the Rust port", () => {
	it("match the TypeScript tools; run `npm run parity:record` after changing them", async () => {
		const files = await toolFiles();
		expect(readdirSync(TOOLS_DIR).sort()).toEqual(Object.keys(files).sort());
		for (const [name, content] of Object.entries(files)) expect(readToolFile(name), name).toBe(content);
	});
});
