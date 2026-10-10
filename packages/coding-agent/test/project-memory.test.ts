import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, getSystemMessageText } from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeAgents } from "../src/extensions/project-memory/agents.ts";
import {
	memoryPaths,
	type ProjectGraph,
	projectRoot,
	queryGraph,
	readGraph,
	refreshGraph,
} from "../src/extensions/project-memory/graph.ts";
import projectMemoryExtension from "../src/extensions/project-memory/index.ts";
import { renderGraphViewer } from "../src/extensions/project-memory/viewer.ts";
import * as browserLauncher from "../src/utils/open-browser.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const roots: string[] = [];
let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "relay-memory-"));
	roots.push(root);
	return root;
}
function file(root: string, path: string, content: string | Buffer): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
}

describe("project graph", () => {
	it("maps local imports, workspace dependencies, Markdown links and source declarations", async () => {
		const root = fixture();
		file(
			root,
			"package.json",
			JSON.stringify({
				name: "root",
				dependencies: { "@demo/service": "1.0.0", other: "2.0.0" },
				scripts: { check: "tsc" },
			}),
		);
		file(root, "packages/service/package.json", '{"name":"@demo/service"}');
		file(
			root,
			"src/main.ts",
			'import { calculate } from "./calculate.js";\nimport service from "@demo/service";\nexport function start() {}',
		);
		file(root, "src/calculate.ts", "export function calculate() { return 2; }");
		file(root, "README.md", "# Project\n## Validation\n[Source](./src/main.ts)");
		const graph = await refreshGraph(root);
		expect(graph.nodes.find((node) => node.path === "src/main.ts")?.symbols).toEqual(["start"]);
		expect(graph.edges).toEqual(
			expect.arrayContaining([
				{ from: "file:src/main.ts", to: "file:src/calculate.ts", kind: "imports" },
				{ from: "file:src/main.ts", to: "file:packages/service/package.json", kind: "imports" },
				{ from: "file:package.json", to: "file:packages/service/package.json", kind: "depends" },
				{ from: "file:README.md", to: "file:src/main.ts", kind: "links" },
			]),
		);
		expect(queryGraph(graph, "calculate")).toContain("src/calculate.ts");
		expect(queryGraph(graph, "calculate")).toContain("imports ← src/main.ts");
		expect(queryGraph(graph, "unrelatednonexistent")).toContain("No matching");
		expect(await readGraph(root)).toEqual(graph);
		expect(readFileSync(memoryPaths(root).viewer, "utf8")).toContain("Project memory");
	});

	it("refreshes changed, added and deleted files and reuses unchanged indexed entries", async () => {
		const root = fixture();
		file(root, "source.ts", "export function before() {}");
		file(root, "deleted.ts", "export function deleted() {}");
		const initial = await refreshGraph(root);
		const unchanged = await refreshGraph(root, initial);
		expect(unchanged).toBe(initial);
		unlinkSync(memoryPaths(root).viewer);
		await refreshGraph(root, initial);
		expect(readFileSync(memoryPaths(root).viewer, "utf8")).toContain("Project memory");
		file(root, "source.ts", "export function afterChanges() {}");
		file(root, "added.ts", "export function added() {}");
		unlinkSync(join(root, "deleted.ts"));
		const updated = await refreshGraph(root, initial);
		expect(updated.nodes.find((node) => node.path === "source.ts")?.symbols).toEqual(["afterChanges"]);
		expect(updated.nodes.some((node) => node.path === "deleted.ts")).toBe(false);
		expect(updated.nodes.some((node) => node.path === "added.ts")).toBe(true);
		expect(updated.nodes.some((node) => node.path?.startsWith(".relay/memory/"))).toBe(false);
	});

	it("respects nested ignore rules without Git and excludes credentials, binaries and oversized text", async () => {
		const root = fixture();
		file(root, ".gitignore", "*.tmp\n");
		file(root, "nested/.gitignore", "private/\n*.log\n");
		file(root, "nested/private/source.ts", "export class Hidden {}");
		file(root, "nested/deeper/ignored.log", "ignored");
		file(root, "nested/ignored.tmp", "ignored");
		file(root, "nested/source.ts", "export class Visible {}");
		file(root, ".env.local", "SECRET=secret-value");
		file(root, "auth.json", '{"apiKey":"secret-value"}');
		file(root, "node_modules/pkg/index.ts", "export class Hidden {}");
		file(root, "binary.ts", Buffer.from([0, 1, 2]));
		file(root, "big.ts", `export class Hidden {}${" ".repeat(256 * 1024)}`);
		const outside = fixture();
		file(outside, "private.ts", "export class Outside {}");
		symlinkSync(outside, join(root, "external"), process.platform === "win32" ? "junction" : "dir");
		const graph = await refreshGraph(root);
		const indexed = graph.nodes.flatMap((node) => node.path ?? []);
		for (const path of [
			".env.local",
			"auth.json",
			"nested/private/source.ts",
			"nested/deeper/ignored.log",
			"nested/ignored.tmp",
			"node_modules/pkg/index.ts",
		])
			expect(indexed).not.toContain(path);
		expect(indexed).toContain("nested/source.ts");
		expect(indexed).not.toContain("external/private.ts");
		expect(graph.nodes.find((node) => node.path === "binary.ts")?.symbols).toBeUndefined();
		expect(graph.nodes.find((node) => node.path === "big.ts")?.symbols).toBeUndefined();
		expect(JSON.stringify(graph)).not.toContain("secret-value");
	});

	it("discovers the Git root from a subdirectory and respects Git ignores", async () => {
		const root = fixture();
		execFileSync("git", ["init", "--quiet"], { cwd: root });
		file(root, ".gitignore", "ignored/\n");
		file(root, "ignored/no.ts", "export function no() {}");
		file(root, "src/yes.ts", "export function yes() {}");
		file(root, "tracked.ts", "export function tracked() {}");
		execFileSync("git", ["add", "tracked.ts"], { cwd: root });
		expect(projectRoot(join(root, "src"))).toBe(root);
		const graph = await refreshGraph(root);
		expect(graph.nodes.map((node) => node.path)).toContain("tracked.ts");
		expect(graph.nodes.map((node) => node.path)).not.toContain("ignored/no.ts");
	});

	it("refuses symlinked memory directories", async () => {
		const root = fixture(),
			outside = fixture();
		file(root, "source.ts", "export function source() {}");
		mkdirSync(join(root, ".relay"));
		symlinkSync(outside, join(root, ".relay/memory"), process.platform === "win32" ? "junction" : "dir");
		await expect(refreshGraph(root)).rejects.toThrow("Refusing memory symlink");
	});

	it("escapes HTML-like graph data and bounds retrieved context", async () => {
		const root = fixture();
		file(root, "README.md", '# </script><script>alert("unsafe")</script>');
		const graph = await refreshGraph(root);
		const html = renderGraphViewer(graph);
		expect(html).not.toContain('</script><script>alert("unsafe")');
		expect(html).toContain("\\u003c/script>");
		expect(queryGraph(graph, "readme", 1000).length).toBeLessThanOrEqual(6000);
		const large = {
			...graph,
			nodes: Array.from({ length: 25 }, (_, index) => ({
				id: `file:readme${index}`,
				kind: "file" as const,
				label: `readme${index}`,
				summary: "x".repeat(1000),
			})),
		};
		expect(queryGraph(large, "readme", 1000)).toHaveLength(6000);
	});
});

