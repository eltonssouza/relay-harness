import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../src/api/google-antigravity.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { googleAntigravityOAuth } from "../src/auth/oauth/google-antigravity.ts";
import type { AuthEvent, OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { builtinProviders } from "../src/providers/all.ts";
import { googleAntigravityProvider } from "../src/providers/google-antigravity.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const nativeFetch = globalThis.fetch;
const signal = new AbortController().signal;
const credential: OAuthCredential = {
	type: "oauth",
	access: "access-token",
	refresh: "refresh-token",
	expires: Date.now() + 3_600_000,
	projectId: "account-project",
	baseUrl: "https://cloudcode-pa.googleapis.com",
};
const model: Model<"google-generative-ai"> = {
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google-antigravity",
	baseUrl: "",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1_048_576,
	maxTokens: 32768,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function manualLogin(input?: (url: URL) => string): ProviderAuthInteraction {
	let url: URL;
	return {
		signal,
		notify(event) {
			if (event.type === "auth_url") url = new URL(event.url);
		},
		async prompt() {
			if (input) return input(url);
			const redirect = new URL(url.searchParams.get("redirect_uri")!);
			redirect.searchParams.set("code", "manual-code");
			redirect.searchParams.set("state", url.searchParams.get("state")!);
			return redirect.toString();
		},
	};
}

describe.sequential("Google Antigravity", () => {
	beforeEach(() => {
		vi.stubEnv("RELAY_AI_ANTIGRAVITY_CLIENT_ID", "test-client-id");
		vi.stubEnv("RELAY_AI_ANTIGRAVITY_CLIENT_SECRET", "test-client-secret");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("registers the OAuth provider in the built-in login list", () => {
		const provider = builtinProviders().find((entry) => entry.id === "google-antigravity");
		expect(provider?.auth.oauth?.loginLabel).toBe("Sign in with Google Antigravity");
		expect(provider?.auth.apiKey).toBeUndefined();
	});

	it("logs in through a callback with PKCE and discovers the account project", async () => {
		let exchange: URLSearchParams | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				if (String(input) === "https://oauth2.googleapis.com/token") {
					exchange = new URLSearchParams(String(init?.body));
					return json({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
				}
				return json({ cloudaicompanionProject: { id: "account-project" } });
			}),
		);
		let authorize: URL | undefined;
		let callback: Promise<Response> | undefined;
		let promptSignal: AbortSignal | undefined;
		const result = await googleAntigravityOAuth.login({
			signal,
			prompt(prompt) {
				promptSignal = prompt.signal;
				return new Promise<string>(() => {});
			},
			notify(event) {
				if (event.type !== "auth_url") return;
				authorize = new URL(event.url);
				const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
				redirect.searchParams.set("state", authorize.searchParams.get("state")!);
				redirect.searchParams.set("code", "browser-code");
				callback = nativeFetch(redirect);
			},
		});
		expect((await callback)?.status).toBe(200);
		expect(promptSignal?.aborted).toBe(true);
		expect(result).toMatchObject({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			projectId: "account-project",
		});
		expect(authorize?.origin).toBe("https://accounts.google.com");
		expect(authorize?.searchParams.get("client_id")).toBe("test-client-id");
		expect(authorize?.searchParams.get("access_type")).toBe("offline");
		expect(exchange?.get("code")).toBe("browser-code");
		expect(exchange?.get("client_id")).toBe("test-client-id");
		expect(exchange?.get("client_secret")).toBe("test-client-secret");
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(exchange?.get("code_verifier") ?? ""),
		);
		expect(authorize?.searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
	});

	it("requires a locally configured OAuth client", async () => {
		vi.stubEnv("RELAY_AI_ANTIGRAVITY_CLIENT_ID", "");
		vi.stubEnv("RELAY_AI_ANTIGRAVITY_CLIENT_SECRET", "");
		await expect(googleAntigravityOAuth.login(manualLogin())).rejects.toThrow(
			"RELAY_AI_ANTIGRAVITY_CLIENT_ID and RELAY_AI_ANTIGRAVITY_CLIENT_SECRET",
		);
	});

	it("accepts a manual redirect and falls back to the production project endpoint", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			if (String(input).includes("oauth2.googleapis.com"))
				return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
			if (String(input).includes("daily-cloudcode")) return json({}, 403);
			return json({ cloudaicompanionProject: "account-project" });
		});
		vi.stubGlobal("fetch", fetchMock);
		expect(await googleAntigravityOAuth.login(manualLogin())).toMatchObject({
			projectId: "account-project",
			baseUrl: "https://cloudcode-pa.googleapis.com",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("rejects a mismatched state before exchanging tokens", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			googleAntigravityOAuth.login(manualLogin(() => "http://localhost:51121/oauth-callback?code=code&state=wrong")),
		).rejects.toThrow("state mismatch");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("completes a manual login when the callback port is occupied", async () => {
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(51121, "127.0.0.1", resolve);
		});
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request) =>
					String(input).includes("oauth2.googleapis.com")
						? json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
						: json({ cloudaicompanionProject: "project" }),
				),
			);
			await expect(googleAntigravityOAuth.login(manualLogin())).resolves.toMatchObject({ projectId: "project" });
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("persists login credentials and automatically refreshes expired tokens", async () => {
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ credentials });
		models.setProvider(googleAntigravityProvider());
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).includes("oauth2.googleapis.com")) {
				const refreshing = new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token";
				return json({
					access_token: refreshing ? "refreshed-access" : "access",
					refresh_token: "refresh",
					expires_in: refreshing ? 3600 : 1,
				});
			}
			return json({ cloudaicompanionProject: "project" });
		});
		vi.stubGlobal("fetch", fetchMock);
		await models.login("google-antigravity", "oauth", manualLogin());
		expect(await credentials.read("google-antigravity")).toMatchObject({
			type: "oauth",
			access: "access",
			projectId: "project",
		});
		expect((await models.getAuth("google-antigravity"))?.auth.apiKey).toBe("refreshed-access");
		expect(await credentials.read("google-antigravity")).toMatchObject({
			access: "refreshed-access",
			projectId: "project",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it.each([
		{ access_token: "access", expires_in: 3600 },
		{ refresh_token: "refresh", expires_in: 3600 },
		{ access_token: "access", refresh_token: "refresh", expires_in: -1 },
	])("rejects invalid token responses", async (body) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json(body)),
		);
		await expect(googleAntigravityOAuth.login(manualLogin())).rejects.toThrow("invalid token data");
	});

	it("preserves project metadata when Google does not rotate the refresh token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({ access_token: "new-access", expires_in: 3600 })),
		);
		const result = await googleAntigravityOAuth.refresh(credential, signal);
		expect(result).toMatchObject({ ...credential, access: "new-access", expires: expect.any(Number) });
		expect(await googleAntigravityOAuth.toAuth(result)).toEqual({
			apiKey: "new-access",
			headers: { "X-Goog-User-Project": "account-project" },
			baseUrl: credential.baseUrl,
		});
	});

	it("cancels login and releases the callback port", async () => {
		const controller = new AbortController();
		await expect(
			googleAntigravityOAuth.login({
				signal: controller.signal,
				prompt: () => new Promise<string>(() => {}),
				notify(event) {
					if (event.type === "auth_url") controller.abort();
				},
			}),
		).rejects.toThrow("Login cancelled");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) =>
				String(input).includes("oauth2.googleapis.com")
					? json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
					: json({ cloudaicompanionProject: "project" }),
			),
		);
		await expect(googleAntigravityOAuth.login(manualLogin())).resolves.toMatchObject({ projectId: "project" });
	});

	it("persists and restores account models without making offline network requests", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("google-antigravity", async () => credential);
		const modelsStore = new InMemoryModelsStore();
		const models = createModels({ credentials, modelsStore });
		models.setProvider(googleAntigravityProvider());
		const fetchMock = vi.fn(async () =>
			json({
				models: {
					"gemini-3-flash": { displayName: "Gemini 3 Flash", supportsThinking: true },
					internal: { displayName: "Internal", isInternal: true },
					hidden: {},
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		expect((await models.refresh()).errors.size).toBe(0);
		expect(models.getModels("google-antigravity").map((entry) => entry.id)).toEqual(["gemini-3-flash"]);
		expect((await models.getAuth(models.getModels()[0]))?.auth.apiKey).toBe("access-token");
		const restored = createModels({ credentials, modelsStore });
		restored.setProvider(googleAntigravityProvider());
		await restored.refresh({ allowNetwork: false });
		expect(restored.getModels()).toEqual(models.getModels());
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("streams gateway envelopes across byte boundaries and preserves tool calls", async () => {
		const chunks = [
			{ candidates: [{ content: { parts: [{ text: "Olá" }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [{ functionCall: { name: "read", args: { path: "file.ts" } }, thoughtSignature: "c2ln" }],
						},
						finishReason: "STOP",
					},
				],
				usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
			},
		];
		const bytes = new TextEncoder().encode(
			chunks.map((response) => `data: ${JSON.stringify({ response })}\r\n\r\n`).join(""),
		);
		let request: Record<string, unknown> | undefined;
		let sentHeaders: Headers | undefined;
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			request = JSON.parse(String(init?.body)) as Record<string, unknown>;
			sentHeaders = new Headers(init?.headers);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
						controller.close();
					},
				}),
			);
		});
		const events: AuthEvent[] = [];
		const result = await stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }),
			{
				apiKey: "access-token",
				headers: { "X-Goog-User-Project": "account-project" },
				fetch: fetchMock,
				onProviderStreamEvent: (chunk) => {
					events.push({ type: "info", message: JSON.stringify(chunk) });
				},
			},
		).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({ type: "text", text: "Olá" });
		expect(result.content[1]).toMatchObject({
			type: "toolCall",
			name: "read",
			arguments: { path: "file.ts" },
			thoughtSignature: "c2ln",
		});
		expect(result.usage.totalTokens).toBe(15);
		expect(sentHeaders?.get("authorization")).toBe("Bearer access-token");
		expect(request).toMatchObject({
			project: "account-project",
			model: model.id,
			requestType: "agent",
			userAgent: "antigravity",
		});
		expect(events).toHaveLength(2);
	});

	it("reports truncated streams instead of returning an empty success", async () => {
		const result = await stream(model, normalizeContext({ messages: [] }), {
			apiKey: "access",
			headers: { "X-Goog-User-Project": "project" },
			fetch: async () => new Response(""),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("without a finish reason");
	});

	it("uses Claude thinking budgets and accepts OTHER as a tool-call finish", async () => {
		const claude = { ...model, id: "claude-opus-4-6-thinking" };
		let payload: unknown;
		const result = await streamSimple(claude, normalizeContext({ messages: [] }), {
			apiKey: "access",
			headers: { "X-Goog-User-Project": "project" },
			reasoning: "medium",
			onPayload: (request) => {
				payload = request;
			},
			fetch: async () =>
				new Response(
					`data: ${JSON.stringify({
						response: {
							candidates: [
								{
									content: { parts: [{ functionCall: { name: "read", args: {} } }] },
									finishReason: "OTHER",
								},
							],
						},
					})}\n\n`,
				),
		}).result();
		expect(payload).toMatchObject({
			project: "project",
			request: { generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } } },
		});
		expect(result.stopReason).toBe("toolUse");
	});

	it("preserves cached models when catalog refresh fails", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("google-antigravity", async () => credential);
		const modelsStore = new InMemoryModelsStore();
		await modelsStore.write("google-antigravity", { models: [model] });
		const models = createModels({ credentials, modelsStore });
		models.setProvider(googleAntigravityProvider());
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({}, 500)),
		);
		expect((await models.refresh()).errors.get("google-antigravity")?.message).toContain("HTTP 500");
		expect(models.getModels()).toEqual([model]);
	});
});
