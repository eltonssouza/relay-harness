/**
 * Workspace measurements for the harness core's change-size and file-growth signals, from git
 * and the file system.
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { WorkspaceProbe } from "@earendil-works/pi-agent-core";

/** Files larger than this are not read to count lines; generated or binary files say little about a slice. */
const MAX_COUNTED_BYTES = 2 * 1024 * 1024;
/** Untracked files counted per measurement, so a large unignored directory cannot stall a request. */
const MAX_UNTRACKED_FILES = 500;

function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolvePromise) => {
		// No shell: arguments are passed as an array, so nothing in them is interpreted.
		execFile("git", args, { cwd, timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
			resolvePromise(error ? undefined : stdout);
		});
	});
}

async function countLines(path: string): Promise<number | undefined> {
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > MAX_COUNTED_BYTES) return undefined;
		const content = await readFile(path, "utf8");
		if (content.length === 0) return 0;
		let lines = 0;
		for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) lines++;
		return content.endsWith("\n") ? lines : lines + 1;
	} catch {
		return undefined;
	}
}

/** A probe for the git repository at `cwd`. Outside a repository, change size is unknown and the signal stays off. */
export function createGitWorkspaceProbe(cwd: string): WorkspaceProbe {
	return {
		async changedLines() {
			const numstat = await git(cwd, ["diff", "--numstat", "HEAD", "--"]);
			if (numstat === undefined) return undefined;
			const changed = new Map<string, number>();
			for (const line of numstat.split("\n")) {
				const [added, deleted, path] = line.split("\t");
				// Binary files report "-" for both counts.
				if (!path || added === "-" || deleted === "-") continue;
				changed.set(path, Number(added) + Number(deleted));
			}
			const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
			for (const path of (untracked ?? "").split("\0").filter(Boolean).slice(0, MAX_UNTRACKED_FILES)) {
				const lines = await countLines(resolve(cwd, path));
				if (lines !== undefined) changed.set(path, lines);
			}
			return changed;
		},
		fileLines(path) {
			return countLines(isAbsolute(path) ? path : resolve(cwd, path));
		},
	};
}
