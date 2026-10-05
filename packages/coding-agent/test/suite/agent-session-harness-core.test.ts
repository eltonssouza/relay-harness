import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { HARNESS_CONSTRAINTS_ENTRY } from "../../src/core/harness-core.ts";
import {
	createHarness,
	createTestUiContext,
	getMessageText,
	getToolResult,
	getUserTexts,
	type Harness,
} from "./harness.ts";

const recordingParameters = Type.Object({ command: Type.Optional(Type.String()), path: Type.Optional(Type.String()) });

function recordingTool(name: string, calls: string[]): AgentTool<typeof recordingParameters> {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: recordingParameters,
		execute: async (_id, params) => {
			calls.push(`${name}:${params.command ?? params.path ?? ""}`);
			return { content: [{ type: "text", text: `${name} ok` }], details: {} };
		},
	};
}

describe("AgentSession harness core", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function create(
		options: Parameters<typeof createHarness>[0] = {},
	): Promise<{ harness: Harness; calls: string[] }> {
		const calls: string[] = [];
		const harness = await createHarness({
			tools: [recordingTool("edit", calls), recordingTool("bash", calls)],
			initialActiveToolNames: ["edit", "bash"],
			...options,
		});
		harnesses.push(harness);
		return { harness, calls };
	}

	it("asks for verification once when the agent claims completion without evidence", async () => {
		const { harness, calls } = await create();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { path: "src/a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done, the bug is fixed."),
			fauxAssistantMessage(fauxToolCall("bash", { command: "npm test" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Fixed; all tests pass."),
		]);

		await harness.session.prompt("Fix the bug in src/a.ts");

		expect(calls).toEqual(["edit:src/a.ts", "bash:npm test"]);
		const userTexts = getUserTexts(harness);
		expect(userTexts).toHaveLength(2);
		expect(userTexts[1]).toContain("[harness:evidence] Completion check");
		expect(harness.session.harnessCore.core.evidence?.latestReport()?.status).toBe("verified");
	});

	it("does not gate when the evidence pillar is disabled", async () => {
		const { harness } = await create({ settings: { harnessCore: { evidence: false } } });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { path: "src/a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);

		await harness.session.prompt("Fix the bug in src/a.ts");

		expect(getUserTexts(harness)).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("asks the interactive UI before a push and honors the answer", async () => {
		const { harness, calls } = await create();
		const asked: string[] = [];
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				confirm: async (_title, message) => {
					asked.push(message);
					return message.includes("origin main");
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "git push origin main" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", { command: "git push origin other" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The second push was declined."),
		]);

		await harness.session.prompt("Update the changelog entry.");

		expect(asked).toHaveLength(2);
		expect(calls).toEqual(["bash:git push origin main"]);
		expect(getMessageText(getToolResult(harness, "bash"))).toContain("the developer declined");
	});

	it("works as a pair: collaboration rules in the prompt, corrections restated and kept as learnings", async () => {
		const requests: TranscriptContext[] = [];
		const record = (text: string) => (context: TranscriptContext) => {
			requests.push(context);
			return fauxAssistantMessage(text);
		};
		const { harness } = await create();
		harness.setResponses([
			record("Proposal: an 8-state machine with retry queues."),
			record("Simplified to four states."),
		]);

		await harness.session.prompt("Design the email delivery states.");
		await harness.session.prompt("Não, simplifica. Quatro estados: pending, sending, sent, unknown.");

		expect(harness.session.systemPrompt).toContain("you own the how");
		expect(getMessageText(requests[0].messages.at(-1))).not.toContain("corrects your previous approach");
		expect(getMessageText(requests[1].messages.at(-1))).toContain("corrects your previous approach");
		const learnings = harness.session.harnessCore
			.describe([])
			.find((section) => section.title.startsWith("Learnings"));
		expect(learnings?.lines[0]).toBe("correction: Não, simplifica. Quatro estados: pending, sending, sent, unknown.");

		const { harness: resumed } = await create({ sessionManager: harness.sessionManager });
		expect(resumed.session.harnessCore.core.alignment?.corrections().map((c) => c.text)).toEqual([
			"Não, simplifica. Quatro estados: pending, sending, sent, unknown.",
		]);
	});

	it("leaves collaboration rules out when the alignment pillar is disabled", async () => {
		const { harness } = await create({ settings: { harnessCore: { alignment: false } } });
		expect(harness.session.systemPrompt).not.toContain("you own the how");
	});

	it("restates constraints next to the latest message and restores them on resume", async () => {
		const requests: TranscriptContext[] = [];
		const { harness } = await create();
		harness.setResponses([
			(context) => {
				requests.push(context);
				return fauxAssistantMessage("Understood.");
			},
		]);

		await harness.session.prompt("Refactor the parser. Never touch package-lock.json.");

		const last = requests[0].messages.at(-1);
		expect(getMessageText(last)).toContain("<harness_state>");
		expect(getMessageText(last)).toContain("Never touch package-lock.json.");
		// The stored prompt is unchanged.
		expect(getUserTexts(harness)).toEqual(["Refactor the parser. Never touch package-lock.json."]);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === HARNESS_CONSTRAINTS_ENTRY),
		).toBe(true);

		const { harness: resumed } = await create({ sessionManager: harness.sessionManager });
		expect(resumed.session.harnessCore.core.alignment?.constraints.list().map((c) => c.text)).toEqual([
			"Never touch package-lock.json.",
		]);
	});
});
