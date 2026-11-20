import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSettingsFile, SETTINGS_DIR, settingsFiles } from "./settings-record.ts";

describe("reference settings manager behavior for the Rust port", () => {
	it("matches the TypeScript settings manager; run `npm run parity:record` after changing it", async () => {
		const files = await settingsFiles();
		expect(readdirSync(SETTINGS_DIR).sort()).toEqual(Object.keys(files).sort());
		for (const [name, content] of Object.entries(files)) expect(readSettingsFile(name), name).toBe(content);
	});
});
