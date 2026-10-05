/**
 * The intake questionnaire: its schema (the `intake_questionnaire` tool parameters), the plain-language
 * check that rejects technical wording, and the layout of the Word document.
 */

import { type Static, Type } from "typebox";
import type { DocxBlock, DocxDocument, DocxParagraph } from "./docx.ts";

const optionSchema = Type.Object({
	label: Type.String({ description: "The choice, in the reader's words (a screen, report or rule they know)." }),
	detail: Type.Optional(Type.String({ description: "One short sentence that explains the choice." })),
});

const questionSchema = Type.Object({
	key: Type.Optional(
		Type.String({ description: "Short id other questions use in onlyIf, for example `retroactive`." }),
	),
	text: Type.String({ description: "The question. One idea, at most 25 words, no technical words." }),
	why: Type.String({ description: "Why the answer matters, in one or two short sentences." }),
	context: Type.Optional(
		Type.String({
			description: "What the system does today that relates to the question, in everyday words (no code names).",
		}),
	),
	kind: Type.Union(
		[
			Type.Literal("single"),
			Type.Literal("multiple"),
			Type.Literal("yes_no"),
			Type.Literal("text"),
			Type.Literal("number"),
			Type.Literal("date"),
			Type.Literal("example"),
		],
		{
			description:
				"single: pick one option. multiple: pick all that apply. yes_no. text/number/date: free answer box. example: a table the reader fills with real examples (columns required).",
		},
	),
	options: Type.Optional(Type.Array(optionSchema, { description: "Choices for single and multiple, at least 2." })),
	columns: Type.Optional(
		Type.Array(Type.String(), { description: "Column titles for kind example, such as inputs and expected result." }),
	),
	example: Type.Optional(Type.String({ description: "A sample answer that shows the level of detail expected." })),
	onlyIf: Type.Optional(
		Type.Object(
			{
				question: Type.String({ description: "key of an earlier question." }),
				answer: Type.String({ description: "The answer to that question that makes this one relevant." }),
			},
			{ description: "Ask this question only when an earlier question got this answer." },
		),
	),
});

export const intakeQuestionnaireSchema = Type.Object({
	title: Type.String({
		description: "Document title, for example `Questions about the change to the price calculation`.",
	}),
	language: Type.String({
		description:
			"BCP 47 tag of the language the questionnaire is written in, the language of the task description (pt-BR, en, es...).",
	}),
	task: Type.String({ description: "The task description exactly as received (shortened when very long)." }),
	summary: Type.String({ description: "What we understood the request to be, in plain words." }),
	findings: Type.Optional(
		Type.Array(Type.String(), {
			description: "What the code analysis found, translated into what people see and do. No file or code names.",
		}),
	),
	sections: Type.Array(
		Type.Object({
			title: Type.String({ description: "Topic of the questions, for example `Which calculation`." }),
			intro: Type.Optional(Type.String({ description: "One or two sentences that set up the topic." })),
			questions: Type.Array(questionSchema, { minItems: 1 }),
		}),
		{ minItems: 1 },
	),
	glossary: Type.Optional(
		Type.Array(Type.Object({ term: Type.String(), meaning: Type.String() }), {
			description: "Words the reader may not know, each explained as to a 12-year-old.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description:
				"Where to write the .docx, relative to the working directory. Default: .relay/intake/<date>-<title>.docx",
		}),
	),
});

export type IntakeQuestionnaire = Static<typeof intakeQuestionnaireSchema>;
type Question = IntakeQuestionnaire["sections"][number]["questions"][number];

export interface IntakeLabels {
	date: string;
	answeredBy: string;
	request: string;
	understood: string;
	found: string;
	howToAnswer: string;
	howToAnswerSteps: string[];
	question: string;
	why: string;
	today: string;
	chooseOne: string;
	chooseMany: string;
	writeAnswer: string;
	fillTable: string;
	example: string;
	other: string;
	dontKnow: string;
	yes: string;
	no: string;
	comments: string;
	onlyIf: (answer: string, question: number) => string;
	glossary: string;
	term: string;
	meaning: string;
	closing: string;
}

