import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitWorkspaceProbe } from "../src/core/workspace-probe.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
		cwd,
		stdio: "ignore",
	});

describe("createGitWorkspaceProbe", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	function repo(): string {
		const dir = mkdtempSync(join(tmpdir(), "relay-probe-"));
		dirs.push(dir);
		git(dir, "init", "-q");
		writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");
		git(dir, "add", "a.ts");
		git(dir, "commit", "-q", "-m", "init");
		return dir;
	}

	it("reports changed lines of tracked files and all lines of untracked ones", async () => {
		const dir = repo();
		writeFileSync(join(dir, "a.ts"), "one\nTWO\nthree\nfour\n");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "new.ts"), "x\ny");
		const changed = await createGitWorkspaceProbe(dir).changedLines();
		// a.ts: 2 added (TWO, four) + 1 deleted (two).
		expect(Object.fromEntries(changed ?? [])).toEqual({ "a.ts": 3, "src/new.ts": 2 });
	});

	it("counts file lines, relative or absolute", async () => {
		const dir = repo();
		const probe = createGitWorkspaceProbe(dir);
		expect(await probe.fileLines("a.ts")).toBe(3);
		expect(await probe.fileLines(join(dir, "a.ts"))).toBe(3);
		expect(await probe.fileLines("missing.ts")).toBeUndefined();
	});

	it("reports an unknown change size outside a repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "relay-probe-"));
		dirs.push(dir);
		expect(await createGitWorkspaceProbe(dir).changedLines()).toBeUndefined();
	});
});
