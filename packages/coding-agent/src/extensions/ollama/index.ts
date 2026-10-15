import type { ExtensionAPI, ProviderChatModelConfig } from "../../core/extensions/types.ts";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/** OLLAMA_HOST selects one daemon; discovery never scans the network or launches Ollama. */
export function ollamaUrl(host = process.env.OLLAMA_HOST): URL {
	const address = host?.trim() || DEFAULT_OLLAMA_URL;
	const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `http://${address}`);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("OLLAMA_HOST must be an HTTP address");
	if (url.username || url.password) throw new Error("OLLAMA_HOST must not contain credentials");
	if (["0.0.0.0", "[::]"].includes(url.hostname)) url.hostname = "127.0.0.1";
	url.pathname = "/";
	url.search = "";
	url.hash = "";
	return url;
}

export interface OllamaCatalog {
	installed: string[];
	models: ProviderChatModelConfig[];
	error?: string;
}

/** Only actual installed completion models enter the chat selector. Embedding models remain listed by /ollama. */
export async function discoverOllamaModels(url: URL, signal?: AbortSignal): Promise<OllamaCatalog> {
	const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(1500)]);
	try {
		const response = await fetch(new URL("api/tags", url), { signal: requestSignal });
		if (!response.ok) throw new Error(`Ollama discovery returned HTTP ${response.status}`);
		const data: unknown = await response.json();
		if (!data || typeof data !== "object" || !("models" in data) || !Array.isArray(data.models))
			throw new Error("Ollama returned an invalid model catalog");
		const installed = [
			...new Set(
				data.models.flatMap((entry: unknown): string[] => {
					if (!entry || typeof entry !== "object" || !("name" in entry) || typeof entry.name !== "string")
						return [];
					return entry.name.trim() && entry.name.length <= 256 ? [entry.name] : [];
				}),
			),
		];
		const models = await Promise.all(
			installed.map(async (id): Promise<ProviderChatModelConfig | undefined> => {
				const show = await fetch(new URL("api/show", url), {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model: id }),
					signal: requestSignal,
				});
				if (!show.ok) throw new Error(`Ollama model inspection returned HTTP ${show.status}`);
				const info: unknown = await show.json();
				if (!info || typeof info !== "object" || !("capabilities" in info) || !Array.isArray(info.capabilities))
					throw new Error("Ollama returned invalid model capabilities");
				if (!info.capabilities.includes("completion")) return undefined;
				const modelInfo =
					"model_info" in info && info.model_info && typeof info.model_info === "object" ? info.model_info : {};
				const contextLength = Object.entries(modelInfo).find(
					([key, value]) =>
						key.endsWith(".context_length") &&
						typeof value === "number" &&
						Number.isSafeInteger(value) &&
						value > 0,
				)?.[1];
				const contextWindow = typeof contextLength === "number" ? contextLength : 4096;
				return {
					id,
					name: id,
					contextWindow,
					maxTokens: Math.min(4096, contextWindow),
					reasoning: false,
					input: info.capabilities.includes("vision") ? ["text", "image"] : ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					compat: {
						supportsTools: info.capabilities.includes("tools"),
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
						maxTokensField: "max_tokens",
					},
				};
			}),
		);
		return { installed, models: models.filter((model): model is ProviderChatModelConfig => model !== undefined) };
	} catch (error) {
		if (signal?.aborted) throw error;
		return {
			installed: [],
			models: [],
			error:
				error instanceof Error && error.message.startsWith("Ollama ")
					? error.message
					: "Ollama discovery failed or timed out. Check the daemon and OLLAMA_HOST.",
		};
	}
}

export default function ollamaExtension(relay: ExtensionAPI): void {
	const url = ollamaUrl();
	let catalog: OllamaCatalog = { installed: [], models: [] };
	relay.registerProvider("ollama", {
		name: "Ollama (local)",
		baseUrl: new URL("v1", url).href.replace(/\/$/, ""),
		api: "openai-completions",
		apiKey: "ollama",
		authHeader: false,
		refreshModels: async ({ signal }) => {
			catalog = await discoverOllamaModels(url, signal);
			return catalog.models;
		},
	});
	relay.registerCommand("ollama", {
		description: "List installed Ollama models and refresh the local chat catalog",
		handler: async (_args, ctx) => {
			await ctx.modelRegistry.refresh({
				providers: ["ollama"],
				allowNetwork: true,
				force: true,
				signal: ctx.signal,
			});
			const usable = new Set(catalog.models.map((model) => model.id));
			ctx.ui.notify(
				catalog.error ??
					(catalog.installed.length
						? catalog.installed
								.map((id) => `${id}${usable.has(id) ? ` — /model ollama/${id}` : " — not a chat model"}`)
								.join("\n")
						: "Ollama has no installed models."),
				catalog.error ? "warning" : "info",
			);
		},
	});
}
