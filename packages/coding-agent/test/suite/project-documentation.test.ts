import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, getSystemMessageText } from "@relay-harness/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

function systemText(messages: Parameters<typeof getCurrentSystemMessage>[0]): string {
	const system = getCurrentSystemMessage(messages);
	return system ? getSystemMessageText(system) : "";
}

// Feature coverage for https://github.com/eltonssouza/relay-harness/issues/44.
describe("project development documentation", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	const harnesses: Harness[] = [];
	const requests: Array<{ prompt: string; model: string }> = [];

	beforeEach(() => {
		requests.length = 0;
		tempDir = mkdtempSync(join(tmpdir(), "relay-project-documentation-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(noContextFiles = false, extensions: ExtensionFactory[] = []): Promise<Harness> {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noContextFiles,
			settingsManager: SettingsManager.inMemory(),
		});
		const extensionsResult = await createTestExtensionsResult(extensions, cwd);
		const harness = await createHarness({
			models: [{ id: "first" }, { id: "second" }],
			resourceLoader: {
				...createTestResourceLoader({ extensionsResult }),
				getAgentsFiles: () => loader.getAgentsFiles(),
			},
		});
		harnesses.push(harness);
		const setResponses = harness.setResponses;
		harness.setResponses = (responses) =>
			setResponses(
				responses.map((step) => (context, options, state, model) => {
					requests.push({ prompt: systemText(context.messages), model: model.id });
					return typeof step === "function" ? step(context, options, state, model) : step;
				}),
			);
		return harness;
	}

	it("targets the repository root from a subdirectory even with inherited instructions", () => {
		const repo = cwd;
		mkdirSync(join(repo, ".git"));
		writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
		cwd = join(repo, "src");
		mkdirSync(cwd);
		writeFileSync(join(tempDir, "AGENTS.md"), "Parent instructions");
		writeFileSync(join(agentDir, "AGENTS.md"), "Global instructions");
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory() });

		const resources = loader.getAgentsFiles();
		expect(resources.projectAgentsPath).toBe(join(repo, "AGENTS.md"));
		expect(resources.agentsFiles.map((file) => file.content)).toEqual(["Global instructions", "Parent instructions"]);
		expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
	});

	it("targets a linked worktree instead of the main checkout", () => {
		const mainRepo = join(tempDir, "main");
		const gitDir = join(mainRepo, ".git", "worktrees", "feature");
		mkdirSync(gitDir, { recursive: true });
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
		writeFileSync(join(gitDir, "commondir"), "../..\n");
		writeFileSync(join(cwd, ".git"), `gitdir: ${gitDir}\n`);
		const worktree = cwd;
		cwd = join(worktree, "src");
		mkdirSync(cwd);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory() });

		expect(loader.getAgentsFiles().projectAgentsPath).toBe(join(worktree, "AGENTS.md"));
	});

	it("lets the selected model create the guide through session tools and loads its full contents next turn", async () => {
		const harness = await createSession();
		const path = join(cwd, "AGENTS.md");
		const content = `# Development guide\n${Array.from({ length: 702 }, (_, i) => `Verified convention ${i}`).join("\n")}`;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Guide created; continuing development."),
		]);

		await harness.session.prompt("Implement a feature in this project.");
		expect(readFileSync(path, "utf8")).toBe(content);
		expect(requests).toHaveLength(2);
		expect(requests[0].model).toBe("first");
		expect(requests[0].prompt).toContain(`Project development guide: ${path.replace(/\\/g, "/")}`);
		expect(requests[0].prompt).toContain("before changing the implementation");
		expect(requests[0].prompt).toContain("inspect the project's README");
		expect(requests[0].prompt).toContain("never secret values");
		expect(requests[1].prompt).toContain(content);
	});

	it("refreshes edits before the next prompt and supplies the guide after a model switch", async () => {
		const path = join(cwd, "AGENTS.md");
		writeFileSync(path, "Use the existing test command.");
		const harness = await createSession();
		harness.setResponses([fauxAssistantMessage("First task finished.")]);
		await harness.session.prompt("Inspect this project.");
		expect(requests[0].prompt).toContain("Use the existing test command.");
		writeFileSync(path, "Use the updated test command.");
		const second = harness.getModel("second");
		if (!second) throw new Error("Missing second faux model");
		await harness.session.setModel(second);
		harness.setResponses([fauxAssistantMessage("Second task finished.")]);
		await harness.session.prompt("Implement the next change.");
		expect(requests).toHaveLength(2);
		expect(requests[1].model).toBe("second");
		expect(requests[1].prompt).toContain("Use the updated test command.");
		expect(requests[1].prompt).not.toContain("Use the existing test command.");
	});

	it("removes deleted instructions from the effective prompt", async () => {
		const path = join(cwd, "AGENTS.md");
		writeFileSync(path, "Instructions that will be removed.");
		const harness = await createSession();
		harness.setResponses([fauxAssistantMessage("First task finished.")]);
		await harness.session.prompt("Inspect this project.");
		rmSync(path);
		harness.setResponses([fauxAssistantMessage("Ready for the next task.")]);
		await harness.session.prompt("Inspect the current state.");
		expect(requests).toHaveLength(2);
		expect(requests[1].prompt).not.toContain("Instructions that will be removed.");
	});

	it("refreshes guide edits when a tool-result handler also changes the active tools", async () => {
		const path = join(cwd, "AGENTS.md");
		writeFileSync(path, "Rules before the tool call.");
		const harness = await createSession(false, [
			(relay) => {
				relay.on("tool_result", () => {
					relay.setActiveTools(["read", "write"]);
				});
			},
		]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content: "Rules after the tool call." }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Guide updated."),
		]);
		await harness.session.prompt("Update the development guide.");
		expect(requests).toHaveLength(2);
		expect(requests[1].prompt).toContain("Rules after the tool call.");
		expect(requests[1].prompt).not.toContain("Rules before the tool call.");
	});

	it("preserves existing files and limits creation to development tasks", async () => {
		const path = join(cwd, "AGENTS.md");
		const harness = await createSession();
		harness.setResponses([fauxAssistantMessage("This is an explanation.")]);
		await harness.session.prompt("Explain what a harness is.");
		expect(existsSync(path)).toBe(false);
		expect(requests[0].prompt).toContain("Do not create it for questions, read-only reviews");
		writeFileSync(path, "Existing project rules.");
		harness.setResponses([fauxAssistantMessage("Following the project rules.")]);
		await harness.session.prompt("Implement a change.");
		expect(readFileSync(path, "utf8")).toBe("Existing project rules.");
		expect(requests[1].prompt).toContain("Existing project rules.");
		expect(requests[1].prompt).toContain("never replace it with a generic template");
	});

	it("honors --no-context-files for both loading and generation instructions", async () => {
		writeFileSync(join(cwd, "AGENTS.md"), "Disabled project instructions.");
		const harness = await createSession(true);
		harness.setResponses([fauxAssistantMessage("Running without context files.")]);
		await harness.session.prompt("Implement a change.");
		expect(requests).toHaveLength(1);
		expect(requests[0].prompt).not.toContain("Disabled project instructions.");
		expect(requests[0].prompt).not.toContain("<project_documentation>");
	});

	it("keeps extension edits and additional instructions while refreshing other files", async () => {
		const path = join(cwd, "AGENTS.md");
		const globalPath = join(agentDir, "AGENTS.md");
		writeFileSync(path, "Original project rules.");
		writeFileSync(globalPath, "Original global rules.");
		const harness = await createSession(false, [
			(relay) => {
				relay.on("before_agent_start", (event) => {
					const project = event.systemPromptOptions.contextFiles.find((file) => file.path === path);
					if (!project) throw new Error("Missing project rules");
					project.content = "Extension project rules.";
					event.systemPromptOptions.contextFiles.push({ path: "/virtual/rules.md", content: "Extra rules." });
				});
			},
		]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: globalPath, content: "Updated global rules." }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Finished."),
		]);
		await harness.session.prompt("Update the global development guide.");
		expect(requests).toHaveLength(2);
		expect(requests[1].prompt).toContain("Extension project rules.");
		expect(requests[1].prompt).toContain("Extra rules.");
		expect(requests[1].prompt).toContain("Updated global rules.");
		expect(requests[1].prompt).not.toContain("Original global rules.");
	});
});
