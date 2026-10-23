import type { EmbeddingProvider } from "./types.ts";

export interface HttpEmbeddingOptions {
	/** Base URL, e.g. http://127.0.0.1:11434 for Ollama or https://host/v1 for an OpenAI-compatible API. */
	baseUrl: string;
	model: string;
	/** `ollama` posts to /api/embed; `openai` posts to /embeddings. */
	api: "ollama" | "openai";
	apiKey?: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
}

/**
 * Embedding adapter over HTTP. Only vector generation is external; storage, ranking and policy stay local.
 * The model identity includes the API and model name so vectors from different models are never mixed.
 */
export class HttpEmbeddingProvider implements EmbeddingProvider {
	readonly model: string;
	private readonly options: HttpEmbeddingOptions;

	constructor(options: HttpEmbeddingOptions) {
		this.options = options;
		this.model = `${options.api}:${options.model}`;
	}

	async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
		if (texts.length === 0) return [];
		const { api, baseUrl, model, apiKey } = this.options;
		const url = new URL(
			api === "ollama" ? "api/embed" : "embeddings",
			baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
		);
		const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
		const response = await (this.options.fetch ?? fetch)(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
			body: JSON.stringify({ model, input: texts }),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!response.ok) throw new Error(`Embedding request failed with HTTP ${response.status}.`);
		const body = (await response.json()) as {
			embeddings?: number[][];
			data?: Array<{ embedding: number[]; index?: number }>;
		};
		const vectors =
			api === "ollama"
				? body.embeddings
				: body.data
						?.slice()
						.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
						.map((item) => item.embedding);
		if (
			!Array.isArray(vectors) ||
			vectors.length !== texts.length ||
			vectors.some((v) => !Array.isArray(v) || v.length === 0)
		)
			throw new Error("Embedding response did not contain one vector per input.");
		return vectors;
	}
}

/**
 * Builds the configured provider, or none. Embeddings are opt-in: without configuration the engine uses
 * lexical search only, which keeps the default fully offline and dependency-free.
 */
export function embeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | undefined {
	const model = env.RELAY_MEMORY_EMBEDDING_MODEL?.trim();
	if (!model) return undefined;
	const api = env.RELAY_MEMORY_EMBEDDING_API === "openai" ? "openai" : "ollama";
	return new HttpEmbeddingProvider({
		api,
		model,
		baseUrl:
			env.RELAY_MEMORY_EMBEDDING_URL?.trim() ||
			(api === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1"),
		apiKey: env.RELAY_MEMORY_EMBEDDING_API_KEY?.trim() || undefined,
	});
}
