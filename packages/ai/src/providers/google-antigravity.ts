import { googleAntigravityApi } from "../api/google-antigravity.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadGoogleAntigravityOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { requestAntigravity } from "./google-antigravity-shared.ts";

interface RemoteModel {
	displayName?: string;
	isInternal?: boolean;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	maxInputTokens?: number;
	maxOutputTokens?: number;
}

/** Models are discovered from the signed-in account and cached by ModelsStore. */
export function googleAntigravityProvider(): Provider<"google-generative-ai"> {
	return createProvider({
		id: "google-antigravity",
		name: "Google Antigravity",
		auth: {
			oauth: lazyOAuth({
				name: "Google Antigravity",
				loginLabel: "Sign in with Google Antigravity",
				load: loadGoogleAntigravityOAuth,
			}),
		},
		models: [],
		api: googleAntigravityApi(),
		async fetchModels({ credential, signal }) {
			if (credential?.type !== "oauth" || typeof credential.projectId !== "string" || !credential.projectId) {
				throw new Error("Log in with /login google-antigravity to discover models");
			}
			const { response } = await requestAntigravity({
				action: "fetchAvailableModels",
				access: credential.access,
				body: { project: credential.projectId },
				signal,
				baseUrl: typeof credential.baseUrl === "string" ? credential.baseUrl : undefined,
			});
			const body = (await response.json()) as { models?: Record<string, RemoteModel> };
			if (!body.models || typeof body.models !== "object" || Array.isArray(body.models)) {
				throw new Error("Antigravity returned an invalid model catalog");
			}
			return Object.entries(body.models)
				.filter(([, info]) => info && !info.isInternal && typeof info.displayName === "string" && info.displayName)
				.map(
					([id, info]): Model<"google-generative-ai"> => ({
						id,
						name: info.displayName!,
						provider: "google-antigravity",
						api: "google-generative-ai",
						baseUrl: "",
						reasoning: info.supportsThinking ?? /gemini|thinking|gpt-oss/.test(id),
						input: info.supportsImages === false || id.startsWith("gpt-oss") ? ["text"] : ["text", "image"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: info.maxInputTokens ?? (id.startsWith("gemini") ? 1_048_576 : 200_000),
						maxTokens: info.maxOutputTokens ?? 32_768,
					}),
				);
		},
	});
}
