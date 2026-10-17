import { fauxAssistantMessage } from "@relay-harness/ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { resolveCliModel } from "../../src/core/model-resolver.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

describe("model policy session boundaries", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];

	afterEach(() => {
		while (sessions.length) sessions.pop()?.dispose();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function setup() {
		const harness = await createHarness({
			models: [{ id: "claude-haiku-5-5" }, { id: "claude-fable-5" }, { id: "claude-sonnet-4-5" }],
		});
		harnesses.push(harness);
		return harness;
	}

	it.each(["claude-fable-5", "claude-sonnet-4-5"])(
		"rejects manual %s without altering selection, then executes a current model",
		async (id) => {
			const harness = await setup();
			let providerCalls = 0;
			harness.setResponses([
				() => {
					providerCalls++;
					return fauxAssistantMessage("allowed response");
				},
			]);
			await expect(harness.session.setModel(harness.getModel(id)!, { persist: true })).rejects.toThrow(
				"not permitted by the current model policy",
			);
			expect(harness.session.model?.id).toBe("claude-haiku-5-5");
			expect(harness.settingsManager.getDefaultModel()).toBeUndefined();
			expect(
				harness.sessionManager.getBranch().some((entry) => entry.type === "model_change" && entry.modelId === id),
			).toBe(false);
			expect(providerCalls).toBe(0);
			await harness.session.prompt("hello");
			expect(providerCalls).toBe(1);
			expect(getAssistantTexts(harness)).toEqual(["allowed response"]);
		},
	);

	it("does not create a prohibited custom model through CLI fallback", async () => {
		const harness = await setup();
		const result = await resolveCliModel({
			cliProvider: harness.getModel().provider,
			cliModel: "claude-opus-4-8",
			modelRuntime: harness.session.modelRuntime,
		});
		expect(result.model).toBeUndefined();
		expect(result.error).toBeDefined();
	});

	it.each(["explicit", "resume"])("rejects SDK %s selection without silently substituting", async (source) => {
		const harness = await setup();
		const prohibited = harness.getModel("claude-fable-5")!;
		const sessionManager = SessionManager.inMemory();
		if (source === "resume") {
			sessionManager.appendModelChange(prohibited.provider, prohibited.id);
			sessionManager.appendMessage({ role: "user", content: "old input", timestamp: 0 });
		}
		const result = createAgentSession({
			cwd: harness.tempDir,
			model: source === "explicit" ? prohibited : undefined,
			modelRuntime: harness.session.modelRuntime,
			sessionManager,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader(),
		}).then((result) => {
			sessions.push(result.session);
			return "session created";
		});
		await expect(result).rejects.toThrow("not permitted by the current model policy");
	});
});
