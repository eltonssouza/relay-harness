import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { fauxAssistantMessage, fauxToolCall } from "@relay-harness/ai";
import { afterEach, describe, expect, it } from "vitest";
import { renderDocx } from "../src/extensions/intake/docx.ts";
import intakeExtension, { intakeOutputPath, writeIntakeQuestionnaire } from "../src/extensions/intake/index.ts";
import { buildIntakePrompt, INTAKE_TOOL_NAME } from "../src/extensions/intake/prompt.ts";
import {
	checkPlainLanguage,
	checkStructure,
	type IntakeQuestionnaire,
	questionnaireToDocx,
} from "../src/extensions/intake/questionnaire.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/** Entries of a ZIP archive, read through its central directory. */
function unzip(archive: Buffer): Map<string, string> {
	const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	const count = archive.readUInt16LE(end + 10);
	let offset = archive.readUInt32LE(end + 16);
	const files = new Map<string, string>();
	for (let i = 0; i < count; i++) {
		expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
		const size = archive.readUInt32LE(offset + 20);
		const nameLength = archive.readUInt16LE(offset + 28);
		const local = archive.readUInt32LE(offset + 42);
		const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
		const dataStart = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
		files.set(name, inflateRawSync(archive.subarray(dataStart, dataStart + size)).toString("utf8"));
		offset += 46 + nameLength;
	}
	return files;
}

const questionnaire: IntakeQuestionnaire = {
	title: "Perguntas sobre a mudança no cálculo",
	language: "pt-BR",
	task: "alterar cálculo",
	summary: "Vocês pediram para mudar um cálculo, mas não disseram qual. O sistema faz três cálculos diferentes.",
	findings: ["A tela de Pedidos calcula o total somando os itens e tirando o desconto."],
	sections: [
		{
			title: "Qual cálculo",
			questions: [
				{
					key: "which",
					text: "Qual destes cálculos vocês querem mudar?",
					why: "O sistema tem três cálculos. Precisamos saber qual mexer.",
					kind: "single",
					options: [
						{ label: "Total do pedido", detail: "o valor que aparece no fim da tela de Pedidos" },
						{ label: "Comissão do vendedor" },
					],
				},
				{
					key: "old",
					text: "Os pedidos antigos também devem mudar?",
					why: "Se mudarmos os antigos, os relatórios do passado vão mostrar outros números.",
					kind: "yes_no",
				},
				{
					text: "A partir de que dia os pedidos antigos devem mudar?",
					why: "Assim sabemos até onde voltar.",
					kind: "date",
					onlyIf: { question: "old", answer: "Sim" },
				},
				{
					text: "Mostre exemplos de como o total deve ficar.",
					why: "Com exemplos reais conferimos se a conta ficou certa.",
					kind: "example",
					columns: ["Preço", "Desconto", "Total que você espera"],
				},
			],
		},
	],
	glossary: [{ term: "Relatório", meaning: "Uma página que junta números para conferir." }],
};

describe("intake questionnaire checks", () => {
	it("accepts plain language", () => {
		expect(checkPlainLanguage(questionnaire)).toEqual([]);
		expect(checkStructure(questionnaire)).toEqual([]);
	});

	it("rejects technical words, code names and long sentences", () => {
		const technical: IntakeQuestionnaire = {
			...questionnaire,
			summary: "O endpoint de pedidos chama calcTotal() em src/orders/total.ts e grava no banco de dados.",
			findings: [`Uma frase ${"muito ".repeat(30)}longa.`],
		};
		const problems = checkPlainLanguage(technical).map((issue) => `${issue.where}: ${issue.problem}`);
		expect(problems).toEqual(
			expect.arrayContaining([
				expect.stringContaining('summary: uses the technical word "endpoint"'),
				expect.stringContaining('summary: uses the technical word "banco de dados"'),
				"summary: contains a camelCase code name",
				"summary: contains a file name",
				"summary: contains a folder path",
				"summary: contains a function call",
				expect.stringMatching(/^findings\[0\]: has a sentence of \d+ words/),
			]),
		);
	});

	it("allows technical words the glossary explains, and dates with slashes", () => {
		const explained: IntakeQuestionnaire = {
			...questionnaire,
			summary: "O cache guarda o total desde 01/02/2024.",
			glossary: [{ term: "Cache", meaning: "Uma cópia guardada para o sistema responder mais rápido." }],
		};
		expect(checkPlainLanguage(explained)).toEqual([]);
	});

	it("reports choices without options and broken conditions", () => {
		const broken: IntakeQuestionnaire = {
			...questionnaire,
			sections: [
				{
					title: "Erros",
					questions: [
						{ text: "Qual?", why: "Saber.", kind: "multiple", options: [{ label: "Um" }] },
						{ text: "Exemplos?", why: "Conferir.", kind: "example" },
						{ text: "Quando?", why: "Saber.", kind: "date", onlyIf: { question: "later", answer: "Sim" } },
						{ key: "later", text: "Qual?", why: "Saber.", kind: "text" },
					],
				},
			],
		};
		expect(checkStructure(broken)).toEqual([
			"sections[0].questions[0]: kind multiple needs at least 2 options",
			"sections[0].questions[1]: kind example needs columns",
			'sections[0].questions[2]: onlyIf refers to "later", which is not the key of an earlier question',
			"sections[0].questions[3]: repeats an earlier question",
		]);
	});
});

