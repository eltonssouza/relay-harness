import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import ollamaExtension, { discoverOllamaModels, ollamaUrl } from "../src/extensions/ollama/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function mockDaemon(names: unknown[] = [{ name: "small:latest" }]) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.pathname === "/api/tags") return Response.json({ models: names });
		if (url.pathname === "/api/show") {
			const { model } = JSON.parse(String(init?.body));
			return Response.json({
				capabilities: model === "embed:latest" ? ["embedding"] : ["completion", "tools", "vision"],
				model_info: { "test.context_length": 32768 },
			});
		}
		if (url.pathname === "/v1/chat/completions") {
			return new Response(
				'data: {"id":"local","object":"chat.completion.chunk","created":1,"model":"small:latest","choices":[{"index":0,"delta":{"role":"assistant","content":"Local answer"},"finish_reason":null}]}\n\ndata: {"id":"local","object":"chat.completion.chunk","created":1,"model":"small:latest","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}
		throw new Error(`Unexpected request: ${url.origin}${url.pathname}`);
	});
}

describe("local Ollama discovery", () => {
	it("normalizes OLLAMA_HOST without scanning or starting a process", () => {
		expect(ollamaUrl("").href).toBe("http://127.0.0.1:11434/");
		expect(ollamaUrl("localhost:12345").href).toBe("http://localhost:12345/");
		expect(ollamaUrl("http://0.0.0.0:12345").href).toBe("http://127.0.0.1:12345/");
		expect(ollamaUrl("http://[::]:12345").href).toBe("http://127.0.0.1:12345/");
		expect(() => ollamaUrl("file:///tmp/ollama")).toThrow("HTTP");
		expect(() => ollamaUrl("http://secret:password@localhost:11434")).toThrow("credentials");
	});

	it("lists installed tags, deduplicates and uses real capabilities", async () => {
		const fetch = mockDaemon([
			{ name: "small:latest" },
			{ name: "small:latest" },
			{ name: "embed:latest" },
			{},
			{ name: "" },
		]);
		vi.stubGlobal("fetch", fetch);
		const catalog = await discoverOllamaModels(ollamaUrl("localhost:11435"));
		expect(catalog.installed).toEqual(["small:latest", "embed:latest"]);
		expect(catalog.models).toEqual([
			expect.objectContaining({ id: "small:latest", input: ["text", "image"], contextWindow: 32768 }),
		]);
		expect(fetch).toHaveBeenCalledTimes(3);
		for (const [input] of fetch.mock.calls) expect(new URL(String(input)).origin).toBe("http://localhost:11435");
	});

	it.each([new Response("unavailable", { status: 503 }), Response.json({ unexpected: true })])(
		"does not advertise fabricated models on discovery errors",
		async (response) => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
			const catalog = await discoverOllamaModels(ollamaUrl("localhost:11434"));
			expect(catalog.models).toEqual([]);
			expect(catalog.error).toBeDefined();
		},
	);

	it("an unavailable daemon does not break other providers", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
		expect(await discoverOllamaModels(ollamaUrl("localhost:11434"))).toMatchObject({
			models: [],
			error: expect.stringContaining("failed"),
		});
	});

	it("propagates cancellation instead of publishing a successful empty refresh", async () => {
		const abort = new AbortController();
		abort.abort();
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort.signal.reason));
		await expect(discoverOllamaModels(ollamaUrl("localhost:11434"), abort.signal)).rejects.toBeDefined();
	});

	it("registers, selects and streams an installed model through the configured local endpoint", async () => {
		vi.stubEnv("OLLAMA_HOST", "127.0.0.1:11435");
		const fetch = mockDaemon();
		vi.stubGlobal("fetch", fetch);
		let registry!: ModelRegistry;
		harness = await createHarness({
			extensionFactories: [
				ollamaExtension,
				(relay) => {
					relay.on("session_start", (_event, ctx) => {
						registry = ctx.modelRegistry;
					});
				},
			],
			settings: { harnessCore: { evidence: false } },
		});
		await harness.session.bindExtensions({});
		await registry.refresh({ providers: ["ollama"], allowNetwork: true, force: true });
		const model = registry.find("ollama", "small:latest");
		expect(model).toBeDefined();
		if (!model) throw new Error("Installed Ollama model missing");
		await harness.session.setModel(model);
		await harness.session.prompt("Hello");
		expect(
			harness
				.eventsOfType("message_end")
				.some(
					(event) =>
						event.message.role === "assistant" &&
						event.message.content.some((block) => block.type === "text" && block.text === "Local answer"),
				),
		).toBe(true);
		const request = fetch.mock.calls.find(([input]) => String(input).endsWith("/v1/chat/completions"));
		expect(request).toBeDefined();
		expect(JSON.parse(String(request?.[1]?.body)).model).toBe("small:latest");
		expect(String(request?.[0])).toBe("http://127.0.0.1:11435/v1/chat/completions");
	});
});
