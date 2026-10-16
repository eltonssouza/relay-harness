import { type ClassifierContext, type ClassifierModel, type ClassifierResult, createProvider } from "@relay-harness/ai";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { delegationCheckpoint } from "../src/extensions/delegation/checkpoint.ts";

export function delegationTestHealth() {
	const identity = delegationCheckpoint();
	return { ok: true, version: identity.version, sha256: identity.sha256, artifact_sha256: identity.artifactSha256 };
}

export const delegationTestClassifier: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	id: "execution-intelligence",
	name: "Offline Laya",
	api: "typesafe-system-one",
	provider: "laya",
	baseUrl: "http://laya.invalid/v1",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
};

/** Scripted classifier answers test the Harness; they do not establish model quality. */
export function delegationTestProvider(
	override?: (context: ClassifierContext, result: ClassifierResult) => ClassifierResult,
) {
	return (relay: ExtensionAPI) =>
		relay.registerProvider(
			createProvider({
				id: "laya",
				models: [delegationTestClassifier],
				auth: { apiKey: { name: "Offline", resolve: async () => ({ auth: { apiKey: "local" } }) } },
				classifiers: {
					"typesafe-system-one": {
						async classify(_model, context): Promise<ClassifierResult> {
							const answers: ClassifierResult["answers"] = {};
							for (const [id, question] of Object.entries(context.questions)) {
								if (question.type === "bool") answers[id] = { type: "bool", probability: 0.95 };
								else if (question.type === "choice") {
									const choices = Object.keys(question.criteria);
									const preferred =
										id === "work_mode" ? "delegated" : id === "concurrency" ? "2" : "backend-engineer";
									const choice = choices.includes(preferred) ? preferred : choices[0];
									answers[id] = {
										type: "choice",
										choice,
										confidence: 0.95,
										probabilities: { [choice]: 0.95 },
									};
								}
							}
							const result: ClassifierResult = {
								api: delegationTestClassifier.api,
								provider: "laya",
								model: delegationTestClassifier.id,
								timestamp: 0,
								stopReason: "stop",
								answers,
							};
							return override?.(context, result) ?? result;
						},
					},
				},
			}),
		);
}