const LABELS: Record<"en" | "pt" | "es", IntakeLabels> = {
	en: {
		date: "Date",
		answeredBy: "Who answered",
		request: "The request we received",
		understood: "What we understood",
		found: "What we found in the system today",
		howToAnswer: "How to answer",
		howToAnswerSteps: [
			"Read each question calmly. There are no wrong answers.",
			"Mark your choice by replacing ☐ with ☒, or write inside the box.",
			"If you are not sure, mark “I don't know”. That helps us too.",
			"Write examples with real numbers and names whenever you can.",
			"When you finish, save the file and send it back to the person who sent it to you.",
		],
		question: "Question",
		why: "Why we ask",
		today: "How it works today",
		chooseOne: "Choose one option.",
		chooseMany: "Choose all options that apply.",
		writeAnswer: "Write your answer in the box.",
		fillTable: "Fill in the table with real examples. One example per line.",
		example: "Example of an answer",
		other: "Other:",
		dontKnow: "I don't know",
		yes: "Yes",
		no: "No",
		comments: "Anything to add? (optional)",
		onlyIf: (answer, question) => `Answer only if you answered “${answer}” in question ${question}.`,
		glossary: "Words you may not know",
		term: "Word",
		meaning: "What it means",
		closing: "Thank you! Your answers tell us exactly what to build, so nobody needs to ask you again.",
	},
	pt: {
		date: "Data",
		answeredBy: "Quem respondeu",
		request: "O pedido que recebemos",
		understood: "O que entendemos",
		found: "O que encontramos no sistema hoje",
		howToAnswer: "Como responder",
		howToAnswerSteps: [
			"Leia cada pergunta com calma. Não existe resposta errada.",
			"Marque sua escolha trocando ☐ por ☒, ou escreva dentro do quadro.",
			"Se não tiver certeza, marque “Não sei”. Isso também nos ajuda.",
			"Sempre que puder, escreva exemplos com números e nomes reais.",
			"No final, salve o arquivo e devolva para quem enviou para você.",
		],
		question: "Pergunta",
		why: "Por que perguntamos",
		today: "Como funciona hoje",
		chooseOne: "Escolha uma opção.",
		chooseMany: "Escolha todas as opções que valem.",
		writeAnswer: "Escreva sua resposta no quadro.",
		fillTable: "Preencha a tabela com exemplos reais. Um exemplo por linha.",
		example: "Exemplo de resposta",
		other: "Outro:",
		dontKnow: "Não sei",
		yes: "Sim",
		no: "Não",
		comments: "Quer explicar melhor? (opcional)",
		onlyIf: (answer, question) => `Responda só se você respondeu “${answer}” na pergunta ${question}.`,
		glossary: "Palavras que talvez você não conheça",
		term: "Palavra",
		meaning: "O que quer dizer",
		closing: "Obrigado! Com suas respostas sabemos exatamente o que fazer, e ninguém vai precisar perguntar de novo.",
	},
	es: {
		date: "Fecha",
		answeredBy: "Quién respondió",
		request: "El pedido que recibimos",
		understood: "Lo que entendimos",
		found: "Lo que encontramos hoy en el sistema",
		howToAnswer: "Cómo responder",
		howToAnswerSteps: [
			"Lee cada pregunta con calma. No hay respuestas incorrectas.",
			"Marca tu elección cambiando ☐ por ☒, o escribe dentro del cuadro.",
			"Si no estás seguro, marca “No sé”. Eso también nos ayuda.",
			"Siempre que puedas, escribe ejemplos con números y nombres reales.",
			"Al terminar, guarda el archivo y devuélvelo a quien te lo envió.",
		],
		question: "Pregunta",
		why: "Por qué preguntamos",
		today: "Cómo funciona hoy",
		chooseOne: "Elige una opción.",
		chooseMany: "Elige todas las opciones que correspondan.",
		writeAnswer: "Escribe tu respuesta en el cuadro.",
		fillTable: "Completa la tabla con ejemplos reales. Un ejemplo por línea.",
		example: "Ejemplo de respuesta",
		other: "Otro:",
		dontKnow: "No sé",
		yes: "Sí",
		no: "No",
		comments: "¿Quieres agregar algo? (opcional)",
		onlyIf: (answer, question) => `Responde solo si respondiste “${answer}” en la pregunta ${question}.`,
		glossary: "Palabras que quizás no conozcas",
		term: "Palabra",
		meaning: "Qué significa",
		closing: "¡Gracias! Con tus respuestas sabemos exactamente qué hacer, y nadie tendrá que preguntarte de nuevo.",
	},
};

