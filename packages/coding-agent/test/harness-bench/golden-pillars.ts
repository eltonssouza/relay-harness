/**
 * Reference results of the alignment and evidence pillars from the TypeScript harness, for other
 * implementations to match: `crates/harness-core/tests/fixtures/pillars.json`, checked by
 * `crates/harness-core/tests/pillars.rs`. Written with the classifications by `npm run harness:golden`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type AgentToolCall,
	type AlignmentDecision,
	AlignmentPolicy,
	classifyCommand,
	classifyToolCall,
	EvidenceLedger,
	extractConstraints,
	formatVerificationRequest,
	isCorrection,
	isQuestionOnly,
	requestsAction,
	type ToolEffect,
} from "@relay-harness/agent-core";
import { ALIGNMENT_CASES, type AlignmentCase, COMPLETION_SCENARIOS, CONSTRAINT_CASES, INTENT_CASES } from "./corpus.ts";

export const PILLARS_FILE = fileURLToPath(
	new URL("../../../../crates/harness-core/tests/fixtures/pillars.json", import.meta.url),
);

const WORKSPACE = { cwd: "/work/app", home: "/home/dev" };

/** Messages beyond the corpus for constraints, intent and corrections. */
const EDGE_TEXTS = [
	"",
	"Never push to main.\nAlways run `npm test` before committing.",
	"- Não use any\n- Use tabs instead of spaces",
	"```\nNever do this\n```\nFix the parser.",
	"Please keep the API stable.",
	"Keep it up!",
	"Só altere o arquivo de testes.",
	"Não sei por que falha.",
	"Não, simplifica isso.",
	"No changes needed here.",
	"Para o módulo de auth, use JWT.",
	"Para! Isso tá complicado demais.",
	"Actually, use the existing helper.",
	"That's too complex, keep it simple.",
	"Wrong file, revert it.",
	"Why does it fail? Please fix it.",
	"How do I run the tests?",
	"Can you explain the cache?",
	"Can you fix the cache?",
	"Is the parser lazy?",
	"Explique o cache de contexto.",
	"O que acontece se eu rodar isso?",
	"Pode corrigir o teste?",
	"Make the build faster.",
	"¿Puedes explicar esto?",
	"Erklär mir das bitte?",
	"Por favor, rode os testes.",
	"Use pnpm rather than npm for every install command in this monorepo.",
	"x".repeat(300),
	"Avoid touching the generated files under src/generated, they are rebuilt on every build.",
];

/** Decisions for answers beyond the corpus, after "Tidy the workspace" blocks `rm -rf build`. */
const EDGE_ANSWERS = [
	"y",
	"S",
	"ok",
	"OK!",
	"go ahead",
	"pode sim",
	"pode apagar",
	"vai em frente",
	"Manda!",
	"isso mesmo",
	"faça isso",
	"sim, mas antes rode os testes",
	"yes but not now",
	"não",
	"why?",
	"what does it delete",
	"sure, go ahead and do it now please thanks a lot",
	"confirmo",
];

function textEntry(text: string) {
	return {
		text,
		constraints: extractConstraints(text),
		questionOnly: isQuestionOnly(text),
		requestsAction: requestsAction(text),
		correction: isCorrection(text),
	};
}

function decision(value: AlignmentDecision) {
	return value.action === "allow"
		? { action: "allow", ...(value.via ? { via: value.via } : {}) }
		: { action: "block", kind: value.kind, reason: value.reason };
}

async function alignmentEntry(item: AlignmentCase) {
	const toolCall: AgentToolCall =
		item.write !== undefined
			? { type: "toolCall", id: "golden", name: "write", arguments: { path: item.write, content: "" } }
			: { type: "toolCall", id: "golden", name: "bash", arguments: { command: item.command ?? "" } };
	const effect = classifyToolCall(toolCall, undefined, [], WORKSPACE);
	const policy = new AlignmentPolicy();
	policy.observeDeveloperMessage(item.request, 0, true);
	const first = await policy.check(toolCall.name, effect);
	let final = first;
	if (first.action === "block" && item.answer !== undefined) {
		policy.observeDeveloperMessage(item.answer, 1, true);
		final = await policy.check(toolCall.name, effect);
	}
	return {
		request: item.request,
		...(item.answer !== undefined ? { answer: item.answer } : {}),
		toolName: toolCall.name,
		...(item.write !== undefined ? { write: item.write } : { command: item.command ?? "" }),
		first: decision(first),
		final: decision(final),
		constraints: policy.constraints.list().map((constraint) => constraint.text),
	};
}

/** The effect a scenario step records, resolved here so other implementations need not repeat it. */
function stepEffect(step: (typeof COMPLETION_SCENARIOS)[number]["steps"][number]): ToolEffect {
	if ("effect" in step) return step.effect;
	if ("shell" in step) {
		return classifyToolCall(
			{ type: "toolCall", id: "golden", name: "bash", arguments: { command: step.shell } },
			undefined,
			[],
			{ cwd: WORKSPACE.cwd },
		);
	}
	return {
		...classifyCommand(step.check),
		paths: [],
		...(step.scope ? { scope: step.scope } : {}),
		kind: "verify",
	};
}

function completionEntry(scenario: (typeof COMPLETION_SCENARIOS)[number]) {
	const ledger = new EvidenceLedger();
	ledger.beginRequest(true);
	const steps = scenario.steps.map((step) => {
		const effect = stepEffect(step);
		const isError = step.isError ?? false;
		const output = step.output ?? "";
		ledger.recordToolOutcome(effect, isError, output);
		return { effect, isError, output };
	});
	const report = ledger.assess(scenario.finalText);
	const gated = ledger.shouldGate(report);
	return {
		name: scenario.name,
		steps,
		finalText: scenario.finalText,
		status: report.status,
		claimed: report.claimed,
		...(report.detail !== undefined ? { detail: report.detail } : {}),
		changedPaths: report.changedPaths,
		mutations: report.mutations,
		pending: ledger.pendingChanges() ?? null,
		gated,
		verificationRequest: gated ? formatVerificationRequest(report) : null,
	};
}

export async function pillarsJson(): Promise<string> {
	const texts = [
		...new Set([
			...CONSTRAINT_CASES.map((item) => item.text),
			...INTENT_CASES.map((item) => item.text),
			...ALIGNMENT_CASES.flatMap((item) => [item.request, ...(item.answer !== undefined ? [item.answer] : [])]),
			...COMPLETION_SCENARIOS.map((scenario) => scenario.finalText),
			...EDGE_TEXTS,
			...EDGE_ANSWERS,
		]),
	];
	const alignment = [];
	for (const item of ALIGNMENT_CASES) alignment.push(await alignmentEntry(item));
	for (const answer of EDGE_ANSWERS) {
		alignment.push(
			await alignmentEntry({ request: "Tidy the workspace", command: "rm -rf build", answer, expected: "block" }),
		);
	}
	const data = {
		texts: texts.map(textEntry),
		alignment,
		completion: COMPLETION_SCENARIOS.map(completionEntry),
	};
	return `${JSON.stringify(data, null, "\t")}\n`;
}

export function readPillars(): string {
	return readFileSync(PILLARS_FILE, "utf8");
}