describe("AGENTS initialization", () => {
	it("preserves the existing guide and includes the requested template only once", async () => {
		const root = fixture();
		const original = "# Existing rules\n\nNever run builds.\n";
		file(root, "AGENTS.md", original);
		const graph = await refreshGraph(root);
		await initializeAgents(root, graph);
		const first = readFileSync(join(root, "AGENTS.md"), "utf8");
		expect(first.startsWith(original)).toBe(true);
		expect(first).toContain("Do Not Overcomplicate Simple Tasks");
		expect(first).toContain("Do Not Make Assumptions When Clarity Is Lacking");
		expect(first).toContain("`/graph`");
		expect(first).not.toContain("`/init graph`");
		await initializeAgents(root, graph);
		expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(first);
	});
	it("creates a verified project map and evolution rules when the guide is missing", async () => {
		const root = fixture();
		file(root, "package.json", '{"name":"project","scripts":{"check":"tsc"}}');
		file(root, "AGENTS.md", "");
		await initializeAgents(root, await refreshGraph(root));
		const guide = readFileSync(join(root, "AGENTS.md"), "utf8");
		expect(guide).toContain("package `project`; scripts: `check`");
		expect(guide).toContain("A specification that evolves");
		expect(guide).toContain("Post-implementation checklist");
		expect(guide).not.toContain("npm run build");
	});
});

