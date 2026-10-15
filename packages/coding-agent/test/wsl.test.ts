import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isWSL } from "../src/utils/wsl.ts";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

// PR #65: keep WSL detection independent of the machine running the tests.
describe("isWSL", () => {
	beforeEach(() => vi.resetAllMocks());

	it.each(["WSL_DISTRO_NAME", "WSLENV"])("recognizes %s without reading the kernel", (name) => {
		expect(isWSL({ [name]: "test" })).toBe(true);
		expect(readFileSync).not.toHaveBeenCalled();
	});

	it.each([
		["Linux version 6.6.0-microsoft-standard-WSL2", true],
		["Linux version 5.15.0-Microsoft", true],
		["Linux version 6.6.0-wsl2", true],
		["Linux version 6.8.0-generic", false],
		["", false],
	] as const)("detects kernel %j as WSL=%s", (release, expected) => {
		vi.mocked(readFileSync).mockReturnValue(release);
		expect(isWSL({ WSL_DISTRO_NAME: "", WSLENV: "" })).toBe(expected);
		expect(readFileSync).toHaveBeenCalledExactlyOnceWith("/proc/version", "utf-8");
	});

	it("returns false when proc is unavailable", () => {
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("/proc/version unavailable");
		});
		expect(isWSL({})).toBe(false);
	});
});
