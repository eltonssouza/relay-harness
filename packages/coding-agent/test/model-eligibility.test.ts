import { fauxAssistantMessage, fauxProvider, InMemoryModelsStore } from "@relay-harness/ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { isEligibleChatModel } from "../src/core/model-eligibility.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const claudeModels = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
const codexModels = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra"];
const oldClaudeModels = [
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-haiku-4-5",
	"claude-sonnet-5",
	"claude-opus-4-8",
];
const oldCodexModels = ["gpt-5.5", "gpt-5.4", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-sol-max"];

async function setup(provider: string, ids: string[]) {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider, models: ids.map((id) => ({ id })) });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	return { runtime, faux };
}

const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };

describe("current chat model policy", () => {
	it.each(claudeModels)("allows the current Claude model %s", (id) => {
		expect(isEligibleChatModel("anthropic", id)).toBe(true);
		expect(isEligibleChatModel("github-copilot", id.replace("5-5", "5.5"))).toBe(true);
		expect(isEligibleChatModel("google-antigravity", `${id}-high`)).toBe(true);
		expect(isEligibleChatModel("openrouter", `anthropic/${id}`)).toBe(true);
		expect(isEligibleChatModel("amazon-bedrock", `us.anthropic.${id}-v1:0`)).toBe(true);
	});

	it.each([...oldClaudeModels, "claude-fable-5.5", "claude-sonnet-5-50"])(
		"rejects Claude %s across providers and gateways",
		(id) => {
			for (const provider of ["anthropic", "github-copilot", "custom"]) {
				expect(isEligibleChatModel(provider, id)).toBe(false);
			}
			expect(isEligibleChatModel("openrouter", `anthropic/${id}`)).toBe(false);
			expect(isEligibleChatModel("amazon-bedrock", `us.anthropic.${id}-v1:0`)).toBe(false);
		},
	);

	it.each(codexModels)("allows Codex %s", (id) => {
		expect(isEligibleChatModel("openai-codex", id)).toBe(true);
	});
	it.each(oldCodexModels)("rejects legacy Codex %s without restricting OpenAI API or Copilot", (id) => {
		expect(isEligibleChatModel("openai-codex", id)).toBe(false);
		expect(isEligibleChatModel("openai", id)).toBe(true);
		expect(isEligibleChatModel("github-copilot", id)).toBe(true);
	});
	it("does not restrict other model families", () => {
		expect(isEligibleChatModel("local", "qwen2.5-coder")).toBe(true);
		expect(isEligibleChatModel("google", "gemini-3.5-pro")).toBe(true);
		expect(isEligibleChatModel("laya", "auto")).toBe(true);
	});
});

describe("ModelRuntime model policy integration", () => {
	it.each([
		{ provider: "anthropic", current: claudeModels, old: oldClaudeModels },
		{ provider: "openai-codex", current: codexModels, old: oldCodexModels },
	])("filters every catalog and availability interface for $provider", async ({ provider, current, old }) => {
		const { runtime } = await setup(provider, [...current, ...old]);
		const ids = (models: readonly { id: string }[]) => models.map((model) => model.id).sort();
		const expected = [...current].sort();
		expect(ids(runtime.getModels(provider))).toEqual(expected);
		expect(ids(runtime.getModelsOfType("chat", provider))).toEqual(expected);
		expect(ids(runtime.getAllModels(provider))).toEqual(expected);
		expect(ids(await runtime.getAvailable(provider))).toEqual(expected);
		expect(ids(await runtime.getAvailableOfType("chat", provider))).toEqual(expected);
		expect(ids(await runtime.getAllAvailable(provider))).toEqual(expected);
		expect(ids(runtime.getAvailableSnapshot().filter((model) => model.provider === provider))).toEqual(expected);
		for (const id of old) {
			expect(runtime.getModel(provider, id)).toBeUndefined();
			expect(runtime.getModelOfType("chat", provider, id)).toBeUndefined();
			expect(runtime.getPhysicalModel(provider, id)).toBeUndefined();
		}
		for (const id of current) expect(runtime.getModel(provider, id)?.id).toBe(id);
	});

	it.each([
		{ provider: "anthropic", id: "claude-fable-5-1" },
		{ provider: "anthropic", id: "claude-sonnet-5" },
		{ provider: "openai-codex", id: "gpt-5.5" },
	])(
		"blocks direct requests for $provider/$id before dispatch, including untyped legacy models",
		async ({ provider, id }) => {
			const { runtime, faux } = await setup(provider, [id]);
			faux.setResponses([fauxAssistantMessage("must not dispatch")]);
			const { type: _type, ...untyped } = faux.models[0];
			for (const model of [faux.models[0], untyped]) {
				const result = await runtime.complete(model, context);
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toContain("not permitted by the current model policy");
			}
			expect(faux.state.callCount).toBe(0);
		},
	);

	it("rejects virtual routes to a prohibited model", async () => {
		const { runtime, faux } = await setup("anthropic", ["claude-fable-5-1"]);
		runtime.registerVirtualModel({
			provider: "laya",
			id: "auto",
			name: "Laya Auto",
			route: () => ({ model: faux.models[0], thinkingLevel: "off" }),
		});
		const model = runtime.getModel("laya", "auto")!;
		await expect(runtime.resolveModel(model, [], { reason: "user", thinkingLevel: "off" })).rejects.toThrow(
			"not a physical model",
		);
		expect(faux.state.callCount).toBe(0);
	});

	it("does not silently replace a prohibited saved default", async () => {
		const { runtime, faux } = await setup("anthropic", ["claude-haiku-5-5", "claude-fable-5-1"]);
		await expect(
			findInitialModel({
				scopedModels: [],
				isContinuing: false,
				defaultProvider: "anthropic",
				defaultModelId: "claude-fable-5-1",
				modelRuntime: runtime,
			}),
		).rejects.toThrow("not permitted by the current model policy");
		expect(faux.state.callCount).toBe(0);
	});

	it("still dispatches current models normally", async () => {
		const { runtime, faux } = await setup("anthropic", ["claude-haiku-5-5"]);
		faux.setResponses([fauxAssistantMessage("allowed")]);
		const result = await runtime.complete(runtime.getModel("anthropic", "claude-haiku-5-5")!, context);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "allowed" }]);
		expect(faux.state.callCount).toBe(1);
	});
});
