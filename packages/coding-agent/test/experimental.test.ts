import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalRelayExperimental = process.env.RELAY_EXPERIMENTAL;

	afterEach(() => {
		if (originalRelayExperimental === undefined) {
			delete process.env.RELAY_EXPERIMENTAL;
		} else {
			process.env.RELAY_EXPERIMENTAL = originalRelayExperimental;
		}
	});

	it("returns false when RELAY_EXPERIMENTAL is unset", () => {
		delete process.env.RELAY_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when RELAY_EXPERIMENTAL is empty", () => {
		process.env.RELAY_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when RELAY_EXPERIMENTAL is set to 1", () => {
		process.env.RELAY_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when RELAY_EXPERIMENTAL is set to 0", () => {
		process.env.RELAY_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when RELAY_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.RELAY_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