/** Labels for a BCP 47 tag; languages without a translation get English. */
export function intakeLabels(language: string): IntakeLabels {
	const base = language.toLowerCase().split(/[-_]/)[0];
	return base === "pt" || base === "es" ? LABELS[base] : LABELS.en;
}

/**
 * Words a reader without technical background does not know. English and Portuguese, since task
 * descriptions arrive in both. Common words with a technical sense (function, class, server) are left out.
 */
const JARGON = [
	"api",
	"apis",
	"endpoint",
	"endpoints",
	"backend",
	"back-end",
	"frontend",
	"front-end",
	"database",
	"banco de dados",
	"sql",
	"query",
	"queries",
	"json",
	"xml",
	"yaml",
	"schema",
	"deploy",
	"deployment",
	"cache",
	"cron",
	"null",
	"boolean",
	"string",
	"array",
	"regex",
	"payload",
	"refactor",
	"refatorar",
	"refatoração",
	"commit",
	"branch",
	"merge",
	"pull request",
	"repository",
	"repositório",
	"stack trace",
	"runtime",
	"framework",
	"microservice",
	"microsserviço",
	"middleware",
	"webhook",
	"token",
	"hash",
	"script",
	"enum",
	"timestamp",
	"crud",
	"orm",
	"dto",
	"callback",
	"async",
	"thread",
	"mock",
	"pipeline",
	"docker",
	"kubernetes",
	"tabela do banco",
	"stored procedure",
	"trigger",
	"job",
	"batch",
	"flag",
	"feature flag",
	"rollback",
	"log",
	"logs",
];

const MAX_SENTENCE_WORDS = 30;

export interface PlainLanguageIssue {
	where: string;
	problem: string;
}

/** Normalized form for matching: lowercase without accents. */
function fold(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase();
}

