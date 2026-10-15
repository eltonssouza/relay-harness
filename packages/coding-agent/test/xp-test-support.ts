import { type ClassifierContext, type ClassifierModel, type ClassifierResult, createProvider } from "@relay-harness/ai";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

export const xpTestClassifier: ClassifierModel<"typesafe-system-one"> = {
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

/** Scripted decisions only; no inference, credentials or network. */
export function xpTestProvider(override?: (context: ClassifierContext, result: ClassifierResult) => ClassifierResult) {
	return (relay: ExtensionAPI) =>
		relay.registerProvider(
			createProvider({
				id: "laya",
				models: [xpTestClassifier],
				auth: { apiKey: { name: "Offline", resolve: async () => ({ auth: { apiKey: "local" } }) } },
				classifiers: {
					"typesafe-system-one": {
						classify: async (_model, context): Promise<ClassifierResult> => {
							const answers: ClassifierResult["answers"] = {};
							for (const [id, question] of Object.entries(context.questions)) {
								if (question.type === "bool") {
									answers[id] = {
										type: "bool",
										probability:
											id === "goal_reached" ? 0.95 : question.instructions.includes(" agent ") ? 0.05 : 0.95,
									};
								} else if (question.type === "choice") {
									const options = Object.keys(question.criteria);
									const selected =
										id === "agent"
											? "backend-engineer"
											: context.state &&
													typeof context.state === "object" &&
													"replanRecommended" in context.state &&
													context.state.replanRecommended &&
													options.includes("replan")
												? "replan"
												: options.includes("request_intervention")
													? "request_intervention"
													: options.includes("finish")
														? "finish"
														: options.includes("advance")
															? "advance"
															: "continue_phase";
									const choice = options.includes(selected) ? selected : options[0];
									answers[id] = {
										type: "choice",
										choice,
										confidence: 0.95,
										probabilities: { [choice]: 0.95 },
									};
								}
							}
							const result: ClassifierResult = {
								api: xpTestClassifier.api,
								provider: "laya",
								model: xpTestClassifier.id,
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
