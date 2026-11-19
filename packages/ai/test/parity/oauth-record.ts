/**
 * Reference OAuth token refresh and request auth (`refresh`, `toAuth`) of every built-in OAuth
 * provider, for the Rust port to match.
 *
 * Each case refreshes a stored credential through the provider's real `auth.oauth`. A stand-in
 * `globalThis.fetch` answers from the case's script (the first answer whose `match` the URL
 * contains, each used once) and records every request: method, URL, headers and body. Timers fire
 * at once, `Date.now` is fixed, and the variables a case sets are the only ones the flows see.
 * The case records the refreshed credential or the error, and `toAuth` of the result. Stack traces
 * in error details are cut, since they name TypeScript source lines.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OAuthCredential } from "../../src/auth/types.ts";
import { builtinProviders } from "../../src/providers/all.ts";

export const OAUTH_DIR = fileURLToPath(new URL("../../../../crates/fixtures/oauth/", import.meta.url));

export const NOW = 1_700_000_000_000;

interface Answer {
	match: string;
	status: number;
	body: string;
	headers?: Record<string, string>;
}

export interface OAuthCase {
	name: string;
	provider: string;
	credential: OAuthCredential;
	env?: Record<string, string>;
	answers: Answer[];
}

const json = (value: unknown) => JSON.stringify(value);
const ok = (match: string, value: unknown): Answer => ({
	match,
	status: 200,
	body: json(value),
	headers: { "content-type": "application/json" },
});
const fail = (match: string, status: number, value: unknown): Answer => ({
	match,
	status,
	body: typeof value === "string" ? value : json(value),
	headers: { "content-type": typeof value === "string" ? "text/plain" : "application/json" },
});

const stored = (extra: Record<string, unknown> = {}): OAuthCredential => ({
	type: "oauth",
	refresh: "refresh-1",
	access: "access-0",
	expires: NOW - 1000,
	...extra,
});

/** A JWT whose payload carries the ChatGPT account id, as Codex tokens do. */
function codexJwt(claims: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64").replace(/=+$/, "");
	return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

const COPILOT_TOKEN = "tid=1;exp=1700003600;proxy-ep=proxy.individual.githubcopilot.com;sku=x";
const COPILOT_MODELS = {
	data: [
		{ id: "gpt-5", model_picker_enabled: true, policy: { state: "enabled" } },
		{ id: "claude-sonnet-4", model_picker_enabled: true, policy: { state: "unconfigured" } },
		{ id: "disabled-model", model_picker_enabled: true, policy: { state: "disabled" } },
		{ id: "no-tools", model_picker_enabled: true, capabilities: { supports: { tool_calls: false } } },
		{ id: "hidden", model_picker_enabled: false, policy: { state: "enabled" } },
		{ model_picker_enabled: true },
	],
};

export function oauthCases(): OAuthCase[] {
	return [
		{
			name: "anthropic",
			provider: "anthropic",
			credential: stored(),
			answers: [
				ok("platform.claude.com", { access_token: "access-1", refresh_token: "refresh-2", expires_in: 3600 }),
			],
		},
		{
			name: "anthropic-rejected",
			provider: "anthropic",
			credential: stored(),
			answers: [fail("platform.claude.com", 400, { error: "invalid_grant" })],
		},
		{
			name: "anthropic-invalid-json",
			provider: "anthropic",
			credential: stored(),
			answers: [{ match: "platform.claude.com", status: 200, body: "not json" }],
		},
		{
			name: "openai-codex",
			provider: "openai-codex",
			credential: stored({ accountId: "acct-old" }),
			answers: [
				ok("auth.openai.com/oauth/token", {
					access_token: codexJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
					refresh_token: "refresh-2",
					expires_in: 864000,
				}),
			],
		},
		{
			name: "openai-codex-no-account",
			provider: "openai-codex",
			credential: stored(),
			answers: [ok("auth.openai.com/oauth/token", { access_token: "opaque", refresh_token: "r", expires_in: 60 })],
		},
		{
			name: "openai-codex-missing-fields",
			provider: "openai-codex",
			credential: stored(),
			answers: [ok("auth.openai.com/oauth/token", { access_token: "a" })],
		},
		{
			name: "openai-codex-encoded-token",
			provider: "openai-codex",
			credential: stored({ refresh: "tok en/+=é*~!'()" }),
			answers: [fail("auth.openai.com/oauth/token", 400, "")],
		},
		{
			name: "openai-codex-rejected",
			provider: "openai-codex",
			credential: stored(),
			answers: [fail("auth.openai.com/oauth/token", 401, "token revoked")],
		},
		{
			name: "openai-chatgpt",
			provider: "openai",
			credential: stored({ clientId: "client-1", scopes: ["old"] }),
			answers: [
				ok("auth.openai.com/api/accounts/oauth/token", {
					access_token: "access-1",
					refresh_token: "refresh-2",
					expires_in: 3600,
					scope: "openid  chatgpt.tokens.use.direct offline_access",
				}),
			],
		},
		{
			name: "openai-chatgpt-no-client",
			provider: "openai",
			credential: stored(),
			answers: [],
		},
		{
			name: "openai-chatgpt-missing-scope",
			provider: "openai",
			credential: stored({ clientId: "client-1" }),
			answers: [
				ok("auth.openai.com/api/accounts/oauth/token", {
					access_token: "a",
					refresh_token: "r",
					expires_in: 3600,
					scope: "openid",
				}),
			],
		},
		{
			name: "openai-chatgpt-rejected",
			provider: "openai",
			credential: stored({ clientId: "client-1" }),
			answers: [fail("auth.openai.com/api/accounts/oauth/token", 400, "")],
		},
		{
			name: "github-copilot",
			provider: "github-copilot",
			credential: stored({ refresh: "gho-github-token" }),
			answers: [
				ok("api.github.com/copilot_internal/v2/token", { token: COPILOT_TOKEN, expires_at: 1700003600 }),
				ok("api.individual.githubcopilot.com/models", COPILOT_MODELS),
			],
		},
		{
			name: "github-copilot-policy-fallback",
			provider: "github-copilot",
			credential: stored({ refresh: "gho-github-token" }),
			answers: [
				ok("api.github.com/copilot_internal/v2/token", { token: COPILOT_TOKEN, expires_at: 1700003600 }),
				ok("api.individual.githubcopilot.com/models", {
					data: [
						{ id: "gpt-5", model_picker_enabled: false, policy: { state: "enabled" } },
						{ id: "o3", model_picker_enabled: false, policy: { state: "unconfigured" } },
					],
				}),
			],
		},
		{
			name: "github-copilot-enterprise",
			provider: "github-copilot",
			credential: stored({ refresh: "ghu-enterprise", enterpriseUrl: "https://ghe.example.com/" }),
			answers: [
				ok("api.ghe.example.com/copilot_internal/v2/token", { token: "tid=2;exp=9", expires_at: 1700001800 }),
				ok("copilot-api.ghe.example.com/models", { data: [{ id: "gpt-5", model_picker_enabled: true }] }),
			],
		},
		{
			name: "github-copilot-rejected",
			provider: "github-copilot",
			credential: stored({ refresh: "gho-github-token" }),
			answers: [fail("api.github.com/copilot_internal/v2/token", 401, { message: "Bad credentials" })],
		},
		{
			name: "google-antigravity",
			provider: "google-antigravity",
			credential: stored({ projectId: "project-1", baseUrl: "https://daily-cloudcode-pa.googleapis.com" }),
			env: { RELAY_AI_ANTIGRAVITY_CLIENT_ID: "client-id", RELAY_AI_ANTIGRAVITY_CLIENT_SECRET: "client-secret" },
			answers: [ok("oauth2.googleapis.com/token", { access_token: "access-1", expires_in: 3599 })],
		},
		{
			name: "google-antigravity-no-client",
			provider: "google-antigravity",
			credential: stored({ projectId: "project-1" }),
			answers: [],
		},
		{
			name: "google-antigravity-no-project",
			provider: "google-antigravity",
			credential: stored(),
			env: { RELAY_AI_ANTIGRAVITY_CLIENT_ID: "client-id", RELAY_AI_ANTIGRAVITY_CLIENT_SECRET: "client-secret" },
			answers: [ok("oauth2.googleapis.com/token", { access_token: "a", refresh_token: "r", expires_in: 30 })],
		},
		{
			name: "kimi-coding",
			provider: "kimi-coding",
			credential: stored(),
			answers: [
				ok("auth.kimi.com/api/oauth/token", {
					access_token: "access-1",
					refresh_token: "refresh-2",
					expires_in: 900,
				}),
			],
		},
		{
			name: "kimi-coding-retried",
			provider: "kimi-coding",
			credential: stored(),
			env: { KIMI_OAUTH_HOST: "https://kimi.example/" },
			answers: [
				fail("kimi.example/api/oauth/token", 503, { error: "busy" }),
				fail("kimi.example/api/oauth/token", 429, { error: "slow" }),
				ok("kimi.example/api/oauth/token", { access_token: "a", refresh_token: "r", expires_in: 60 }),
			],
		},
		{
			name: "kimi-coding-unauthorized",
			provider: "kimi-coding",
			credential: stored(),
			answers: [
				fail("auth.kimi.com/api/oauth/token", 400, { error: "invalid_grant", error_description: "expired" }),
			],
		},
		{
			name: "kimi-coding-exhausted",
			provider: "kimi-coding",
			credential: stored(),
			answers: [
				fail("auth.kimi.com", 500, "a"),
				fail("auth.kimi.com", 500, "b"),
				fail("auth.kimi.com", 500, "c"),
				fail("auth.kimi.com", 500, { error: "down" }),
			],
		},
		{
			name: "meta",
			provider: "meta",
			credential: stored({ refresh: "identity-1" }),
			answers: [ok("api.meta.ai/muse-code/key", { api_key: "meta-key-1" })],
		},
		{
			name: "meta-expired",
			provider: "meta",
			credential: stored({ refresh: "identity-1" }),
			answers: [fail("api.meta.ai/muse-code/key", 401, { detail: " session gone " })],
		},
		{
			name: "meta-mint-failed",
			provider: "meta",
			credential: stored({ refresh: "identity-1" }),
			answers: [
				fail("api.meta.ai/muse-code/key", 500, { error: "e", message: "m", detail: "d", error_description: "  " }),
			],
		},
		{
			name: "meta-no-key",
			provider: "meta",
			credential: stored({ refresh: "identity-1" }),
			answers: [ok("api.meta.ai/muse-code/key", { action_url: "https://meta.ai/setup" })],
		},
		{
			name: "openrouter",
			provider: "openrouter",
			credential: stored({ refresh: "", access: "sk-or-1", expires: Number.MAX_SAFE_INTEGER }),
			answers: [],
		},
		{
			name: "xai",
			provider: "xai",
			credential: stored(),
			answers: [
				ok("auth.x.ai/oauth2/token", { access_token: "access-1", refresh_token: "refresh-2", expires_in: 7200 }),
			],
		},
		{
			name: "xai-not-rotated",
			provider: "xai",
			credential: stored(),
			answers: [ok("auth.x.ai/oauth2/token", { access_token: "access-1" })],
		},
		{
			name: "xai-rejected",
			provider: "xai",
			credential: stored(),
			answers: [
				fail("auth.x.ai/oauth2/token", 400, { error: "invalid_grant", error_description: "Refresh token expired" }),
			],
		},
		{
			name: "xai-invalid-json",
			provider: "xai",
			credential: stored(),
			answers: [{ match: "auth.x.ai/oauth2/token", status: 200, body: "<html>" }],
		},
	];
}

const OAUTH_ENV = [
	"RELAY_AI_ANTIGRAVITY_CLIENT_ID",
	"RELAY_AI_ANTIGRAVITY_CLIENT_SECRET",
	"KIMI_CODE_OAUTH_HOST",
	"KIMI_OAUTH_HOST",
];

function cutStacks(message: string): string {
	return message.replace(/; stack=[\s\S]*?(?=; cause=|$)/g, "");
}

export async function recordOAuth(testCase: OAuthCase): Promise<unknown> {
	const provider = builtinProviders().find((candidate) => candidate.id === testCase.provider);
	const oauth = provider?.auth.oauth;
	if (!oauth) throw new Error(`${testCase.provider} has no OAuth`);
	const requests: unknown[] = [];
	const answers = [...testCase.answers];
	const savedEnv = Object.fromEntries(OAUTH_ENV.map((name) => [name, process.env[name]]));
	const originalFetch = globalThis.fetch;
	const originalSetTimeout = globalThis.setTimeout;
	const originalNow = Date.now;
	for (const name of OAUTH_ENV) delete process.env[name];
	Object.assign(process.env, testCase.env ?? {});
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
		const body = init?.body;
		requests.push({
			method: init?.method ?? "GET",
			url,
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			body: body === undefined || body === null ? null : String(body),
		});
		const index = answers.findIndex((answer) => url.includes(answer.match));
		if (index === -1) throw new TypeError("fetch failed");
		const [answer] = answers.splice(index, 1);
		return new Response(answer!.body, { status: answer!.status, headers: answer!.headers });
	}) as typeof globalThis.fetch;
	globalThis.setTimeout = ((callback: () => void) => {
		queueMicrotask(callback);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	Date.now = () => NOW;
	try {
		let result: OAuthCredential | undefined;
		let error: string | undefined;
		try {
			result = await oauth.refresh(testCase.credential, new AbortController().signal);
		} catch (failure) {
			error = cutStacks(failure instanceof Error ? failure.message : String(failure));
		}
		let auth: unknown;
		let authError: string | undefined;
		try {
			auth = await oauth.toAuth(result ?? testCase.credential);
		} catch (failure) {
			authError = failure instanceof Error ? failure.message : String(failure);
		}
		return {
			requests,
			...(result ? { result: JSON.parse(JSON.stringify(result)) } : { error }),
			...(authError === undefined ? { auth: JSON.parse(JSON.stringify(auth)) } : { authError }),
		};
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.setTimeout = originalSetTimeout;
		Date.now = originalNow;
		for (const [name, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

export async function oauthJson(testCase: OAuthCase): Promise<string> {
	return `${JSON.stringify({ ...testCase, ...((await recordOAuth(testCase)) as object) }, null, "\t")}\n`;
}

export function readOAuthCase(name: string): string {
	return readFileSync(join(OAUTH_DIR, `${name}.json`), "utf8");
}