describe("/init integration", () => {
	it("exposes /graph independently and refreshes before opening without a provider call", async () => {
		const open = vi.spyOn(browserLauncher, "openBrowser").mockImplementation(() => {});
		harness = await createHarness({
			settings: { harnessCore: { evidence: false } },
			extensionFactories: [projectMemoryExtension],
		});
		await harness.session.prompt("/graph");
		expect(open).not.toHaveBeenCalled();
		await harness.session.prompt("/init refresh");
		file(harness.tempDir, "added.ts", "export function added() {}");
		await harness.session.prompt("/graph");
		expect(open).toHaveBeenCalledOnce();
		expect(open.mock.calls[0][0]).toMatch(/\/\.relay\/memory\/graph\.html$/);
		expect((await readGraph(harness.tempDir))?.nodes.map((node) => node.path)).toContain("added.ts");
		await harness.session.prompt("/init graph");
		expect(open).toHaveBeenCalledOnce();
		expect(await harness.session.extensionRunner.getCommand("init")?.getArgumentCompletions?.("g")).toEqual([]);
		expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(false);
	});

	it("refreshes memory and model context within a task, and includes final guide edits before settlement", async () => {
		const snapshots: Array<{ context: string; graph?: ProjectGraph }> = [];
		harness = await createHarness({
			settings: { harnessCore: { evidence: false } },
			extensionFactories: [
				projectMemoryExtension,
				(relay) => {
					relay.registerTool({
						name: "change_project",
						label: "Change fixture",
						description: "Change fixture files",
						parameters: Type.Object({}),
						async execute(_id, _params, _signal, _onUpdate, ctx) {
							file(
								ctx.cwd,
								"source.ts",
								'import { added } from "./added.ts";\nexport function sourceUpdated() {}',
							);
							file(ctx.cwd, "added.ts", "export function added() {}");
							renameSync(join(ctx.cwd, "deleted.ts"), join(ctx.cwd, "renamed.ts"));
							file(ctx.cwd, "AGENTS.md", "# Updated guide\n\n## Verified architecture");
							return { content: [{ type: "text", text: "Changed files." }], details: {} };
						},
					});
					relay.on("context_with_system", async (event, ctx) => {
						const system = getCurrentSystemMessage(event.messages);
						snapshots.push({
							context: system ? getSystemMessageText(system) : "",
							graph: await readGraph(ctx.cwd),
						});
					});
					relay.on("agent_end", (_event, ctx) => {
						file(ctx.cwd, "AGENTS.md", "# Final guide\n\n## Confirmed hurdle");
					});
				},
			],
		});
		file(harness.tempDir, "source.ts", "export function sourceBefore() {}");
		file(harness.tempDir, "deleted.ts", "export function deleted() {}");
		file(harness.tempDir, "AGENTS.md", "# Before guide");
		await harness.session.prompt("/init refresh");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("change_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Changed."),
		]);
		await harness.session.prompt("Update source.ts added.ts renamed.ts and AGENTS.md");
		expect(snapshots).toHaveLength(2);
		expect(snapshots[0].context).toContain("sourceBefore");
		expect(snapshots[1].context).toContain("sourceUpdated");
		expect(snapshots[1].context).not.toContain("sourceBefore");
		expect(snapshots[1].context).toContain("Updated guide");
		expect(snapshots[1].graph?.nodes.map((node) => node.path)).toContain("renamed.ts");
		expect(snapshots[1].graph?.nodes.map((node) => node.path)).not.toContain("deleted.ts");
		expect(snapshots[1].graph?.edges).toContainEqual({
			from: "file:source.ts",
			to: "file:added.ts",
			kind: "imports",
		});
		expect((await readGraph(harness.tempDir))?.nodes.find((node) => node.path === "AGENTS.md")?.summary).toContain(
			"Final guide",
		);
	});

	it("initializes the project, enriches instructions and retrieves memory through the faux provider", async () => {
		harness = await createHarness({
			settings: { harnessCore: { evidence: false } },
			extensionFactories: [projectMemoryExtension],
		});
		file(harness.tempDir, "src/calculation.ts", "export function calculation() { return 1; }");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("project_memory", { query: "calculation" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Project initialized."),
		]);
		await harness.session.prompt("/init");
		// Command messages start asynchronously; the memory hook runs before the agent becomes busy.
		await expect
			.poll(
				() =>
					harness?.session.messages.find(
						(message) => message.role === "toolResult" && message.toolName === "project_memory",
					),
				{ timeout: 10000 },
			)
			.toBeDefined();
		await harness.session.waitForIdle();
		expect(readFileSync(join(harness.tempDir, "AGENTS.md"), "utf8")).toContain("Core Guidelines");
		expect(harness.session.getActiveToolNames()).toContain("project_memory");
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "project_memory",
		);
		expect(JSON.stringify(result)).toContain("src/calculation.ts");
		expect(JSON.stringify(harness.session.messages)).toContain("specification that evolves");
		file(harness.tempDir, "src/calculation.ts", "export function newCalculation() { return 2; }");
		harness.setResponses([fauxAssistantMessage("Inspected.")]);
		await harness.session.prompt("Find newCalculation");
		expect(harness.session.agent.state.systemPrompt).toContain("newCalculation");
		expect(harness.session.agent.state.systemPrompt).not.toContain("return 2");
	});

	it("refreshes without provider calls and refuses untrusted projects", async () => {
		harness = await createHarness({
			settings: { harnessCore: { evidence: false } },
			extensionFactories: [projectMemoryExtension],
		});
		file(harness.tempDir, "source.ts", "export function source() {}");
		await harness.session.prompt("/init refresh");
		expect(await readGraph(harness.tempDir)).toBeDefined();
		file(harness.tempDir, ".relay/memory/graph.json", "invalid json");
		await harness.session.prompt("/init refresh");
		expect(await readGraph(harness.tempDir)).toBeDefined();
		expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(false);
		harness.settingsManager.setProjectTrusted(false);
		file(harness.tempDir, "blocked.ts", "export function blocked() {}");
		await harness.session.prompt("/init refresh");
		expect((await readGraph(harness.tempDir))?.nodes.map((node) => node.path)).not.toContain("blocked.ts");
	});
});