describe("intake docx", () => {
	it("writes a Word package with the questions, choices, answer boxes and glossary", () => {
		const files = unzip(renderDocx(questionnaireToDocx(questionnaire, new Date("2026-10-05T12:00:00Z"))));
		expect([...files.keys()]).toEqual([
			"[Content_Types].xml",
			"_rels/.rels",
			"word/document.xml",
			"word/_rels/document.xml.rels",
			"word/styles.xml",
			"docProps/core.xml",
		]);
		const document = files.get("word/document.xml")!;
		const text = [...document.matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/g)].map((m) => m[1]).join("\n");
		expect(text).toContain("Data: 2026-10-05");
		expect(text).toContain("Pergunta 1. \nQual destes cálculos vocês querem mudar?");
		expect(text).toContain("☐  Total do pedido\n — o valor que aparece no fim da tela de Pedidos");
		expect(text).toContain("☐  Não sei");
		expect(text).toContain("Responda só se você respondeu “Sim” na pergunta 2.");
		expect(text).toContain("Total que você espera");
		expect(text).toContain("Palavras que talvez você não conheça");
		expect(document).toContain('<w:pStyle w:val="Heading1"/>');
		expect(files.get("docProps/core.xml")).toContain("<dc:language>pt-BR</dc:language>");
	});

	it("escapes XML and drops characters XML cannot hold", () => {
		const files = unzip(
			renderDocx({
				title: "t",
				language: "en",
				blocks: [{ type: "paragraph", runs: [{ text: 'a < b & "c"\u0001' }] }],
			}),
		);
		expect(files.get("word/document.xml")).toContain("a &lt; b &amp; &quot;c&quot;</w:t>");
	});

	it("names the file after the date and title unless a path is given", () => {
		const date = new Date("2026-10-05T12:00:00Z");
		expect(intakeOutputPath("/repo", { title: "Mudança no cálculo!" }, date)).toBe(
			resolve("/repo", ".relay", "intake", "2026-10-05-mudanca-no-calculo.docx"),
		);
		expect(intakeOutputPath("/repo", { title: "x", path: "docs/perguntas" }, date)).toBe(
			resolve("/repo", "docs", "perguntas.docx"),
		);
	});
});

describe("/intake", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("sends the analysis instructions and writes the questionnaire the agent produces", async () => {
		harness = await createHarness({
			settings: { harnessCore: { evidence: false } },
			extensionFactories: [intakeExtension],
		});
		expect(harness.session.getActiveToolNames()).not.toContain(INTAKE_TOOL_NAME);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(INTAKE_TOOL_NAME, { ...questionnaire, summary: "Vamos mudar o endpoint." }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall(INTAKE_TOOL_NAME, { ...questionnaire, path: "perguntas" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Escrevi 4 perguntas em perguntas.docx"),
		]);

		await harness.session.prompt("/intake alterar cálculo");
		await harness.session.agent.waitForIdle();

		expect(harness.session.getActiveToolNames()).toContain(INTAKE_TOOL_NAME);
		const user = harness.session.messages.find((message) => message.role === "user");
		expect(JSON.stringify(user?.content)).toContain("alterar cálculo");
		const results = harness.session.messages.flatMap((message) => (message.role === "toolResult" ? [message] : []));
		// The first call used a technical word and was sent back to be rewritten.
		expect(results.map((result) => result.isError)).toEqual([true, false]);
		expect(JSON.stringify(results[0].content)).toContain('uses the technical word \\"endpoint\\"');
		const path = join(harness.tempDir, "perguntas.docx");
		expect(existsSync(path)).toBe(true);
		expect(unzip(readFileSync(path)).get("word/document.xml")).toContain("Comissão do vendedor");
	});

	it("builds the prompt with the output path", () => {
		const prompt = buildIntakePrompt("alterar cálculo", { path: "out.docx" });
		expect(prompt).toContain("<task-description>\nalterar cálculo\n</task-description>");
		expect(prompt).toContain(`call the \`${INTAKE_TOOL_NAME}\` tool with the questionnaire and path "out.docx"`);
	});

	it("does not write a questionnaire that fails the checks", () => {
		const dir = join(harness?.tempDir ?? process.cwd(), "unused");
		expect(() => writeIntakeQuestionnaire(dir, { ...questionnaire, summary: "Veja o arquivo total.ts" })).toThrow(
			"contains a file name",
		);
		expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
	});
});
