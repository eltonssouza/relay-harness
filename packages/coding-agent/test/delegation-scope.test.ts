import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkTask } from "../src/core/delegation/contracts.ts";
import { checkWorkerScope } from "../src/core/delegation/scope.ts";
import { loadStructuredAgentProfile } from "../src/extensions/engineering/index.ts";

describe("delegated resource boundaries", () => {
	const directories: string[] = [];
	afterEach(() => {
		for (const directory of directories.splice(0))
			rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	function fixture() {
		const cwd = mkdtempSync(join(tmpdir(), "relay-delegation-scope-"));
		directories.push(cwd);
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src", "login.ts"), "source");
		const task: WorkTask = {
			taskId: "api",
			objective: "Investigate login",
			acceptanceCriteria: ["Root cause"],
			proposedProfile: "backend-engineer",
			dependencies: [],
			inputs: [],
			expectedOutput: "Report",
			resourceScope: ["src"],
			accessMode: "investigation",
			limits: { durationMs: 1000, steps: 5, outputBytes: 1000 },
		};
		return { cwd, task };
	}
	it("permits scoped reads and rejects sibling and parent traversal", () => {
		const { cwd, task } = fixture();
		expect(() => checkWorkerScope(cwd, task, "read", { path: "src/login.ts" })).not.toThrow();
		expect(() => checkWorkerScope(cwd, task, "read", { path: "src/../other.txt" })).toThrow("approved task scope");
		expect(() => checkWorkerScope(cwd, task, "read", { path: "../outside.txt" })).toThrow("outside the workspace");
	});
	it("resolves directory symlinks before permitting existing or new file paths", () => {
		const { cwd, task } = fixture();
		const outside = mkdtempSync(join(tmpdir(), "relay-delegation-outside-"));
		directories.push(outside);
		writeFileSync(join(outside, "existing.txt"), "external");
		symlinkSync(outside, join(cwd, "src", "link"), "junction");
		for (const path of ["src/link/existing.txt", "src/link/new.txt"])
			expect(() => checkWorkerScope(cwd, { ...task, accessMode: "mutation" }, "write", { path })).toThrow(
				"outside the workspace",
			);
	});
	it("treats historical specifications as ordinary scoped files", () => {
		const { cwd, task } = fixture();
		const mutation = { ...task, accessMode: "mutation" as const, resourceScope: ["."] };
		expect(() => checkWorkerScope(cwd, mutation, "write", { path: ".relay/specs/workflow.md" })).not.toThrow();
		expect(() => checkWorkerScope(cwd, task, "read", { path: ".relay/specs/workflow.md" })).toThrow(
			"approved task scope",
		);
		expect(() => checkWorkerScope(cwd, mutation, "write", { path: "src/new.ts" })).not.toThrow();
	});
	it.each(["write", "edit"])("protects principal history and its file aliases from %s", (name) => {
		const { cwd, task } = fixture();
		const mutation = { ...task, accessMode: "mutation" as const, resourceScope: ["."] };
		mkdirSync(join(cwd, "sessions"));
		const history = join(cwd, "sessions", "history.jsonl");
		writeFileSync(history, "principal-owned history\n");
		linkSync(history, join(cwd, "history-alias.jsonl"));
		symlinkSync(join(cwd, "sessions"), join(cwd, "src", "session-link"), "junction");
		for (const path of ["sessions/history.jsonl", "history-alias.jsonl", "src/session-link/history.jsonl"])
			expect(() => checkWorkerScope(cwd, mutation, name, { path }, [history])).toThrow("principal session history");
		expect(() =>
			checkWorkerScope(cwd, mutation, name, { path: "sessions/future.jsonl" }, [
				join(cwd, "sessions", "future.jsonl"),
			]),
		).toThrow("principal session history");
		expect(() => checkWorkerScope(cwd, mutation, name, { path: "src/new.ts" }, [history])).not.toThrow();
		expect(() =>
			checkWorkerScope(cwd, { ...task, resourceScope: ["."] }, "read", { path: "sessions/history.jsonl" }, [
				history,
			]),
		).not.toThrow();
	});
	it.each(["write", "edit", "bash", "powershell", "external_tool"])("rejects %s in investigations", (name) => {
		const { cwd, task } = fixture();
		expect(() => checkWorkerScope(cwd, task, name, { path: "src/login.ts", command: "echo test" })).toThrow(
			"read-only file tools",
		);
	});
	it("requires workspace-wide scope for validation shells and explicit scope for external tools", () => {
		const { cwd, task } = fixture();
		const validation = { ...task, accessMode: "validation" as const };
		expect(() => checkWorkerScope(cwd, validation, "powershell", { command: "node --test" })).toThrow(
			"workspace-wide",
		);
		expect(() =>
			checkWorkerScope(cwd, { ...validation, resourceScope: ["."] }, "powershell", { command: "node --test" }),
		).not.toThrow();
		expect(() => checkWorkerScope(cwd, validation, "external_tool", {})).toThrow("tool resource scope");
		expect(() =>
			checkWorkerScope(cwd, { ...validation, resourceScope: ["tool:external_tool"] }, "external_tool", {}),
		).not.toThrow();
	});
	it("loads trusted profile restrictions and ignores untrusted project overrides", () => {
		const { cwd } = fixture();
		mkdirSync(join(cwd, ".relay", "agents"), { recursive: true });
		writeFileSync(join(cwd, ".relay", "agents", "backend-engineer.md"), "---\ntools: [read]\n---\nProject role");
		expect(loadStructuredAgentProfile("backend-engineer", { cwd, isProjectTrusted: () => true })).toMatchObject({
			tools: ["read"],
			content: expect.stringContaining("Project role"),
		});
		expect(
			loadStructuredAgentProfile("backend-engineer", { cwd, isProjectTrusted: () => false })?.content,
		).not.toContain("Project role");
	});
	it("rejects malformed profile tool restrictions without falling back to a shipped role", () => {
		const { cwd } = fixture();
		mkdirSync(join(cwd, ".relay", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".relay", "agents", "backend-engineer.md"),
			"---\ntools: [read, 1]\n---\nInvalid restrictions",
		);
		expect(() => loadStructuredAgentProfile("backend-engineer", { cwd, isProjectTrusted: () => true })).toThrow(
			"Invalid tool restrictions",
		);
	});
});
