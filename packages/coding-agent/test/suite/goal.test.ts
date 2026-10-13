import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, getSystemMessageText } from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import goalExtension from "../../src/extensions/goal/index.ts";
import { GOAL_ENTRY, newGoal, readGoal } from "../../src/extensions/goal/state.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

const complete = () =>
	fauxAssistantMessage(
		fauxToolCall("update_goal", {
			status: "complete",
			report: "The targeted test passed; all requested criteria were verified.",
		}),
		{ stopReason: "toolUse" },
	);
const blocked = () =>
	fauxAssistantMessage(
		fauxToolCall("update_goal", {
			status: "blocked",
			report: "The fixture is missing. Tried the repository paths; need the fixture from the user.",
		}),
		{ stopReason: "toolUse" },
	);

describe("persistent goals", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup(
		goal = newGoal("Fix checkout, verify its test, preserve the API."),
		options: HarnessOptions = {},
	): Promise<Harness> {
		const sessionManager = options.sessionManager ?? SessionManager.inMemory();
		if (!options.sessionManager) sessionManager.appendCustomEntry(GOAL_ENTRY, goal);
		const harness = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [goalExtension],
			initialActiveToolNames: ["get_goal", "update_goal", "create_goal"],
			...options,
			sessionManager,
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("continues after a final answer and settles only after verified completion", async () => {
		const verify = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "Targeted test passed." }],
			details: {},
		}));
		const harness = await setup(undefined, {
			extensionFactories: [
				(relay) => {
					relay.on("agent_before_settle", (event) => ({
						entries: [...event.entries, { type: "custom", customType: "other-extension", data: "preserved" }],
					}));
				},
				goalExtension,
			],
			tools: [
				{
					name: "bash",
					label: "Verify",
					description: "Faux verification command",
					parameters: Type.Object({ command: Type.String() }),
					execute: verify,
				},
			],
			initialActiveToolNames: ["bash", "get_goal", "update_goal"],
		});
		const systems: string[] = [];
		harness.setResponses([
			(context) => {
				const system = getCurrentSystemMessage(context.messages);
				systems.push(system ? getSystemMessageText(system) : "");
				return fauxAssistantMessage("Investigated; next step is to fix the failing assertion.");
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("The goal is still active");
				return fauxAssistantMessage(fauxToolCall("bash", { command: "npm run check" }), { stopReason: "toolUse" });
			},
			complete(),
			fauxAssistantMessage("Verified completion."),
		]);
		await harness.session.prompt("Begin.");
		expect(systems[0]).toContain("preserve the API");
		expect(readGoal(harness.sessionManager)).toMatchObject({
			status: "complete",
			report: expect.stringContaining("targeted test passed"),
		});
		expect(verify).toHaveBeenCalledOnce();
		expect(harness.sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({ type: "custom", customType: "other-extension", data: "preserved" }),
		);
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("records a blocker and stops automatic continuation", async () => {
		const harness = await setup();
		harness.setResponses([blocked(), fauxAssistantMessage("Please provide the missing fixture.")]);
		await harness.session.prompt("Begin.");
		expect(readGoal(harness.sessionManager)?.status).toBe("blocked");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("enforces the token budget even inside a tool loop and prevents resuming an exhausted goal", async () => {
		const harness = await setup(newGoal("Investigate checkout.", 1));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("get_goal", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		await harness.session.prompt("Begin.");
		const goal = readGoal(harness.sessionManager);
		expect(goal?.status).toBe("budget_exhausted");
		expect(goal?.tokensUsed).toBeGreaterThan(1);
		expect(harness.faux.state.callCount).toBe(1);
		await harness.session.prompt("/goal resume");
		expect(readGoal(harness.sessionManager)?.status).toBe("budget_exhausted");
		expect(harness.faux.state.callCount).toBe(1);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("get_goal", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("An unrelated request is allowed."),
		]);
		await harness.session.prompt("Show the current goal state only.");
		expect(harness.faux.state.callCount).toBe(3);
		expect(readGoal(harness.sessionManager)?.tokensUsed).toBe(goal?.tokensUsed);
	});

	it("inspects, pauses, resumes, and clears through slash commands", async () => {
		const harness = await setup();
		const notify = vi.fn();
		harness.session.extensionRunner.setUIContext(createTestUiContext({ notify }));
		await harness.session.prompt("/goal");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Fix checkout"));
		await harness.session.prompt("/goal pause");
		expect(readGoal(harness.sessionManager)?.status).toBe("paused");
		harness.setResponses([blocked(), fauxAssistantMessage("Need fixture.")]);
		await harness.session.prompt("/goal resume");
		await vi.waitFor(() => expect(harness.eventsOfType("agent_settled")).toHaveLength(1));
		expect(readGoal(harness.sessionManager)?.status).toBe("blocked");
		await harness.session.prompt("/goal clear");
		expect(readGoal(harness.sessionManager)).toBeUndefined();
		expect(
			harness.sessionManager
				.getBranch()
				.findLast((entry) => entry.type === "custom" && entry.customType === GOAL_ENTRY),
		).toMatchObject({ data: null });
	});

	it("creates a goal with an optional explicit budget and rejects unfinished replacement", async () => {
		const harness = await setup(newGoal("Old goal."));
		await harness.session.prompt("/goal A different goal.");
		expect(readGoal(harness.sessionManager)?.objective).toBe("Old goal.");
		await harness.session.prompt("/goal clear");
		await harness.session.prompt("/goal --tokens 0 Invalid budget.");
		expect(readGoal(harness.sessionManager)).toBeUndefined();
		harness.setResponses([complete(), fauxAssistantMessage("Finished.")]);
		await harness.session.prompt("/goal --tokens 100000 Fix the checkout test.");
		await vi.waitFor(() => expect(harness.eventsOfType("agent_settled")).toHaveLength(1));
		expect(readGoal(harness.sessionManager)).toMatchObject({
			objective: "Fix the checkout test.",
			tokenBudget: 100000,
			status: "complete",
		});
	});

	it("rejects empty completion reports and cannot resume through the model tool", async () => {
		const harness = await setup({ ...newGoal("Paused task."), status: "paused" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "active", report: "Resume it." }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Goal remains paused."),
		]);
		await harness.session.prompt("Inspect the current state.");
		expect(getToolResult(harness, "update_goal").isError).toBe(true);
		expect(readGoal(harness.sessionManager)?.status).toBe("paused");
		harness.sessionManager.appendCustomEntry(GOAL_ENTRY, newGoal("Active task."));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete", report: "   " }), {
				stopReason: "toolUse",
			}),
			blocked(),
			fauxAssistantMessage("Need input."),
		]);
		await harness.session.prompt("Verify completion.");
		const results = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "update_goal",
		);
		expect(results[1]).toMatchObject({ isError: true });
		expect(readGoal(harness.sessionManager)?.status).toBe("blocked");
	});

	it.each(["aborted", "error"] as const)("pauses on a terminal %s response", async (stopReason) => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("Stopped.", { stopReason, errorMessage: "Terminal failure." })]);
		await harness.session.prompt("Begin.");
		expect(readGoal(harness.sessionManager)).toMatchObject({ status: "paused", report: "Terminal failure." });
		expect(harness.faux.state.callCount).toBe(1);
	});

	it.each(["pause", "clear"] as const)("handles /goal %s while a response is streaming", async (action) => {
		const harness = await setup();
		let entered = false;
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			async () => {
				entered = true;
				await pending;
				return fauxAssistantMessage("Interrupted response.");
			},
		]);
		const running = harness.session.prompt("Begin.");
		try {
			await vi.waitFor(() => expect(entered).toBe(true));
			await harness.session.prompt(`/goal ${action}`);
		} finally {
			release();
			await running;
		}
		expect(readGoal(harness.sessionManager)?.status).toBe(action === "pause" ? "paused" : undefined);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("creates goals through the model tool and makes their current state available next request", async () => {
		const harness = await setup(undefined, { sessionManager: SessionManager.inMemory() });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("create_goal", { objective: "Inspect checkout and report missing fixtures." }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const system = getCurrentSystemMessage(context.messages);
				expect(system && getSystemMessageText(system)).toContain("Inspect checkout and report missing fixtures.");
				return blocked();
			},
			fauxAssistantMessage("Please provide the fixture."),
		]);
		await harness.session.prompt("Create a goal to inspect checkout and report missing fixtures.");
		expect(readGoal(harness.sessionManager)).toMatchObject({
			status: "blocked",
			objective: "Inspect checkout and report missing fixtures.",
		});
		expect(readGoal(harness.sessionManager)?.tokenBudget).toBeUndefined();
		expect(getToolResult(harness, "create_goal").isError).toBe(false);
	});

	it("restores an active goal across runtime replacement and compacted context", async () => {
		const owner = await createHarness();
		harnesses.push(owner);
		const sessionManager = SessionManager.create(owner.tempDir, join(owner.tempDir, "sessions"));
		sessionManager.appendCustomEntry(GOAL_ENTRY, newGoal("Persistent objective."));
		sessionManager.appendMessage({ role: "user", content: "old context", timestamp: Date.now() });
		const old = sessionManager.appendMessage(fauxAssistantMessage("old response"));
		sessionManager.appendCompaction("summary", old, 100);
		const path = sessionManager.getSessionFile();
		if (!path) throw new Error("Missing persisted session.");
		const reopened = SessionManager.open(path);
		const harness = await setup(undefined, { sessionManager: reopened });
		harness.setResponses([
			(context) => {
				const system = getCurrentSystemMessage(context.messages);
				expect(system && getSystemMessageText(system)).toContain("Persistent objective");
				return complete();
			},
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Continue.");
		expect(readGoal(SessionManager.open(path))?.status).toBe("complete");
	});

	it("pauses restored goals when tool restrictions prevent lifecycle updates", async () => {
		const harness = await setup(undefined, { excludedToolNames: ["update_goal"] });
		expect(readGoal(harness.sessionManager)?.status).toBe("paused");
		harness.setResponses([fauxAssistantMessage("Inspected.")]);
		await harness.session.prompt("Inspect the state.");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("does not inherit goals from a different session or an unrelated tree branch", async () => {
		const harness = await setup();
		const root = harness.sessionManager.getBranch()[0];
		if (!root) throw new Error("Missing goal entry.");
		harness.sessionManager.appendCustomEntry(GOAL_ENTRY, { ...newGoal("Other branch."), status: "paused" });
		harness.sessionManager.branch(root.id);
		expect(readGoal(harness.sessionManager)?.objective).toContain("Fix checkout");
		expect(readGoal(SessionManager.inMemory())).toBeUndefined();
	});

	it("runs ordinary prompts once when no goal exists", async () => {
		const harness = await setup(undefined, { sessionManager: SessionManager.inMemory() });
		harness.setResponses([fauxAssistantMessage("Explained.")]);
		await harness.session.prompt("Explain checkout.");
		expect(harness.faux.state.callCount).toBe(1);
		expect(readGoal(harness.sessionManager)).toBeUndefined();
	});
});
