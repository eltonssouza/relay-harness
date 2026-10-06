import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewRelayVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestRelayRelease,
	getLatestRelayVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const originalSkipVersionCheck = process.env.RELAY_SKIP_VERSION_CHECK;

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.RELAY_SKIP_VERSION_CHECK;
	} else {
		process.env.RELAY_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewRelayVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewRelayVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("reads the latest version from the npm registry with a relay user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestRelayVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://registry.npmjs.org/@relay-harness/coding-agent/latest",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^relay\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("retries a transient version request when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestRelayRelease("1.2.3", { retry: true })).resolves.toEqual({ version: "1.2.4" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps automatic version checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewRelayVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("reads the version from a full registry document", async () => {
		// The registry's /latest document is the package.json of the version plus dist metadata.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					name: "@relay-harness/coding-agent",
					version: "1.2.4",
					dist: { tarball: "https://x/y.tgz" },
				}),
			),
		);
		await expect(getLatestRelayRelease("1.2.3")).resolves.toEqual({ version: "1.2.4" });
	});

	it("returns undefined when the package is not published", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: "Not found" }, { status: 404 })),
		);
		await expect(getLatestRelayRelease("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewRelayVersion("1.2.2")).resolves.toBeUndefined();
	});

	it("returns undefined for registry data without a semver version", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ name: "no version" }))
			.mockResolvedValueOnce(Response.json({ version: "nightly" }))
			.mockResolvedValueOnce(Response.json(null));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestRelayRelease("1.2.3")).resolves.toBeUndefined();
		await expect(getLatestRelayRelease("1.2.3")).resolves.toBeUndefined();
		await expect(getLatestRelayRelease("1.2.3")).resolves.toBeUndefined();
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.RELAY_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewRelayVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.RELAY_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestRelayVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
