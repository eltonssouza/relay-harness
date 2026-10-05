import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...(actual as Record<string, unknown>),
		PACKAGE_NAME: "@example/relay-coding-agent",
	};
});

import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";

describe("shouldRunFirstTimeSetup in forked distributions", () => {
	const originalRelayExperimental = process.env.RELAY_EXPERIMENTAL;
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "relay-first-time-setup-fork-"));
		settingsPath = join(tempDir, "settings.json");
		process.env.RELAY_EXPERIMENTAL = "1";
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalRelayExperimental === undefined) {
			delete process.env.RELAY_EXPERIMENTAL;
		} else {
			process.env.RELAY_EXPERIMENTAL = originalRelayExperimental;
		}
	});

	it("returns false for a forked package", () => {
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});
