import { describe, expect, it } from "vitest";
import { scopedModelRegistry } from "../src/extensions/laya/provider-scope.ts";

describe("Laya frontier models", () => {
	it("retains Astra and Sol within the selected Codex provider", () => {
		const { registry } = scopedModelRegistry(
			{ followProvider: true },
			{ provider: "openai-codex", id: "gpt-6-astra" },
		);
		expect(registry.frontier).toEqual(["openai-codex/gpt-6.1-sol", "openai-codex/gpt-6-astra"]);
	});

	it("retains both Fable generations within the selected Anthropic provider", () => {
		const { registry } = scopedModelRegistry(
			{ followProvider: true },
			{ provider: "anthropic", id: "claude-fable-5" },
		);
		expect(registry.frontier).toEqual(["anthropic/claude-fable-5-1", "anthropic/claude-fable-5"]);
	});

	it("does not leak cloud models into an explicitly mapped local group", () => {
		const { registry } = scopedModelRegistry(
			{
				followProvider: true,
				modelGroups: { "local-qwen": { balanced: ["lmstudio/qwen/qwen3.8-27b"] } },
			},
			{ provider: "lmstudio", id: "qwen/qwen3.8-27b" },
		);
		expect(registry.balanced).toEqual(["lmstudio/qwen/qwen3.8-27b"]);
		expect(registry.frontier).toEqual([]);
	});
});
