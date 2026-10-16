import type { ClassifierQuestion, ClassifierResult, JsonObject } from "@relay-harness/ai";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { DEFAULT_LAYA_BASE_URL, LAYA_CLASSIFIER_ID, LAYA_PROVIDER_ID } from "../laya/index.ts";
import { DELEGATION_MODEL, delegationCheckpoint } from "./checkpoint.ts";

/** Fail closed: Delegation never uses the router's keyword or learned-label fallback. */
export async function classifyWork(
	relay: ExtensionAPI,
	ctx: ExtensionContext,
	state: JsonObject,
	questions: Record<string, ClassifierQuestion>,
	signal?: AbortSignal,
): Promise<ClassifierResult> {
	const checkpoint = delegationCheckpoint();
	const classifier = ctx.modelRegistry.findOfType("classifier", LAYA_PROVIDER_ID, LAYA_CLASSIFIER_ID);
	if (!classifier) throw new Error("Laya classifier unavailable. Use /laya setup, then retry propose_work.");
	const settings = relay.getSettings().laya;
	const auth = await ctx.modelRegistry.getProviderAuth(LAYA_PROVIDER_ID);
	const response = await fetch(
		new URL(
			"/health",
			auth?.auth.baseUrl ??
				settings?.baseUrl ??
				process.env.LAYA_BASE_URL ??
				classifier.baseUrl ??
				DEFAULT_LAYA_BASE_URL,
		),
		{
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
			headers: {
				...(auth?.auth.apiKey ? { Authorization: `Bearer ${auth.auth.apiKey}` } : {}),
				...auth?.auth.headers,
			},
		},
	);
	if (!response.ok) throw new Error(`Laya health check failed: ${response.status}`);
	const health: unknown = await response.json();
	if (
		!health ||
		typeof health !== "object" ||
		!("ok" in health) ||
		health.ok !== true ||
		!("version" in health) ||
		health.version !== DELEGATION_MODEL
	) {
		throw new Error(`Delegation requires ${DELEGATION_MODEL}; the server did not confirm that checkpoint.`);
	}
	if (
		!("sha256" in health) ||
		health.sha256 !== checkpoint.sha256 ||
		!("artifact_sha256" in health) ||
		health.artifact_sha256 !== checkpoint.artifactSha256
	)
		throw new Error(
			`Delegation requires the pinned ${DELEGATION_MODEL} checkpoint files; the server did not confirm their hashes.`,
		);
	const result = await ctx.modelRegistry.classify(
		classifier,
		{
			state: {
				...state,
				required_model: DELEGATION_MODEL,
				required_checkpoint_sha256: checkpoint.sha256,
				required_artifact_sha256: checkpoint.artifactSha256,
			},
			questions,
		},
		{ signal, timeoutMs: settings?.timeoutMs ?? 60_000, maxRetries: 0 },
	);
	if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? result.stopReason);
	return result;
}
