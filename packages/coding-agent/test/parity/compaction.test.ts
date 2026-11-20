import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPACTION_DIR, compactionFiles, readCompactionFile } from "./compaction-record.ts";

describe("reference compaction behavior for the Rust port", () => {
	it("matches the TypeScript compaction; run `npm run parity:record` after changing it", async () => {
		const files = await compactionFiles();
		expect(readdirSync(COMPACTION_DIR).sort()).toEqual(Object.keys(files).sort());
		for (const [name, content] of Object.entries(files)) expect(readCompactionFile(name), name).toBe(content);
	});
});
