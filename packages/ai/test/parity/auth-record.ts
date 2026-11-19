/**
 * Reference API-key resolution of every built-in provider, for the Rust port to match.
 *
 * Each provider's real `auth.apiKey.resolve` runs against a scripted context: environment
 * variables (set to `v-<NAME>`) and files are present only when a case sets them, and every lookup
 * is logged. The cases are every branch the resolver takes (`explore`), without a stored
 * credential and with one holding a key, provider env values (`c-<NAME>`) or both. Each case
 * records what the resolver asked for and what it returned. OAuth flows are only described (their
 * names), since logging in is interactive.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiKeyCredential, AuthContext, AuthResult } from "../../src/auth/types.ts";
import type { Provider } from "../../src/models.ts";
import { builtinProviders } from "../../src/providers/all.ts";

export const AUTH_DIR = fileURLToPath(new URL("../../../../crates/fixtures/auth/", import.meta.url));

export interface AuthScenario {
	/** Variables set, each to `v-<NAME>`. */
	env: string[];
	/** Paths that exist. */
	files: string[];
	credential?: ApiKeyCredential;
}

interface Lookups {
	env: string[];
	files: string[];
}

async function resolveWith(
	provider: Provider,
	scenario: AuthScenario,
): Promise<{ lookups: Lookups; result: AuthResult | null; check?: unknown }> {
	const lookups: Lookups = { env: [], files: [] };
	const ctx: AuthContext = {
		env: async (name) => {
			lookups.env.push(name);
			return scenario.env.includes(name) ? `v-${name}` : undefined;
		},
		fileExists: async (path) => {
			lookups.files.push(path);
			return scenario.files.includes(path);
		},
	};
	const auth = provider.auth.apiKey!;
	const signal = new AbortController().signal;
	const result = (await auth.resolve({ ctx, credential: scenario.credential, signal })) ?? null;
	const check = auth.check
		? ((await auth.check({ ctx, credential: scenario.credential, signal })) ?? null)
		: undefined;
	return { lookups, result: JSON.parse(JSON.stringify(result)), ...(check !== undefined ? { check } : {}) };
}

const MAX_STATES = 96;

/**
 * Every branch the resolver takes: starting from nothing set, each state adds one variable or
 * file its run looked up and did not find. A name read only once an earlier one is set (an
 * account id after a key) is reached this way.
 */
async function explore(provider: Provider, credential?: ApiKeyCredential): Promise<AuthScenario[]> {
	const seen = new Set<string>();
	const queue: AuthScenario[] = [{ env: [], files: [], ...(credential ? { credential } : {}) }];
	const states: AuthScenario[] = [];
	while (queue.length > 0 && states.length < MAX_STATES) {
		const state = queue.shift()!;
		const key = JSON.stringify([[...state.env].sort(), [...state.files].sort()]);
		if (seen.has(key)) continue;
		seen.add(key);
		states.push(state);
		const { lookups } = await resolveWith(provider, state);
		for (const name of lookups.env) {
			if (!state.env.includes(name)) queue.push({ ...state, env: [...state.env, name] });
		}
		for (const path of lookups.files) {
			if (!state.files.includes(path)) queue.push({ ...state, files: [...state.files, path] });
		}
	}
	if (queue.length > 0) throw new Error(`${provider.id}: more than ${MAX_STATES} resolver states`);
	return states;
}

export interface ProviderAuthRecording {
	provider: string;
	name: string;
	apiKey: { name: string; login: boolean } | null;
	oauth: { name: string; isSubscription?: boolean; loginLabel?: string } | null;
	cases: (AuthScenario & { lookups: Lookups; result: AuthResult | null; check?: unknown })[];
}

export async function recordProvider(provider: Provider): Promise<ProviderAuthRecording> {
	const oauth = provider.auth.oauth;
	const recording: ProviderAuthRecording = {
		provider: provider.id,
		name: provider.name,
		apiKey: provider.auth.apiKey
			? { name: provider.auth.apiKey.name, login: provider.auth.apiKey.login !== undefined }
			: null,
		oauth: oauth
			? {
					name: oauth.name,
					...(oauth.isSubscription !== undefined ? { isSubscription: oauth.isSubscription } : {}),
					...(oauth.loginLabel !== undefined ? { loginLabel: oauth.loginLabel } : {}),
				}
			: null,
		cases: [],
	};
	if (!provider.auth.apiKey) return recording;

	const plain = await explore(provider);
	const names = [...new Set(plain.flatMap((state) => state.env))];
	const stored = Object.fromEntries(names.map((name) => [name, `c-${name}`]));
	const scenarios = [
		...plain,
		...(await explore(provider, { type: "api_key", key: "stored-key" })),
		...(await explore(provider, { type: "api_key", env: stored })),
		...(await explore(provider, { type: "api_key", key: "stored-key", env: stored })),
		{ env: [], files: [], credential: { type: "api_key", key: "" } as ApiKeyCredential },
	];
	for (const scenario of scenarios) {
		recording.cases.push({ ...scenario, ...(await resolveWith(provider, scenario)) });
	}
	return recording;
}

/** One case per built-in provider, named by its id. */
export function authCases(): { name: string; provider: Provider }[] {
	return builtinProviders().map((provider) => ({ name: provider.id, provider }));
}

export async function authJson(testCase: { provider: Provider }): Promise<string> {
	return `${JSON.stringify(await recordProvider(testCase.provider), null, "\t")}\n`;
}

export function readAuthCase(id: string): string {
	return readFileSync(join(AUTH_DIR, `${id}.json`), "utf8");
}