function containsTerm(text: string, term: string): boolean {
	const escaped = fold(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(fold(text));
}

const CODE_PATTERNS: Array<{ pattern: RegExp; problem: string }> = [
	{ pattern: /`[^`]+`/, problem: "uses code formatting (backticks)" },
	{ pattern: /\b\p{Ll}+\p{Lu}\p{L}*\b/u, problem: "contains a camelCase code name" },
	{ pattern: /\b\p{L}+_\p{L}+\b/u, problem: "contains a snake_case code name" },
	{
		pattern:
			/\b[\w-]+\.(ts|tsx|js|jsx|mjs|java|kt|cs|py|rb|go|php|sql|json|ya?ml|xml|vue|svelte|rs|swift|c|cpp|h)\b/i,
		problem: "contains a file name",
	},
	// Dates such as 31/12/2024 also contain slashes, so only paths that start like one count.
	{ pattern: /(^|\s)(\.{1,2}\/|(src|lib|app|packages|test|tests)\/)[\w./-]+/, problem: "contains a folder path" },
	{ pattern: /\w+\(\)/, problem: "contains a function call" },
];

function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

/**
 * Checks that a 12-year-old without technical background can read the questionnaire: no technical
 * words (unless the glossary explains them), no code names, short sentences. The original task text
 * and the glossary itself are not checked.
 */
export function checkPlainLanguage(questionnaire: IntakeQuestionnaire): PlainLanguageIssue[] {
	const explained = (questionnaire.glossary ?? []).map((entry) => entry.term);
	const issues: PlainLanguageIssue[] = [];
	const check = (where: string, text: string | undefined) => {
		if (!text) return;
		for (const term of JARGON) {
			if (containsTerm(text, term) && !explained.some((word) => containsTerm(word, term))) {
				issues.push({
					where,
					problem: `uses the technical word "${term}"; say it in everyday words or explain it in the glossary`,
				});
			}
		}
		for (const { pattern, problem } of CODE_PATTERNS) {
			if (pattern.test(text)) issues.push({ where, problem });
		}
		for (const sentence of sentences(text)) {
			const words = sentence.split(/\s+/).length;
			if (words > MAX_SENTENCE_WORDS) {
				issues.push({
					where,
					problem: `has a sentence of ${words} words; split it (at most ${MAX_SENTENCE_WORDS})`,
				});
			}
		}
	};
	check("title", questionnaire.title);
	check("summary", questionnaire.summary);
	for (const [i, finding] of (questionnaire.findings ?? []).entries()) check(`findings[${i}]`, finding);
	questionnaire.sections.forEach((section, s) => {
		check(`sections[${s}].title`, section.title);
		check(`sections[${s}].intro`, section.intro);
		section.questions.forEach((question, q) => {
			const where = `sections[${s}].questions[${q}]`;
			check(`${where}.text`, question.text);
			check(`${where}.why`, question.why);
			check(`${where}.context`, question.context);
			check(`${where}.example`, question.example);
			question.options?.forEach((option, o) => {
				check(`${where}.options[${o}].label`, option.label);
				check(`${where}.options[${o}].detail`, option.detail);
			});
			for (const [c, column] of (question.columns ?? []).entries()) check(`${where}.columns[${c}]`, column);
		});
	});
	return issues;
}

/** Structural problems: choices without options, examples without columns, broken onlyIf references. */
export function checkStructure(questionnaire: IntakeQuestionnaire): string[] {
	const problems: string[] = [];
	const keys = new Set<string>();
	const texts = new Set<string>();
	questionnaire.sections.forEach((section, s) => {
		section.questions.forEach((question, q) => {
			const where = `sections[${s}].questions[${q}]`;
			if ((question.kind === "single" || question.kind === "multiple") && (question.options?.length ?? 0) < 2) {
				problems.push(`${where}: kind ${question.kind} needs at least 2 options`);
			}
			if (question.kind === "example" && (question.columns?.length ?? 0) === 0) {
				problems.push(`${where}: kind example needs columns`);
			}
			if (question.onlyIf && !keys.has(question.onlyIf.question)) {
				problems.push(
					`${where}: onlyIf refers to "${question.onlyIf.question}", which is not the key of an earlier question`,
				);
			}
			const text = fold(question.text).replace(/\W+/g, " ").trim();
			if (texts.has(text)) problems.push(`${where}: repeats an earlier question`);
			texts.add(text);
			if (question.key) {
				if (keys.has(question.key)) problems.push(`${where}: key "${question.key}" is used twice`);
				keys.add(question.key);
			}
		});
	});
	return problems;
}

export function questionCount(questionnaire: IntakeQuestionnaire): number {
	return questionnaire.sections.reduce((total, section) => total + section.questions.length, 0);
}

const paragraph = (text: string, style: DocxParagraph["style"] = "Normal"): DocxParagraph => ({
	type: "paragraph",
	style,
	runs: [{ text }],
});
const box = (lines = 3): DocxBlock => ({ type: "table", rows: [[""]], rowHeight: 300 * lines });
const checkbox = (label: string, detail?: string): DocxParagraph => ({
	type: "paragraph",
	indent: 284,
	runs: [{ text: `☐  ${label}` }, ...(detail ? [{ text: ` — ${detail}`, color: "595959" }] : [])],
});

function questionBlocks(
	question: Question,
	number: number,
	labels: IntakeLabels,
	numbers: Map<string, number>,
): DocxBlock[] {
	const blocks: DocxBlock[] = [
		{
			type: "paragraph",
			style: "Heading2",
			runs: [{ text: `${labels.question} ${number}. ` }, { text: question.text }],
		},
	];
	if (question.onlyIf) {
		const target = numbers.get(question.onlyIf.question) ?? 0;
		blocks.push({
			type: "paragraph",
			style: "Hint",
			runs: [{ text: labels.onlyIf(question.onlyIf.answer, target), bold: true }],
		});
	}
	blocks.push({
		type: "paragraph",
		style: "Callout",
		runs: [{ text: `${labels.why}: `, bold: true }, { text: question.why }],
	});
	if (question.context) {
		blocks.push({
			type: "paragraph",
			style: "Callout",
			runs: [{ text: `${labels.today}: `, bold: true }, { text: question.context }],
		});
	}
	switch (question.kind) {
		case "single":
		case "multiple":
			blocks.push(paragraph(question.kind === "single" ? labels.chooseOne : labels.chooseMany, "Hint"));
			for (const option of question.options ?? []) blocks.push(checkbox(option.label, option.detail));
			blocks.push(checkbox(`${labels.other} ____________________________`), checkbox(labels.dontKnow));
			blocks.push(paragraph(labels.comments, "Hint"), box(2));
			break;
		case "yes_no":
			blocks.push(paragraph(labels.chooseOne, "Hint"));
			blocks.push(checkbox(labels.yes), checkbox(labels.no), checkbox(labels.dontKnow));
			blocks.push(paragraph(labels.comments, "Hint"), box(2));
			break;
		case "example":
			blocks.push(paragraph(labels.fillTable, "Hint"));
			blocks.push({ type: "table", header: question.columns ?? [], rows: [[], [], [], []], rowHeight: 500 });
			break;
		default:
			blocks.push(paragraph(labels.writeAnswer, "Hint"), box(question.kind === "text" ? 4 : 1));
	}
	if (question.example) {
		blocks.push({
			type: "paragraph",
			style: "Hint",
			runs: [{ text: `${labels.example}: `, bold: true }, { text: question.example }],
		});
	}
	return blocks;
}

export function questionnaireToDocx(questionnaire: IntakeQuestionnaire, date: Date = new Date()): DocxDocument {
	const labels = intakeLabels(questionnaire.language);
	const blocks: DocxBlock[] = [
		paragraph(questionnaire.title, "Title"),
		paragraph(`${labels.date}: ${date.toISOString().slice(0, 10)}`, "Subtitle"),
		paragraph(`${labels.answeredBy}: ____________________________________________`),
		paragraph(labels.request, "Heading1"),
		{ type: "paragraph", style: "Callout", runs: [{ text: questionnaire.task, italic: true }] },
		paragraph(labels.understood, "Heading1"),
		paragraph(questionnaire.summary),
	];
	if (questionnaire.findings && questionnaire.findings.length > 0) {
		blocks.push(paragraph(labels.found, "Heading1"));
		for (const finding of questionnaire.findings)
			blocks.push({ type: "paragraph", indent: 284, runs: [{ text: `•  ${finding}` }] });
	}
	blocks.push(paragraph(labels.howToAnswer, "Heading1"));
	for (const [i, step] of labels.howToAnswerSteps.entries()) {
		blocks.push({ type: "paragraph", indent: 284, runs: [{ text: `${i + 1}.  ${step}` }] });
	}

	const numbers = new Map<string, number>();
	let number = 0;
	for (const section of questionnaire.sections) {
		blocks.push(paragraph(section.title, "Heading1"));
		if (section.intro) blocks.push(paragraph(section.intro));
		for (const question of section.questions) {
			number++;
			blocks.push(...questionBlocks(question, number, labels, numbers));
			if (question.key) numbers.set(question.key, number);
		}
	}

	if (questionnaire.glossary && questionnaire.glossary.length > 0) {
		blocks.push(paragraph(labels.glossary, "Heading1"));
		blocks.push({
			type: "table",
			header: [labels.term, labels.meaning],
			rows: questionnaire.glossary.map((entry) => [entry.term, entry.meaning]),
		});
	}
	blocks.push(paragraph(labels.closing, "Subtitle"));
	return { title: questionnaire.title, language: questionnaire.language, blocks };
}
