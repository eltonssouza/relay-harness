import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@relay-harness/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionManager } from "../../src/core/session-manager.ts";
import { WORK_STATE_ENTRY } from "../../src/extensions/delegation/state.ts";
import {
	call,
	createDelegationHarness,
	latest,
	runDelegationRecovery,
	runDelegationScenario,
	scriptedClassification,
	tasks,
} from "../delegation-integration-support.ts";
import { delegationTestHealth } from "../delegation-test-support.ts";
import { getToolResult, type Harness } from "./harness.ts";

describe("delegation without XP", () => {
	const harnesses: Harness[] = [];
	beforeEach(() =>
		vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response(JSON.stringify(delegationTestHealth()))),
	);
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});
	async function setup(enabled = true, override = scriptedClassification, sessionManager?: SessionManager) {
		const harness = await createDelegationHarness(enabled, override, sessionManager);
		harnesses.push(harness);
		return harness;
	}

	it("runs parallel investigations, accepted dependencies, mutation and final tests with isolated SDK workers", async () => {
		await runDelegationScenario(await setup());
	});

	it("preserves a proposal without starting workers when the classifier remains uncertain", async () => {
		const harness = await setup(true, (context, result) => {
			const selected = scriptedClassification(context, result);
			if (context.questions.work_mode)
				selected.answers.work_mode = {
					type: "choice",
					choice: "delegated",
					confidence: 0.5,
					probabilities: { delegated: 0.5 },
				};
			return selected;
		});
		harness.setResponses([call("propose_work", { tasks: tasks() }), fauxAssistantMessage("Decision unavailable.")]);
		await harness.session.prompt("Investigate the API and UI.");
		expect(latest(harness)).toMatchObject({ status: "handoff", delegation: { runs: [], proposal: { version: 1 } } });
		expect(latest(harness).delegation?.plan).toBeUndefined();
		expect(getToolResult(harness, "propose_work").isError).toBe(true);
	});

	it("reconciles an interrupted write after session restoration without repeating it", async () => {
		await runDelegationRecovery(await setup());
	});

	it("rejects formerly successful tests after a later principal write", async () => {
		const harness = await setup();
		const proposed = tasks()
			.filter((task) => task.taskId === "implement")
			.map((task) => ({ ...task, dependencies: [] }));
		harness.setResponses([
			call("propose_work", { tasks: proposed }),
			call("execute_work", { taskIds: ["implement"] }),
			call("write", { path: "result.txt", content: "42\n" }),
			fauxAssistantMessage("Saved."),
			call("review_work", { taskId: "implement", accepted: true, reason: "Observed write meets the criteria" }),
			call("bash", { command: "node --test result.test.mjs" }, "old-tests"),
			call("write", { path: "result.txt", content: "42\n" }),
			call("complete_work", { summary: "Stale verification", evidenceIds: ["old-tests"] }, "stale-completion"),
			call("bash", { command: "node --test result.test.mjs" }, "fresh-tests"),
			call("complete_work", { summary: "Final workspace verified", evidenceIds: ["fresh-tests"] }),
			fauxAssistantMessage("Delivered."),
		]);
		await harness.session.prompt("Save the agreed result and verify the final workspace.");
		expect(latest(harness).status).toBe("completed");
		expect(
			harness.session.messages.find((item) => item.role === "toolResult" && item.toolCallId === "stale-completion"),
		).toMatchObject({
			isError: true,
			content: [{ text: expect.stringContaining("Final successful test evidence") }],
		});
		expect(getToolResult(harness, "complete_work").isError).toBe(false);
	});

	it("cancels active workers through /work stop and does not execute their pending writes", async () => {
		const harness = await setup();
		let entered = false;
		let release = () => {};
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const proposed = tasks()
			.filter((task) => task.taskId === "implement")
			.map((task) => ({ ...task, dependencies: [] }));
		harness.setResponses([
			call("propose_work", { tasks: proposed }),
			call("execute_work", { taskIds: ["implement"] }),
			async () => {
				entered = true;
				await waiting;
				return call("write", { path: "result.txt", content: "must not run" });
			},
			fauxAssistantMessage("Stopped."),
		]);
		const running = harness.session.prompt("Save the integrated result.");
		try {
			await vi.waitFor(() => expect(entered).toBe(true));
			const stopping = harness.session.prompt("/work stop");
			await vi.waitFor(() => expect(latest(harness).delegation?.cancelled).toBe(true));
			release();
			await stopping;
		} finally {
			release();
			await running;
		}
		expect(latest(harness).status).toBe("stopped");
		expect(harness.eventsOfType("tool_execution_start").filter((event) => event.toolName === "write")).toEqual([]);
		expect(latest(harness).delegation?.runs[0].status).toBe("cancelled");
	});

	it("invalidates restored approvals after an external workspace edit", async () => {
		const harness = await setup();
		harness.setResponses([
			call("propose_work", { tasks: tasks() }),
			fauxAssistantMessage("Interrupted", { stopReason: "error" }),
		]);
		await harness.session.prompt("Investigate the API and UI.");
		writeFileSync(join(harness.tempDir, "input.txt"), "changed externally\n");
		await harness.session.bindExtensions({});
		expect(latest(harness).status).toBe("handoff");
		expect(latest(harness).delegation?.plan).toBeUndefined();
		harness.setResponses([
			call("execute_work", { taskIds: ["api"] }),
			fauxAssistantMessage("A fresh decision is required."),
		]);
		await harness.session.prompt("Inspect the current plan.");
		expect(getToolResult(harness, "execute_work").isError).toBe(true);
		expect(latest(harness).delegation?.runs).toEqual([]);
	});

	it("keeps production activation gated while ordinary tools remain usable", async () => {
		const harness = await setup(false);
		harness.setResponses([
			call("propose_work", { tasks: tasks() }),
			call("write", { path: "result.txt", content: "direct\n" }),
			fauxAssistantMessage("Saved directly."),
		]);
		await harness.session.prompt("Save the result.");
		expect(getToolResult(harness, "propose_work").isError).toBe(true);
		expect(getToolResult(harness, "write").isError).toBe(false);
		expect(
			harness.sessionManager
				.getBranch()
				.some((item) => item.type === "custom" && item.customType === WORK_STATE_ENTRY),
		).toBe(false);
	});
});
