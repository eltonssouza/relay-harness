import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSessionFile, SESSION_DIR, sessionFiles } from "./session-record.ts";

describe("reference session manager behavior for the Rust port", () => {
	it("matches the TypeScript session manager; run `npm run parity:record` after changing it", async () => {
		const files = await sessionFiles();
		expect(readdirSync(SESSION_DIR).sort()).toEqual(Object.keys(files).sort());
		for (const [name, content] of Object.entries(files)) expect(readSessionFile(name), name).toBe(content);
	});
});
