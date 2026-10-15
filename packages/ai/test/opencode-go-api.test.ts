import { describe, expect, it, vi } from "vitest";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const { stream } = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("../src/api/google-generative-ai.lazy.ts", () => ({
	googleGenerativeAIApi: () => ({ stream, streamSimple: stream }),
}));

describe("OpenCode Go API routing", () => {
	// Regression for the CI failure in PR #65 after upstream catalog regeneration.
	it("routes Google models through the Google API with the session header", () => {
		const model: Model<"google-generative-ai"> = {
			id: "test-google-model",
			name: "Test Google model",
			api: "google-generative-ai",
			provider: "opencode-go",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const context = normalizeContext({ messages: [] });
		opencodeGoProvider().stream(model, context, { sessionId: "test-session" });
		expect(stream).toHaveBeenCalledWith(model, context, {
			sessionId: "test-session",
			headers: { "x-opencode-session": "test-session" },
		});
	});
});
