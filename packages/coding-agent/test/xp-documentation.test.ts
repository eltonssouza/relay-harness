import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@relay-harness/agent-core";
import { type ClassifierContext, fauxAssistantMessage, fauxToolCall, type JsonObject } from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import { LAYA_QUESTIONS } from "../src/extensions/laya/questions.ts";
import xpExtension from "../src/extensions/xp/index.ts";
import { XP_PHASE_GUIDANCE, XP_PHASES, type XpPhase, type XpState } from "../src/extensions/xp/workflow.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";
import { xpTestProvider } from "./xp-test-support.ts";

const OUTPUT = "novidades-0.2.0.md";
const MARKDOWN = "# Novidades da versão 0.2.0\n\n- Exportação de documentação.\n";
const call = (name: string, args: JsonObject, id?: string) =>
	fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
const checkpoint = (summary: string, evidenceIds: string[] = []) => call("xp_checkpoint", { summary, evidenceIds });
const latest = (harness: Harness): XpState | undefined => {
	const entry = harness.sessionManager
		.getBranch()
		.findLast((item) => item.type === "custom" && item.customType === "xp.state");
	return entry?.type === "custom" ? (entry.data as XpState) : undefined;
};

// Scripted intent and Laya decisions test Harness behavior, not language-model classification accuracy.
const documentResponses = (continueTask = false) => [
	call("xp_intent", { kind: "task", testsRequired: false, continueTask }),
	call("read", { path: "release-0.2.0.md" }, "source"),
	checkpoint("Planning: document only verified changes in release 0.2.0", ["source"]),
	checkpoint("Design: one Portuguese Markdown file with a heading and verified changes"),
	checkpoint("Testing: compare the version, language and changes against the release fixture"),
	call("write", { path: OUTPUT, content: MARKDOWN }, "artifact"),
	call("read", { path: OUTPUT }, "review"),
	checkpoint("Coding: Markdown saved and reviewed against the release fixture", ["artifact", "review"]),
	checkpoint("Listening: reviewed the delivered file and confirmed the requested scope", ["review"]),
	fauxAssistantMessage("Arquivo Markdown criado e revisado."),
];

function expectDelivery(harness: Harness, goal: string): void {
	expect(readFileSync(join(harness.tempDir, OUTPUT), "utf8")).toBe(MARKDOWN);
	expect(latest(harness)).toMatchObject({
		goal,
		phase: "listening",
		status: "completed",
		automatic: true,
		testsRequired: false,
		listeningReported: true,
		specificationPhases: XP_PHASES,
	});
	expect(harness.session.messages.filter((message) => message.role === "toolResult" && message.isError)).toEqual([]);
	expect(
		harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "xp.handoff"),
	).toEqual([]);
	expect(harness.getPendingResponseCount()).toBe(0);
}

interface DocumentationCase {
	prompt: string;
	phase: XpPhase | "all";
	kind: "skill" | "tool" | "agent" | "all";
	probability: number;
	skillCount: number;
}

const cases: DocumentationCase[] = [
	{
		prompt: "escreva um arquivo em markdown, com todas as novidades que existem na versão 0.2.0",
		phase: "planning",
		kind: "skill",
		probability: 0.417,
		skillCount: 1,
	},
	{
		prompt: "Pode criar um arquivo Markdown com as novidades da versão 0.2.0?",
		phase: "design",
		kind: "tool",
		probability: 0.583,
		skillCount: 1,
	},
	{
		prompt: "Preciso de um resumo em português da release 0.2.0 salvo em Markdown.",
		phase: "testing",
		kind: "agent",
		probability: 0.5,
		skillCount: 1,
	},
	{
		prompt: "gere novidades-0.2.0.md a partir das notas da release",
		phase: "coding",
		kind: "tool",
		probability: 0.417,
		skillCount: 1,
	},
	{
		prompt: "Documente em um arquivo .md as mudanças verificadas da versão 0.2.0.",
		phase: "listening",
		kind: "skill",
		probability: 0.583,
		skillCount: 1,
	},
	{
		prompt: "Write a Portuguese Markdown file listing the verified changes in release 0.2.0.",
		phase: "all",
		kind: "all",
		probability: 0.5,
		skillCount: 1,
	},
	{
		prompt: "Atualize o resumo da release 0.2.0 e salve o resultado em Markdown.",
		phase: "all",
		kind: "skill",
		probability: 0.417,
		skillCount: 55,
	},
	{
		prompt: "Crie um Markdown em português com título, versão 0.2.0 e todas as novidades confirmadas.",
		phase: "all",
		kind: "all",
		probability: 0.583,
		skillCount: 55,
	},
];

