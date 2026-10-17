import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@relay-harness/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import * as checkpoint from "../../src/extensions/delegation/checkpoint.ts";
import { WORK_STATE_ENTRY } from "../../src/extensions/delegation/state.ts";
import goalExtension from "../../src/extensions/goal/index.ts";
import { GOAL_ENTRY, newGoal, readGoal } from "../../src/extensions/goal/state.ts";
import {
	call,
	createDelegationHarness,
	latest,
	runDelegationRecovery,
	runDelegationScenario,
	scriptedClassification,
	tasks,
} from "../delegation-integration-support.ts";
import { delegationTestHealth, delegationTestProvider } from "../delegation-test-support.ts";
import { getToolResult, type Harness } from "./harness.ts";

describe("delegation without XP", () => {
	const harnesses: Harness[] = [];
	const sessionDirectories: string[] = [];
	beforeEach(() =>
		vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response(JSON.stringify(delegationTestHealth()))),
	);
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const directory of sessionDirectories.splice(0))
			rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

	it("awaits an in-flight write observation before stop returns and preserves its effect once", async () => {
		let observed = false;
		let release = () => {};
		const observation = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createDelegationHarness(true, scriptedClassification, undefined, (relay) => {
			delegationTestProvider(scriptedClassification)(relay);
			relay.on("tool_result", async (event) => {
				if (event.toolName !== "write") return;
				observed = true;
				await observation;
			});
		});
		harnesses.push(harness);
		harness.setResponses([
			call("propose_work", {
				tasks: tasks()
					.filter((task) => task.taskId === "implement")
					.map((task) => ({ ...task, dependencies: [] })),
			}),
			call("execute_work", { taskIds: ["implement"] }),
			call("write", { path: "result.txt", content: "42\n" }),
			fauxAssistantMessage("Worker stopped after its write."),
			fauxAssistantMessage("Stopped."),
		]);
		const running = harness.session.prompt("Save the integrated output.");
		let stopped = false;
		let stopping: Promise<void> | undefined;
		try {
			await vi.waitFor(() => expect(observed).toBe(true));
			stopping = harness.session.prompt("/work stop").then(() => {
				stopped = true;
			});
			await vi.waitFor(() => expect(latest(harness).delegation?.cancelled).toBe(true));
			await setImmediate();
			expect(stopped).toBe(false);
			expect(readFileSync(join(harness.tempDir, "result.txt"), "utf8")).toBe("42\n");
		} finally {
			release();
			await stopping;
			await running;
		}
		expect(stopped).toBe(true);
		expect(latest(harness).status).toBe("stopped");
		const delegated = latest(harness).delegation;
		expect(delegated?.runs).toHaveLength(1);
		expect(delegated?.runs[0].status).toBe("cancelled");
		expect(delegated?.runs[0].metrics).toBeDefined();
		expect(delegated?.runs[0].result).toBeUndefined();
		expect(delegated?.evidence.filter((item) => item.tool === "write")).toHaveLength(1);
		expect(harness.eventsOfType("tool_execution_start").filter((event) => event.toolName === "write")).toHaveLength(
			1,
		);
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

	it.each([
		"---\ntools: [read, write, bash]\n---\nChanged profile instructions.\n",
		"---\ntools: [read]\n---\nComplete the assigned task using observed inputs.\n",
	])("rejects changed approved profile resources even when the workspace ignores them: %s", async (content) => {
		const harness = await setup();
		writeFileSync(join(harness.tempDir, ".ignore"), ".relay/agents/\n");
		harness.setResponses([
			call("propose_work", { tasks: tasks() }),
			() => {
				writeFileSync(join(harness.tempDir, ".relay", "agents", "backend-engineer.md"), content);
				return call("execute_work", { taskIds: ["api", "ui"] });
			},
			fauxAssistantMessage("A fresh proposal is required.", { stopReason: "error" }),
		]);
		await harness.session.prompt("Investigate the API and UI using the approved resources.");
		expect(getToolResult(harness, "execute_work")).toMatchObject({
			isError: true,
			content: [{ text: expect.stringContaining("Resources changed since Laya approval") }],
		});
		expect(latest(harness).delegation?.plan).toBeUndefined();
		expect(latest(harness).delegation?.runs).toEqual([]);
		expect(harness.eventsOfType("tool_execution_start").filter((event) => event.toolName === "read")).toEqual([]);
	});

	it("requires a new proposal when configured limits change before execution", async () => {
		const harness = await setup();
		harness.setResponses([
			call("propose_work", { tasks: tasks() }),
			() => {
				harness.settingsManager.applyOverrides({ delegation: { maxConcurrent: 1 } });
				return call("execute_work", { taskIds: ["api", "ui"] });
			},
			fauxAssistantMessage("Limits changed.", { stopReason: "error" }),
		]);
		await harness.session.prompt("Investigate independent failures.");
		expect(getToolResult(harness, "execute_work").isError).toBe(true);
		expect(latest(harness).delegation?.plan).toBeUndefined();
		expect(latest(harness).delegation?.runs).toEqual([]);
	});

	it("invalidates accepted results if the pinned checkpoint changes before final completion", async () => {
		const harness = await setup();
		const original = checkpoint.delegationCheckpoint();
		harness.setResponses([
			call("propose_work", { tasks: tasks().filter((task) => task.taskId === "api") }),
			call("execute_work", { taskIds: ["api"] }),
			call("read", { path: "input.txt" }),
			fauxAssistantMessage("Observed the input."),
			call("review_work", { taskId: "api", accepted: true, reason: "Observed evidence satisfies the criteria" }),
			() => {
				vi.spyOn(checkpoint, "delegationCheckpoint").mockReturnValue({
					...original,
					artifactSha256: "0".repeat(64),
				});
				return call("complete_work", { summary: "Obsolete approval", evidenceIds: [] });
			},
			fauxAssistantMessage("The checkpoint changed.", { stopReason: "error" }),
		]);
		await harness.session.prompt("Inspect API inputs using the pinned classifier.");
		expect(getToolResult(harness, "review_work").isError).toBe(false);
		expect(getToolResult(harness, "complete_work")).toMatchObject({
			isError: true,
			content: [{ text: expect.stringContaining("approved Laya checkpoint changed") }],
		});
		expect(latest(harness).delegation?.plan).toBeUndefined();
		expect(latest(harness).delegation?.runs[0].result).toMatchObject({ accepted: false, stale: true });
	});

	it("completes a persistent goal only after its delegated plan has been completed", async () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(GOAL_ENTRY, newGoal("Inspect API inputs and deliver observed findings."));
		const harness = await createDelegationHarness(true, scriptedClassification, manager, (relay) => {
			delegationTestProvider(scriptedClassification)(relay);
			goalExtension(relay);
		});
		harnesses.push(harness);
		harness.setResponses([
			call("propose_work", { tasks: tasks().filter((task) => task.taskId === "api") }),
			call("update_goal", { status: "complete", report: "Premature completion" }, "premature-goal"),
			call("execute_work", { taskIds: ["api"] }),
			call("read", { path: "input.txt" }),
			fauxAssistantMessage("Observed the required input."),
			call("review_work", { taskId: "api", accepted: true, reason: "Input evidence satisfies the criterion" }),
			call("complete_work", { summary: "Delivered observed findings", evidenceIds: [] }),
			call("update_goal", { status: "complete", report: "The delegated findings were reviewed and delivered." }),
			fauxAssistantMessage("Delivered."),
		]);
		await harness.session.prompt("Continue the goal using a bounded API investigation.");
		expect(
			harness.session.messages.find((item) => item.role === "toolResult" && item.toolCallId === "premature-goal"),
		).toMatchObject({
			isError: true,
			content: [{ text: expect.stringContaining("before completing the goal") }],
		});
		expect(latest(harness).status).toBe("completed");
		expect(getToolResult(harness, "update_goal").isError).toBe(false);
		expect(readGoal(manager)?.status).toBe("complete");
	});

	it.each(["direct", "hardlink"] as const)(
		"protects a persisted principal history from worker writes through its %s path",
		async (kind) => {
			const directory = mkdtempSync(join(tmpdir(), "relay-delegation-history-"));
			sessionDirectories.push(directory);
			const history = join(directory, "principal.jsonl");
			writeFileSync(history, "");
			const manager = SessionManager.open(history, directory, directory);
			const harness = await setup(true, scriptedClassification, manager);
			const target = join(harness.tempDir, "principal-history.jsonl");
			if (kind === "hardlink") linkSync(history, target);
			else {
				writeFileSync(target, "");
				manager.setSessionFile(target);
			}
			harness.setResponses([
				call("propose_work", {
					tasks: tasks()
						.filter((task) => task.taskId === "implement")
						.map((task) => ({ ...task, dependencies: [] })),
				}),
				call("execute_work", { taskIds: ["implement"] }),
				call("write", { path: "principal-history.jsonl", content: "Replace the principal history" }),
				fauxAssistantMessage("History write was rejected."),
				fauxAssistantMessage("Inspect the worker limitation.", { stopReason: "error" }),
			]);
			await harness.session.prompt("Save the integrated output while preserving runtime histories.");
			expect(getToolResult(harness, "propose_work").isError).toBe(false);
			expect(getToolResult(harness, "execute_work").isError).toBe(false);
			expect(latest(harness).delegation?.runs[0].result?.evidence).toMatchObject([
				{ tool: "write", isError: true, text: expect.stringContaining("principal session history") },
			]);
			expect(harness.eventsOfType("tool_execution_start").filter((event) => event.toolName === "write")).toEqual([]);
			const persisted = readFileSync(manager.getSessionFile()!, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type: string });
			expect(persisted[0].type).toBe("session");
			expect(persisted.some((entry) => entry.type === "message")).toBe(true);
		},
	);

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
