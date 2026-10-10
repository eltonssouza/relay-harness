import { FinishReason, type GenerateContentResponse } from "@google/genai";
import { requestAntigravity } from "../providers/google-antigravity-shared.ts";
import type { SimpleStreamOptions, StreamFunction } from "../types.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { getCurrentTools } from "../utils/transcript.ts";
import { createGoogleSimpleStream, type GoogleOptions, streamWithGoogleTransport } from "./google-generative-ai.ts";
import { convertTools, supportsGoogleStrictToolSampling } from "./google-shared.ts";

async function* readResponses(response: Response): AsyncGenerator<GenerateContentResponse> {
	if (!response.body) throw new Error("Antigravity returned an empty response body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	let hasToolCall = false;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			if (done) buffer += "\n\n";
			while (buffer.includes("\n")) {
				const newline = buffer.indexOf("\n");
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
				if (line === "" && data.length > 0) {
					const payload = data.join("\n");
					data = [];
					if (payload === "[DONE]") return;
					const envelope = JSON.parse(payload) as { response?: GenerateContentResponse; error?: unknown };
					if (envelope.error) throw new Error("Antigravity returned a stream error");
					if (!envelope.response) throw new Error("Invalid Antigravity stream response");
					const candidate = envelope.response.candidates?.[0];
					hasToolCall ||= candidate?.content?.parts?.some((part) => part.functionCall !== undefined) ?? false;
					// Cloud Code's Claude backend uses OTHER to finish tool-call turns.
					if (hasToolCall && candidate?.finishReason === FinishReason.OTHER)
						candidate.finishReason = FinishReason.STOP;
					yield envelope.response;
				}
			}
			if (done) break;
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (model, context, options) =>
	streamWithGoogleTransport(model, context, { ...options, onPayload: undefined }, async (params) => {
		if (!options?.apiKey) throw new Error("No Antigravity access token. Log in with /login google-antigravity.");
		const access = options.apiKey;
		const headers = { ...model.headers, ...options.headers };
		const projectHeader = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-goog-user-project");
		const project = projectHeader?.[1];
		if (!project) throw new Error("Missing Antigravity project. Log in again.");
		// The gateway takes the managed project in its body, not as a billing quota override.
		if (projectHeader) delete headers[projectHeader[0]];
		const {
			systemInstruction,
			tools: _tools,
			abortSignal: _signal,
			toolConfig,
			...generationConfig
		} = params.config ?? {};
		const request = {
			contents: params.contents,
			generationConfig,
			...(systemInstruction && { systemInstruction: { role: "user", parts: [{ text: systemInstruction }] } }),
			tools: convertTools(getCurrentTools(context.messages), true, supportsGoogleStrictToolSampling(model.id)),
			...(toolConfig && { toolConfig }),
			...(options.sessionId && { sessionId: options.sessionId }),
		};
		let payload: unknown = {
			project,
			model: params.model,
			request,
			userAgent: "antigravity",
			requestType: "agent",
			requestId: crypto.randomUUID(),
		};
		payload = (await options.onPayload?.(payload, model)) ?? payload;
		const { response } = await retryProviderRequest(
			() =>
				requestAntigravity({
					action: "streamGenerateContent?alt=sse",
					access,
					body: payload,
					baseUrl: model.baseUrl || undefined,
					headers: { ...headers, Accept: "text/event-stream" },
					signal: options.signal,
					env: options.env,
					fetch: options.fetch,
					timeoutMs: options.timeoutMs ?? 600_000,
				}),
			options,
		);
		await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
		return readResponses(response);
	});

const googleSimpleStream = createGoogleSimpleStream(stream);

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (model, context, options) =>
	googleSimpleStream(model, context, {
		...options,
		thinkingBudgets: { minimal: 1024, low: 2048, medium: 8192, high: 16384, ...options?.thinkingBudgets },
	});
