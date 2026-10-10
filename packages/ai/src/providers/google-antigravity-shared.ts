import type { FetchFunction, ProviderEnv, ProviderHeaders } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

export const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
] as const;

export const ANTIGRAVITY_METADATA = {
	ideType: "ANTIGRAVITY",
	platform: "PLATFORM_UNSPECIFIED",
	pluginType: "GEMINI",
};

/** Cloud Code Assist requires its client version in the user agent. */
export function antigravityHeaders(env?: ProviderEnv): Record<string, string> {
	const version = getProviderEnvValue("RELAY_AI_ANTIGRAVITY_VERSION", env) || "1.21.9";
	return { "User-Agent": `antigravity/${version}`, "Content-Type": "application/json" };
}

export async function requestAntigravity(input: {
	action: string;
	access: string;
	body: unknown;
	signal?: AbortSignal;
	baseUrl?: string;
	headers?: ProviderHeaders;
	env?: ProviderEnv;
	fetch?: FetchFunction;
	timeoutMs?: number;
}): Promise<{ response: Response; baseUrl: string }> {
	const signal = AbortSignal.any([
		...(input.signal ? [input.signal] : []),
		AbortSignal.timeout(input.timeoutMs ?? 30_000),
	]);
	signal.throwIfAborted();
	const endpoints = input.baseUrl ? [input.baseUrl] : ANTIGRAVITY_ENDPOINTS;
	for (const [index, baseUrl] of endpoints.entries()) {
		const response = await (input.fetch ?? globalThis.fetch)(
			`${baseUrl.replace(/\/$/, "")}/v1internal:${input.action}`,
			{
				method: "POST",
				headers: providerHeadersToRecord({
					...antigravityHeaders(input.env),
					Authorization: `Bearer ${input.access}`,
					...input.headers,
				}),
				body: JSON.stringify(input.body),
				signal,
			},
		);
		if ((response.status === 403 || response.status === 404) && index < endpoints.length - 1) {
			await response.body?.cancel();
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw Object.assign(new Error(`Antigravity ${input.action} failed (HTTP ${response.status})`), {
				status: response.status,
				headers: response.headers,
			});
		}
		return { response, baseUrl };
	}
	throw new Error("No Antigravity endpoint available");
}
