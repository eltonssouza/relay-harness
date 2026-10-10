import { ANTIGRAVITY_METADATA, requestAntigravity } from "../../providers/google-antigravity-shared.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { type OAuthCallbackServer, startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const SCOPES = ["cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs"].map(
	(scope) => `https://www.googleapis.com/auth/${scope}`,
);

async function exchangeToken(
	params: Record<string, string>,
	signal: AbortSignal,
	clientId: string,
	clientSecret: string,
	previous?: OAuthCredential,
): Promise<OAuthCredential> {
	signal.throwIfAborted();
	const startedAt = Date.now();
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});
	if (!response.ok) throw new Error(`Antigravity OAuth token exchange failed (HTTP ${response.status})`);
	const body = (await response.json()) as {
		access_token?: unknown;
		refresh_token?: unknown;
		expires_in?: unknown;
	};
	const refresh = body.refresh_token ?? previous?.refresh;
	if (
		typeof body.access_token !== "string" ||
		!body.access_token ||
		typeof refresh !== "string" ||
		!refresh ||
		typeof body.expires_in !== "number" ||
		!Number.isFinite(body.expires_in) ||
		body.expires_in <= 0
	)
		throw new Error("Antigravity OAuth returned invalid token data");
	return {
		...previous,
		type: "oauth",
		access: body.access_token,
		refresh,
		expires: startedAt + Math.max(0, body.expires_in * 1000 - 60_000),
	};
}

async function loginAntigravity(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	interaction.signal.throwIfAborted();
	const clientId = getProviderEnvValue("RELAY_AI_ANTIGRAVITY_CLIENT_ID");
	const clientSecret = getProviderEnvValue("RELAY_AI_ANTIGRAVITY_CLIENT_SECRET");
	if (!clientId || !clientSecret) {
		throw new Error(
			"Set RELAY_AI_ANTIGRAVITY_CLIENT_ID and RELAY_AI_ANTIGRAVITY_CLIENT_SECRET to sign in with Google Antigravity",
		);
	}
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const complete = async (code: string): Promise<OAuthCredential> => {
		const credential = await exchangeToken(
			{
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
				redirect_uri: REDIRECT_URI,
			},
			interaction.signal,
			clientId,
			clientSecret,
		);
		interaction.notify({ type: "progress", message: "Loading Antigravity account..." });
		const { response, baseUrl } = await requestAntigravity({
			action: "loadCodeAssist",
			access: credential.access,
			body: { metadata: ANTIGRAVITY_METADATA },
			signal: interaction.signal,
		});
		const body = (await response.json()) as { cloudaicompanionProject?: string | { id?: string } };
		const projectId =
			typeof body.cloudaicompanionProject === "string"
				? body.cloudaicompanionProject
				: body.cloudaicompanionProject?.id;
		if (typeof projectId !== "string" || !projectId)
			throw new Error("No Antigravity project found. Open Antigravity and finish account setup, then log in again.");
		return { ...credential, projectId, baseUrl };
	};
	let callback: OAuthCallbackServer<OAuthCredential> | undefined;
	try {
		callback = await startOAuthCallbackServer({
			providerName: "Antigravity",
			host: getProviderEnvValue("RELAY_OAUTH_CALLBACK_HOST") || "127.0.0.1",
			redirectHost: "localhost",
			port: 51121,
			path: "/oauth-callback",
			state,
			complete,
			signal: interaction.signal,
			timeoutMs: 5 * 60 * 1000,
		});
	} catch (error) {
		if (interaction.signal.aborted) throw error;
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") throw error;
		interaction.notify({
			type: "info",
			message: "OAuth callback port is in use. Paste the final redirect URL to finish sign-in.",
		});
	}
	try {
		const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		url.search = new URLSearchParams({
			client_id: clientId,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			access_type: "offline",
			prompt: "consent",
		}).toString();
		interaction.notify({
			type: "auth_url",
			url: url.toString(),
			instructions: "Sign in with the Google account you use for Antigravity.",
		});
		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete sign-in in your browser, or paste the final redirect URL:",
			placeholder: REDIRECT_URI,
		});
		if (result.type === "callback") return result.value;
		interaction.signal.throwIfAborted();
		let redirect: URL;
		try {
			redirect = new URL(result.input.trim());
		} catch {
			throw new Error("Paste the complete Antigravity redirect URL");
		}
		if (redirect.searchParams.get("state") !== state) throw new Error("Antigravity OAuth state mismatch");
		if (redirect.searchParams.has("error")) throw new Error("Antigravity authorization was denied");
		const code = redirect.searchParams.get("code");
		if (!code) throw new Error("Missing authorization code");
		return await complete(code);
	} finally {
		callback?.close();
	}
}

export const googleAntigravityOAuth: OAuthAuth = {
	name: "Google Antigravity",
	loginLabel: "Sign in with Google Antigravity",
	login: loginAntigravity,
	async refresh(credential, signal) {
		const clientId = getProviderEnvValue("RELAY_AI_ANTIGRAVITY_CLIENT_ID");
		const clientSecret = getProviderEnvValue("RELAY_AI_ANTIGRAVITY_CLIENT_SECRET");
		if (!clientId || !clientSecret) {
			throw new Error(
				"Set RELAY_AI_ANTIGRAVITY_CLIENT_ID and RELAY_AI_ANTIGRAVITY_CLIENT_SECRET to refresh Google Antigravity login",
			);
		}
		return exchangeToken(
			{ grant_type: "refresh_token", refresh_token: credential.refresh },
			signal,
			clientId,
			clientSecret,
			credential,
		);
	},
	async toAuth(credential) {
		if (typeof credential.projectId !== "string" || !credential.projectId)
			throw new Error("Missing Antigravity project. Log in again.");
		return {
			apiKey: credential.access,
			headers: { "X-Goog-User-Project": credential.projectId },
			...(typeof credential.baseUrl === "string" ? { baseUrl: credential.baseUrl } : {}),
		};
	},
};
