import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@relay-harness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { readGoal } from "../../src/extensions/goal/state.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

describe("built-in task execution", () => {
	const harnesses: Harness[] = [];
	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Local services unavailable"));
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	async function setup(sessionManager?: SessionManager): Promise<Harness> {
		let directory = "";
		const parameters = Type.Object({ path: Type.String(), content: Type.String() });
		const write: AgentTool<typeof parameters> = {
			name: "write",
			label: "Write",
			description: "Save a file in the test workspace",
			parameters,
			execute: async (_id, args) => {
				writeFileSync(join(directory, args.path), args.content);
				return { content: [{ type: "text", text: "Written" }], details: {} };
			},
		};
		const harness = await createHarness({
			sessionManager,
			settings: { laya: { autostart: false, memory: false, telemetry: false } },
			extensionFactories: builtInExtensions,
			initialActiveToolNames: ["write"],
			tools: [write],
		});
		harnesses.push(harness);
		directory = harness.tempDir;
		await harness.session.bindExtensions({});
		return harness;
	}

	it("writes and settles without workflow checkpoints or a local classifier", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "result.ts", content: "export const result = 42;\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Saved result.ts."),
		]);
		await harness.session.prompt("Create result.ts exporting result = 42.");
		expect(getToolResult(harness, "write").isError).toBe(false);
		expect(readFileSync(join(harness.tempDir, "result.ts"), "utf8")).toBe("export const result = 42;\n");
		expect(existsSync(join(harness.tempDir, ".relay", "specs"))).toBe(false);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("answers a question once without starting a task workflow", async () => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("The module exports result.")]);
		await harness.session.prompt("What does the module export?");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getAllTools().some((tool) => tool.name.startsWith("xp_"))).toBe(false);
		expect(harness.session.extensionRunner.getCommand("xp")).toBeUndefined();
	});

	it("completes a goal with the built-in extensions and no phase reports", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "42\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("update_goal", { status: "complete", report: "The requested file was written." }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Saved result.txt."),
		]);
		await harness.session.prompt("/goal Create result.txt containing 42.");
		await vi.waitFor(() => expect(harness.eventsOfType("agent_settled")).toHaveLength(1));
		expect(getToolResult(harness, "write").isError).toBe(false);
		expect(getToolResult(harness, "update_goal").isError).toBe(false);
		expect(readGoal(harness.sessionManager)?.status).toBe("complete");
		expect(readFileSync(join(harness.tempDir, "result.txt"), "utf8")).toBe("42\n");
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("ignores saved workflow state when continuing a session", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("xp.state", {
			version: 4,
			id: "previous-task",
			phase: "planning",
			status: "handoff",
			decisionError: "Laya unavailable",
		});
		const harness = await setup(sessionManager);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "resumed\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Saved result.txt."),
		]);
		await harness.session.prompt("Create result.txt containing resumed.");
		expect(getToolResult(harness, "write").isError).toBe(false);
		expect(readFileSync(join(harness.tempDir, "result.txt"), "utf8")).toBe("resumed\n");
		expect(harness.faux.state.callCount).toBe(2);
	});
});
