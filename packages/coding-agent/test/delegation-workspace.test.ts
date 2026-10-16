import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureWorkspace, changedWorkspaceFiles, WorkspaceTracker } from "../src/core/delegation/workspace.ts";

describe("workspace content snapshots", () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "relay-delegation-workspace-"));
		mkdirSync(join(directory, "src"));
		writeFileSync(join(directory, "src/code.ts"), "export const value = 1;\n");
	});
	afterEach(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
	it("detects writes, additions, deletions and atomic replacement without a Git repository", () => {
		const first = captureWorkspace(directory);
		expect(captureWorkspace(directory).digest).toBe(first.digest);
		writeFileSync(join(directory, "src/replacement.ts"), "export const value = 2;\n");
		renameSync(join(directory, "src/replacement.ts"), join(directory, "src/code.ts"));
		writeFileSync(join(directory, "src/new.ts"), "export const added = true;\n");
		const second = captureWorkspace(directory);
		expect(changedWorkspaceFiles(first, second)).toEqual(["src/code.ts", "src/new.ts"]);
		rmSync(join(directory, "src/code.ts"));
		expect(changedWorkspaceFiles(second, captureWorkspace(directory))).toEqual(["src/code.ts"]);
	});
	it("compares restored baselines with current content and preserves the new reference", () => {
		const original = new WorkspaceTracker(directory);
		const saved = original.baseline();
		writeFileSync(join(directory, "src/code.ts"), "export const value = 2;\n");
		const restored = new WorkspaceTracker(directory, saved);
		expect(restored.inspect(true)).toEqual({ files: [], restored: true });
		expect(restored.baseline().digest).not.toBe(saved.digest);
		expect(restored.inspect(true)).toBeUndefined();
	});
	it("adds ignored dependencies explicitly and detects their later changes", () => {
		writeFileSync(join(directory, ".gitignore"), "cache/\n");
		mkdirSync(join(directory, "cache"));
		writeFileSync(join(directory, "cache/input.json"), "{}");
		const tracker = new WorkspaceTracker(directory);
		expect(tracker.observe("cache/input.json")).toBe(true);
		expect(tracker.observe("cache/input.json")).toBe(false);
		const restored = new WorkspaceTracker(directory, tracker.baseline());
		writeFileSync(join(directory, "cache/input.json"), "[]");
		expect(restored.inspect(true)).toEqual({ files: ["cache/input.json"], restored: false });
		expect(restored.baseline().observedFiles).toEqual(["cache/input.json"]);
	});
	it("rejects unsupported persisted baselines instead of silently adopting current files", () => {
		expect(
			() => new WorkspaceTracker(directory, { version: 2, digest: "invalid", observedFiles: [], controlFiles: [] }),
		).toThrow("Unsupported delegation workspace baseline");
	});
	it("excludes only runtime session files while retaining code in the same directory", () => {
		const history = join(directory, "history.jsonl");
		const tracker = new WorkspaceTracker(directory, undefined, [history]);
		writeFileSync(history, "Runtime event\n");
		expect(tracker.inspect(true)).toBeUndefined();
		expect(tracker.observe(history)).toBe(false);
		writeFileSync(join(directory, "source.jsonl"), "Source data\n");
		writeFileSync(join(directory, "src/code.ts"), "export const value = 2;\n");
		expect(tracker.inspect(true)).toEqual({ files: ["source.jsonl", "src/code.ts"], restored: false });
		expect(tracker.baseline().controlFiles).toEqual(["history.jsonl"]);
	});
	it("retains known session paths across restoration and ignores their canonical aliases", () => {
		mkdirSync(join(directory, "sessions"));
		const history = join(directory, "sessions/first.jsonl");
		writeFileSync(history, "Initial event\n");
		symlinkSync(
			join(directory, "sessions"),
			join(directory, "history-link"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const tracker = new WorkspaceTracker(directory, undefined, [history]);
		expect(tracker.observe("history-link/first.jsonl")).toBe(true);
		writeFileSync(history, "Updated runtime event\n");
		expect(tracker.inspect(true)).toBeUndefined();
		const second = join(directory, "sessions/second.jsonl");
		writeFileSync(second, "New branch\n");
		const restored = new WorkspaceTracker(directory, tracker.baseline(), [second]);
		expect(restored.inspect(true)).toBeUndefined();
		expect(restored.baseline().controlFiles).toEqual(["sessions/first.jsonl", "sessions/second.jsonl"]);
		writeFileSync(join(directory, "sessions/source.ts"), "export const input = true;\n");
		expect(restored.inspect(true)?.files).toEqual(["sessions/source.ts"]);
	});
	it("detects same-size changes even when the old modification time is restored", () => {
		const path = join(directory, "src/code.ts");
		const metadata = statSync(path);
		const first = captureWorkspace(directory);
		writeFileSync(path, readFileSync(path, "utf8").replace("1", "2"));
		utimesSync(path, metadata.atime, metadata.mtime);
		expect(captureWorkspace(directory).digest).not.toBe(first.digest);
	});
	it("respects inherited ignore rules, nested exceptions and rule changes", () => {
		writeFileSync(join(directory, ".gitignore"), "*.log\ncache/\n");
		writeFileSync(join(directory, "src/.gitignore"), "!important.log\n");
		writeFileSync(join(directory, "src/important.log"), "required input");
		mkdirSync(join(directory, "cache"));
		writeFileSync(join(directory, "cache/output"), "generated");
		const first = captureWorkspace(directory);
		expect(first.files.has("src/important.log")).toBe(true);
		expect(first.files.has("cache/output")).toBe(false);
		writeFileSync(join(directory, "cache/output"), "new generated output");
		writeFileSync(join(directory, "src/unimportant.log"), "ignored");
		expect(captureWorkspace(directory).digest).toBe(first.digest);
		writeFileSync(join(directory, "src/.gitignore"), "# updated rule\n!important.log\n");
		expect(changedWorkspaceFiles(first, captureWorkspace(directory))).toEqual(["src/.gitignore"]);
	});
	it("tracks explicitly observed ignored files and their deletion", () => {
		writeFileSync(join(directory, ".ignore"), "cache/\n");
		mkdirSync(join(directory, "cache"));
		const path = join(directory, "cache/schema.json");
		writeFileSync(path, "{}");
		const before = captureWorkspace(directory, [path]);
		writeFileSync(path, "[]");
		expect(changedWorkspaceFiles(before, captureWorkspace(directory, [path]))).toEqual(["cache/schema.json"]);
		rmSync(path);
		expect(captureWorkspace(directory, [path]).files.get("cache/schema.json")).toBe("missing");
	});
	it("excludes Git metadata and installed dependencies", () => {
		const first = captureWorkspace(directory);
		for (const path of [".git", "node_modules"]) {
			mkdirSync(join(directory, path), { recursive: true });
			writeFileSync(join(directory, path, "content"), "not a workspace input");
		}
		const second = captureWorkspace(directory);
		expect(second.files.has(".relay/specs/content")).toBe(false);
		expect(changedWorkspaceFiles(first, second)).toEqual([]);
	});
	it("tracks historical specifications and their aliases as ordinary source inputs", () => {
		mkdirSync(join(directory, ".relay/specs"), { recursive: true });
		const artifact = join(directory, ".relay/specs/workflow.md");
		writeFileSync(artifact, "Planning");
		symlinkSync(
			join(directory, ".relay/specs"),
			join(directory, "spec-link"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const first = captureWorkspace(directory, ["spec-link/workflow.md"]);
		writeFileSync(artifact, "Design");
		expect(captureWorkspace(directory, ["spec-link/workflow.md"]).digest).not.toBe(first.digest);
	});
	it("uses the same content baseline when the workspace itself is a directory link", () => {
		mkdirSync(join(directory, ".relay/specs"), { recursive: true });
		writeFileSync(join(directory, ".relay/specs/workflow.md"), "Planning");
		symlinkSync(
			join(directory, ".relay/specs"),
			join(directory, "spec-link"),
			process.platform === "win32" ? "junction" : "dir",
		);
		symlinkSync(directory, join(directory, "workspace-link"), process.platform === "win32" ? "junction" : "dir");
		expect(captureWorkspace(join(directory, "workspace-link"), ["spec-link/workflow.md"]).digest).toBe(
			captureWorkspace(directory, ["spec-link/workflow.md"]).digest,
		);
	});
	it("does not recurse through directory links and tracks explicitly observed external inputs", () => {
		const outside = mkdtempSync(join(tmpdir(), "relay-delegation-external-"));
		try {
			const path = join(outside, "contract.json");
			writeFileSync(path, "{}");
			symlinkSync(outside, join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
			const plain = captureWorkspace(directory);
			const observed = captureWorkspace(directory, [path]);
			writeFileSync(path, "[]");
			expect(captureWorkspace(directory).digest).toBe(plain.digest);
			expect(captureWorkspace(directory, [path]).digest).not.toBe(observed.digest);
		} finally {
			rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
	it("records dangling directory links without following them", () => {
		symlinkSync(
			join(directory, "missing"),
			join(directory, "link"),
			process.platform === "win32" ? "junction" : "dir",
		);
		expect(captureWorkspace(directory).files.get("link")).toContain("missing");
	});
});
