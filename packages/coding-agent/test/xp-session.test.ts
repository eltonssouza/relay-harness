import { afterEach, describe, expect, it } from "vitest";
import xpExtension from "../src/extensions/xp/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("XP user interface", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("does not register user-facing XP slash commands", async () => {
		const harness = await createHarness({ extensionFactories: [xpExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		expect(harness.getRegisteredCommands().map((command) => command.invocationName)).not.toContain("xp");
	});
});
