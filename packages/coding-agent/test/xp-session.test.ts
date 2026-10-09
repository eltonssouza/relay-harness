import type { AgentTool } from "@relay-harness/agent-core";
import {
	type ClassifierModel,
	type ClassifierResult,
	createProvider,
	fauxAssistantMessage,
	fauxToolCall,
} from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import xpExtension from "../src/extensions/xp/index.ts";
import type { XpState } from "../src/extensions/xp/workflow.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const classifier: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	id: "execution-intelligence",
	name: "Scripted Laya",
	api: "typesafe-system-one",
	provider: "laya",
	baseUrl: "",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
};
const shellSchema = Type.Object({ command: Type.String() });
const checkpoint = (summary: string, evidenceIds: string[] = []) =>
	fauxAssistantMessage(fauxToolCall("xp_checkpoint", { summary, evidenceIds }), { stopReason: "toolUse" });
const latest = (harness: Harness): XpState => {
	const entry = harness.sessionManager
		.getBranch()
		.findLast((item) => item.type === "custom" && item.customType === "xp.state");
	if (entry?.type !== "custom") throw new Error("Missing XP state");
	return entry.data as XpState;
};

describe("XP in a real agent session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	async function setup(failClassifier = false, sessionManager?: Harness["sessionManager"]) {
		const provider = createProvider({
			id: "laya",
			models: [classifier],
			auth: { apiKey: { name: "Scripted Laya", resolve: async () => ({ auth: { apiKey: "local" } }) } },
			classifiers: {
				"typesafe-system-one": {
					classify: async (_model, context): Promise<ClassifierResult> => {
						const question = context.questions.next_action;
						if (question.type !== "choice") throw new Error("Invalid question");
						const action = Object.hasOwn(question.criteria, "finish")
							? "finish"
							: Object.hasOwn(question.criteria, "advance")
								? "advance"
								: "continue_phase";
						return {
							api: classifier.api,
							provider: classifier.provider,
							model: classifier.id,
							timestamp: 0,
							stopReason: failClassifier ? "error" : "stop",
							errorMessage: failClassifier ? "classifier down" : undefined,
							answers: {
								next_action: {
									type: "choice",
									choice: action,
									confidence: 0.95,
									probabilities: { [action]: 0.95 },
								},
								goal_reached: { type: "bool", probability: action === "finish" ? 0.95 : 0.1 },
							},
						};
					},
				},
			},
		});
		const bash: AgentTool<typeof shellSchema> = {
			name: "bash",
			label: "Scripted test runner",
			description: "Offline test evidence",
			parameters: shellSchema,
			execute: async (_id, args) => {
				if (args.command.includes("red")) throw new Error("AssertionError: expected 20, received 30");
				return { content: [{ type: "text", text: "tests 1, pass 1, fail 0" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [bash],
			sessionManager,
			settings: { harnessCore: { evidence: false } },
			extensionFactories: [(relay) => relay.registerProvider(provider), xpExtension],
		});
		harnesses.push(harness);
		await harness.session.modelRuntime.refresh({ allowNetwork: false });
		await harness.session.bindExtensions({});
		return harness;
	}

	it("runs Planning through Listening and finishes only after user acceptance", async () => {
		const harness = await setup();
		harness.setResponses([
			checkpoint("Acceptance criteria: discount boundary"),
			checkpoint("Design: pure discount function"),
			fauxAssistantMessage(fauxToolCall("bash", { command: "node --test red.test.ts" }, { id: "red" }), {
				stopReason: "toolUse",
			}),
			checkpoint("Boundary assertion fails", ["red"]),
			fauxAssistantMessage(fauxToolCall("bash", { command: "node --test green.test.ts" }, { id: "green" }), {
				stopReason: "toolUse",
			}),
			checkpoint("Implementation and review complete", ["green"]),
			checkpoint("Result delivered; waiting for feedback", ["green"]),
			fauxAssistantMessage("Waiting for user acceptance"),
		]);
		await harness.session.prompt("/xp start Fix discount");
		await expect.poll(() => latest(harness).phase).toBe("listening");
		await harness.session.waitForIdle();
		expect(harness.session.messages, JSON.stringify(harness.session.messages)).toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolName: "xp_checkpoint" })]),
		);
		expect(latest(harness)).toMatchObject({ phase: "listening", status: "active", accepted: false });
		harness.setResponses([checkpoint("User accepted the result", ["green"]), fauxAssistantMessage("Accepted")]);
		await harness.session.prompt("/xp accept");
		await expect.poll(() => latest(harness).status).toBe("completed");
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({ phase: "listening", status: "completed", accepted: true });
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "xp.decision"),
		).toHaveLength(6);
	});
	it("records classifier failure and hands off without advancing", async () => {
		const harness = await setup(true);
		harness.setResponses([checkpoint("Criteria documented"), fauxAssistantMessage("Laya unavailable")]);
		await harness.session.prompt("/xp start --no-tests Document discount");
		await expect.poll(() => latest(harness).status).toBe("handoff");
		await harness.session.waitForIdle();
		expect(latest(harness)).toMatchObject({ status: "handoff", phase: "planning" });
		const trace = harness.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === "xp.decision");
		expect(trace).toMatchObject({
			data: { error: "classifier down", questions: { next_action: expect.any(Object) } },
		});
	});
	it("restores phase and evidence when the session is resumed", async () => {
		const original = await setup();
		original.setResponses([checkpoint("Criteria documented"), fauxAssistantMessage("Design pending")]);
		await original.session.prompt("/xp start --no-tests Document discount");
		await expect.poll(() => latest(original).phase).toBe("design");
		await original.session.waitForIdle();
		expect(latest(original).phase).toBe("design");
		const resumed = await setup(false, original.sessionManager);
		resumed.setResponses([checkpoint("Design documented"), fauxAssistantMessage("Tests pending")]);
		await resumed.session.prompt("Continue");
		expect(latest(resumed).phase).toBe("testing");
	});
});