describe("XP documentation requests in natural language", () => {
	const harnesses: Harness[] = [];
	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(JSON.stringify({ ok: true, version: "relay-laya-v4" })),
		);
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});
	async function setup(override?: Parameters<typeof xpTestProvider>[0], skillCount = 1): Promise<Harness> {
		let directory = "";
		const readSchema = Type.Object({ path: Type.String() });
		const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });
		const read: AgentTool<typeof readSchema> = {
			name: "read",
			label: "Read",
			description: "Read release notes or review the delivered Markdown",
			parameters: readSchema,
			execute: async (_id, args) => ({
				content: [{ type: "text", text: readFileSync(join(directory, args.path), "utf8") }],
				details: {},
			}),
		};
		const write: AgentTool<typeof writeSchema> = {
			name: "write",
			label: "Write",
			description: "Save the Markdown documentation",
			parameters: writeSchema,
			execute: async (_id, args) => {
				writeFileSync(join(directory, args.path), args.content, "utf8");
				return { content: [{ type: "text", text: "Written" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [read, write],
			settings: { harnessCore: { evidence: false } },
			extensionFactories: [
				xpTestProvider((context, result) => {
					for (const [id, question] of Object.entries(context.questions))
						if (question.instructions.includes(" skill "))
							result.answers[id] = { type: "bool", probability: 0.05 };
					return override?.(context, result) ?? result;
				}),
				(relay) => {
					relay.on("before_agent_start", (event) => {
						event.systemPromptOptions.skills = loadSkillsFromDir({
							dir: join(directory, "skills"),
							source: "path",
						}).skills;
					});
				},
				xpExtension,
			],
		});
		harnesses.push(harness);
		directory = harness.tempDir;
		writeFileSync(join(directory, "release-0.2.0.md"), "# Release 0.2.0\n\n- Added documentation export.\n");
		mkdirSync(join(directory, "skills"));
		for (let index = 0; index < skillCount; index++) {
			const name = index === 0 ? "secure-coding-patterns" : `reference-${index}`;
			writeFileSync(
				join(directory, "skills", `${name}.md`),
				`---\nname: ${name}\ndescription: Technical guidance for ${name}\n---\nReference instructions.\n`,
			);
		}
		await harness.session.modelRuntime.refresh({ allowNetwork: false });
		await harness.session.bindExtensions({});
		return harness;
	}

	// Regression #70: ordinary documentation requests must follow the workflow without slash commands.
	it.each(cases)("delivers '$prompt' after uncertainty in $phase/$kind", async (scenario) => {
		const assessments = new Map<string, number>();
		const phases = new Set<string>();
		const harness = await setup((context, result) => {
			if (!context.state || typeof context.state !== "object" || !("phase" in context.state)) return result;
			const phase = String(context.state.phase);
			if (scenario.phase !== "all" && phase !== scenario.phase) return result;
			for (const [id, question] of Object.entries(context.questions)) {
				if (!id.startsWith("resource_") || question.type !== "bool") continue;
				if (scenario.kind !== "all" && !question.instructions.includes(` ${scenario.kind} `)) continue;
				const key = `${phase}:${id}`;
				const count = (assessments.get(key) ?? 0) + 1;
				assessments.set(key, count);
				phases.add(phase);
				if (count === 1) result.answers[id] = { type: "bool", probability: scenario.probability };
			}
			return result;
		}, scenario.skillCount);
		harness.setResponses(documentResponses());
		await harness.session.prompt(scenario.prompt);
		await harness.session.waitForIdle();
		expectDelivery(harness, scenario.prompt);
		expect(getUserTexts(harness)).toEqual([scenario.prompt]);
		expect([...phases]).toEqual(scenario.phase === "all" ? XP_PHASES : [scenario.phase]);
		expect(assessments.size).toBeGreaterThan(0);
		expect([...assessments.values()].every((count) => count === 2)).toBe(true);
		if (scenario.skillCount > 24) expect(assessments.size).toBeGreaterThan(24);
	});

	it.each([0.2999, 0.3, 0.7, 0.7001])(
		"does not block a confident skill decision at probability %s",
		async (probability) => {
			let assessments = 0;
			const harness = await setup((context, result) => {
				if (
					!context.state ||
					typeof context.state !== "object" ||
					!("phase" in context.state) ||
					context.state.phase !== "planning"
				)
					return result;
				for (const [id, question] of Object.entries(context.questions)) {
					if (!question.instructions.includes("skill secure-coding-patterns")) continue;
					assessments++;
					result.answers[id] = { type: "bool", probability };
				}
				return result;
			});
			const prompt = "Crie as notas da versão 0.2.0 em Markdown.";
			harness.setResponses(documentResponses());
			await harness.session.prompt(prompt);
			await harness.session.waitForIdle();
			expectDelivery(harness, prompt);
			expect(assessments).toBe(1);
			expect(latest(harness)?.phasePlans?.planning?.skills).toEqual(
				probability >= 0.7 ? ["secure-coding-patterns"] : [],
			);
		},
	);

	it("completes every phase when CPU inference rejects oversized resource batches", async () => {
		const assessed = new Map<string, Set<string>>();
		const harness = await setup((context, result) => {
			if (!context.state || typeof context.state !== "object" || !("phase" in context.state)) return result;
			if (Object.keys(context.questions).length > 8)
				return { ...result, stopReason: "error", errorMessage: "CPU inference request timed out" };
			const phase = String(context.state.phase);
			const resources = assessed.get(phase) ?? new Set<string>();
			for (const question of Object.values(context.questions))
				if (question.instructions.includes(" skill ")) resources.add(question.instructions);
			assessed.set(phase, resources);
			return result;
		}, 55);
		const prompt = cases[0].prompt;
		harness.setResponses(documentResponses());
		await harness.session.prompt(prompt);
		await harness.session.waitForIdle();
		expectDelivery(harness, prompt);
		for (const phase of XP_PHASES) expect(assessed.get(phase)?.size).toBe(55);
	});

	it("gives Laya the phase responsibilities and validation requirements for every resource decision", async () => {
		const contexts: ClassifierContext[] = [];
		const harness = await setup((context, result) => {
			if (context.questions.agent) contexts.push(context);
			return result;
		});
		const prompt = cases[0].prompt;
		harness.setResponses(documentResponses());
		await harness.session.prompt(prompt);
		await harness.session.waitForIdle();
		expectDelivery(harness, prompt);
		expect(contexts).toHaveLength(XP_PHASES.length);
		for (const [index, phase] of XP_PHASES.entries()) {
			expect(contexts[index].state).toMatchObject({
				goal: prompt,
				phase,
				phaseGuidance: XP_PHASE_GUIDANCE[phase],
				testsRequired: false,
			});
			expect(contexts[index].questions.agent.instructions).toBe(LAYA_QUESTIONS.agent.instructions);
		}
	});

	it("resumes the same task through ordinary text after persistent uncertainty is resolved", async () => {
		let uncertain = true;
		const harness = await setup((context, result) => {
			for (const [id, question] of Object.entries(context.questions))
				if (uncertain && question.instructions.includes("skill secure-coding-patterns"))
					result.answers[id] = { type: "bool", probability: 0.417 };
			return result;
		});
		const prompt = cases[0].prompt;
		harness.setResponses([
			call("xp_intent", { kind: "task", testsRequired: false }),
			fauxAssistantMessage("Seleção indisponível."),
		]);
		await harness.session.prompt(prompt);
		await harness.session.waitForIdle();
		const original = latest(harness);
		expect(original).toMatchObject({ status: "handoff", phase: "planning", goal: prompt });
		expect(existsSync(join(harness.tempDir, OUTPUT))).toBe(false);
		expect(original?.phasePlans?.planning).toBeUndefined();
		const specificationPath = original?.specificationPath;
		if (!specificationPath) throw new Error("Missing preserved specification");
		expect(existsSync(join(harness.tempDir, specificationPath))).toBe(true);

		uncertain = false;
		harness.setResponses(documentResponses(true));
		await harness.session.prompt("Continue a tarefa e salve o arquivo Markdown.");
		await harness.session.waitForIdle();
		expect(readFileSync(join(harness.tempDir, OUTPUT), "utf8")).toBe(MARKDOWN);
		expect(latest(harness)).toMatchObject({ id: original?.id, goal: prompt, status: "completed", specificationPath });
		expect(getUserTexts(harness)).toEqual([prompt, "Continue a tarefa e salve o arquivo Markdown."]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
