/**
 * `/intake`: turns a vague or scattered task description into a Word questionnaire for the people
 * who wrote it. The agent analyzes the code, finds what the description leaves open, and writes the
 * questions in plain language through the `intake_questionnaire` tool.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import { renderDocx } from "./docx.ts";
import { buildIntakePrompt, INTAKE_TOOL_NAME } from "./prompt.ts";
import {
	checkPlainLanguage,
	checkStructure,
	type IntakeQuestionnaire,
	intakeQuestionnaireSchema,
	questionCount,
	questionnaireToDocx,
} from "./questionnaire.ts";

export interface IntakeToolDetails {
	path: string;
	questions: number;
}

/** File name part of a title: lowercase ASCII words joined by dashes. */
function slug(title: string): string {
	const words = title
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return words.slice(0, 60).replace(/-$/, "") || "intake";
}

export function intakeOutputPath(
	cwd: string,
	questionnaire: Pick<IntakeQuestionnaire, "title" | "path">,
	date: Date,
): string {
	const requested = questionnaire.path?.trim();
	if (requested) {
		const path = isAbsolute(requested) ? requested : resolve(cwd, requested);
		return path.toLowerCase().endsWith(".docx") ? path : `${path}.docx`;
	}
	return resolve(
		cwd,
		CONFIG_DIR_NAME,
		"intake",
		`${date.toISOString().slice(0, 10)}-${slug(questionnaire.title)}.docx`,
	);
}

/** Validates the questionnaire and writes the .docx. Problems are thrown so the model rewrites. */
export function writeIntakeQuestionnaire(
	cwd: string,
	questionnaire: IntakeQuestionnaire,
	date: Date = new Date(),
): IntakeToolDetails {
	const problems = [
		...checkStructure(questionnaire),
		...checkPlainLanguage(questionnaire).map((issue) => `${issue.where} ${issue.problem}`),
	];
	if (problems.length > 0) {
		throw new Error(
			`The questionnaire was not written. Fix these points so a 12-year-old without technical knowledge can answer, then call ${INTAKE_TOOL_NAME} again:\n${problems
				.map((problem) => `- ${problem}`)
				.join("\n")}`,
		);
	}
	const path = intakeOutputPath(cwd, questionnaire, date);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, renderDocx(questionnaireToDocx(questionnaire, date)));
	return { path, questions: questionCount(questionnaire) };
}

export function createIntakeToolDefinition(): ToolDefinition<typeof intakeQuestionnaireSchema, IntakeToolDetails> {
	return {
		name: INTAKE_TOOL_NAME,
		label: "Intake questionnaire",
		description:
			"Write a requirements questionnaire as a Word (.docx) document for the non-technical people who wrote a task. Use after analyzing the task description and the code. Rejects technical words, code names and sentences over 30 words; rewrite and call again when it does.",
		parameters: intakeQuestionnaireSchema,
		// Loaded by /intake, or found by tool search when a user asks for a questionnaire directly.
		exposure: "deferred",
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const details = writeIntakeQuestionnaire(ctx.cwd, params);
			return {
				content: [{ type: "text", text: `Wrote ${details.questions} questions to ${details.path}` }],
				details,
			};
		},
	};
}

const USAGE = "Usage: /intake [--out <file.docx>] <task description, or files and links that describe it>";

export default function intakeExtension(relay: ExtensionAPI): void {
	relay.registerTool(createIntakeToolDefinition());

	relay.registerCommand("intake", {
		description: "Turn a vague task into a plain-language .docx questionnaire for its authors",
		handler: async (args, ctx) => {
			const match = /^(?:--out|-o)\s+("[^"]+"|\S+)\s*/.exec(args.trim());
			const path = match?.[1].replace(/^"|"$/g, "");
			const description = (match ? args.trim().slice(match[0].length) : args).trim();
			if (!description) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			const active = relay.getActiveTools();
			if (!active.includes(INTAKE_TOOL_NAME)) relay.setActiveTools([...active, INTAKE_TOOL_NAME]);
			const prompt = buildIntakePrompt(description, { path });
			if (ctx.isIdle()) relay.sendUserMessage(prompt);
			else relay.sendUserMessage(prompt, { deliverAs: "followUp" });
		},
	});
}
