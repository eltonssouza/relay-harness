/**
 * Offline benchmark of the harness pillars on labelled cases and on a recorded session. It needs
 * no model and no network, so it runs in CI and gives each rule change a number: how often the
 * harness stops work that was fine, and how often it lets unverified work through.
 */

import { readFileSync } from "node:fs";
import {
	type AgentMessage,
	ContextWindowPolicy,
	classifyCommand,
	EvidenceLedger,
	isQuestionOnly,
	requiresAuthorization,
	type ToolEffect,
} from "@relay-harness/agent-core";
import {
	CHECK_COMMANDS,
	COMPLETION_SCENARIOS,
	INTENT_CASES,
	KNOWN_FALSE_PROMPTS,
	KNOWN_GAPS,
	NOT_CHECK_COMMANDS,
	RISKY_COMMANDS,
	SAFE_COMMANDS,
} from "./corpus.ts";

const gated = (command: string) => requiresAuthorization(classifyCommand(command).kind);

export interface AuthorizationMetrics {
	risky: number;
	safe: number;
	/** Risky commands that ran without asking. */
	falseAllows: string[];
	/** Safe commands that asked. */
	falsePrompts: string[];
	knownGapsStillOpen: number;
	knownGaps: number;
	knownFalsePrompts: number;
}

export function authorizationMetrics(): AuthorizationMetrics {
	return {
		risky: RISKY_COMMANDS.length,
		safe: SAFE_COMMANDS.length,
		falseAllows: RISKY_COMMANDS.filter((command) => !gated(command)),
		falsePrompts: SAFE_COMMANDS.filter(gated),
		knownGapsStillOpen: KNOWN_GAPS.filter((command) => !gated(command)).length,
		knownGaps: KNOWN_GAPS.length,
		knownFalsePrompts: KNOWN_FALSE_PROMPTS.filter(gated).length,
	};
}

export interface VerificationMetrics {
	/** Commands counted as a check that are not one. */
	falseChecks: string[];
	/** Checks the harness did not recognize. */
	missedChecks: string[];
}

export function verificationMetrics(): VerificationMetrics {
	const isCheck = (command: string) => classifyCommand(command).kind === "verify";
	return {
		falseChecks: NOT_CHECK_COMMANDS.filter(isCheck),
		missedChecks: CHECK_COMMANDS.filter((command) => !isCheck(command)),
	};
}

export interface CompletionMetrics {
	scenarios: number;
	/** Work without evidence that the harness accepted. */
	falseSuccesses: string[];
	/** Work with evidence, or an honest report, that the harness flagged. */
	falseGates: string[];
}

export function completionMetrics(): CompletionMetrics {
	const flagged = new Set(["unverified", "contradicted", "no-effect"]);
	const falseSuccesses: string[] = [];
	const falseGates: string[] = [];
	for (const scenario of COMPLETION_SCENARIOS) {
		const ledger = new EvidenceLedger();
		ledger.beginRequest(true);
		for (const step of scenario.steps) {
			if ("effect" in step) {
				ledger.recordToolOutcome(step.effect, step.isError ?? false, step.output);
				continue;
			}
			const effect: ToolEffect = {
				...classifyCommand(step.check),
				paths: [],
				...(step.scope ? { scope: step.scope } : {}),
			};
			ledger.recordToolOutcome({ ...effect, kind: "verify" }, step.isError ?? false, step.output);
		}
		const status = ledger.assess(scenario.finalText).status;
		const shouldFlag = flagged.has(scenario.expected);
		if (shouldFlag && !flagged.has(status)) falseSuccesses.push(`${scenario.name}: ${status}`);
		if (!shouldFlag && flagged.has(status)) falseGates.push(`${scenario.name}: ${status}`);
	}
	return { scenarios: COMPLETION_SCENARIOS.length, falseSuccesses, falseGates };
}

export interface IntentMetrics {
	cases: number;
	wrong: string[];
}

export function intentMetrics(): IntentMetrics {
	return {
		cases: INTENT_CASES.length,
		wrong: INTENT_CASES.filter((item) => isQuestionOnly(item.text) !== item.questionOnly).map((item) => item.text),
	};
}

export interface ContextMetrics {
	requests: number;
	toolResults: number;
	/** Tool-result characters sent over the whole run without the pillar, and with it. */
	charsWithout: number;
	charsWith: number;
	reduction: number;
	/** Requests that rewrote a message the provider had already cached, with batching and with one-by-one elision. */
	cacheBreaksBatched: number;
	cacheBreaksOneByOne: number;
}

function toolResultChars(message: AgentMessage): number {
	if (message.role !== "toolResult") return 0;
	return message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 4000), 0);
}

/** Replays a recorded session request by request through the context pillar. */
export function contextMetrics(sessionFile: string, batchSize = 6): ContextMetrics {
	const messages: AgentMessage[] = [];
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line) as { type?: string; message?: AgentMessage };
		if (entry.type === "message" && entry.message) messages.push(entry.message);
	}

	const replay = (size: number) => {
		const policy = new ContextWindowPolicy({ batchSize: size });
		let charsWith = 0;
		let charsWithout = 0;
		let breaks = 0;
		let requests = 0;
		let previousElided = 0;
		for (let length = 1; length <= messages.length; length++) {
			// A request is made after each user message and each tool result.
			const last = messages[length - 1];
			if (last.role !== "user" && last.role !== "toolResult") continue;
			const sent = messages.slice(0, length);
			const projected = policy.transform(sent);
			requests++;
			let elided = 0;
			for (let index = 0; index < sent.length; index++) {
				charsWithout += toolResultChars(sent[index]);
				charsWith += toolResultChars(projected[index]);
				if (projected[index] !== sent[index]) elided++;
			}
			if (elided > previousElided) breaks++;
			previousElided = elided;
		}
		return { charsWith, charsWithout, breaks, requests };
	};

	const batched = replay(batchSize);
	const oneByOne = replay(1);
	return {
		requests: batched.requests,
		toolResults: messages.filter((message) => message.role === "toolResult").length,
		charsWithout: batched.charsWithout,
		charsWith: batched.charsWith,
		reduction: batched.charsWithout === 0 ? 0 : 1 - batched.charsWith / batched.charsWithout,
		cacheBreaksBatched: batched.breaks,
		cacheBreaksOneByOne: oneByOne.breaks,
	};
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function formatReport(sessionFile: string): string {
	const auth = authorizationMetrics();
	const verification = verificationMetrics();
	const completion = completionMetrics();
	const intent = intentMetrics();
	const context = contextMetrics(sessionFile);
	const list = (items: readonly string[]) =>
		items.length === 0 ? "none" : items.map((item) => `\n    - ${item}`).join("");
	return [
		"Harness benchmark (offline, labelled cases)",
		"",
		"Authorization",
		`  risky commands let through: ${auth.falseAllows.length}/${auth.risky} (${percent(auth.falseAllows.length / auth.risky)})${auth.falseAllows.length ? list(auth.falseAllows) : ""}`,
		`  safe commands that asked:   ${auth.falsePrompts.length}/${auth.safe} (${percent(auth.falsePrompts.length / auth.safe)})${auth.falsePrompts.length ? list(auth.falsePrompts) : ""}`,
		`  known gaps still open:      ${auth.knownGapsStillOpen}/${auth.knownGaps} (a sandbox is the answer)`,
		`  known false prompts:        ${auth.knownFalsePrompts}/${KNOWN_FALSE_PROMPTS.length} (text match cannot tell a mention from a use)`,
		"",
		"Verification",
		`  look-alikes counted as checks: ${verification.falseChecks.length}/${NOT_CHECK_COMMANDS.length}${verification.falseChecks.length ? list(verification.falseChecks) : ""}`,
		`  checks not recognized:         ${verification.missedChecks.length}/${CHECK_COMMANDS.length}${verification.missedChecks.length ? list(verification.missedChecks) : ""}`,
		"",
		"Completion gate",
		`  unverified work accepted: ${completion.falseSuccesses.length}/${completion.scenarios}${completion.falseSuccesses.length ? list(completion.falseSuccesses) : ""}`,
		`  verified work flagged:    ${completion.falseGates.length}/${completion.scenarios}${completion.falseGates.length ? list(completion.falseGates) : ""}`,
		"",
		"Intent (question-only turns)",
		`  wrong: ${intent.wrong.length}/${intent.cases}${intent.wrong.length ? list(intent.wrong) : ""}`,
		"",
		"Context (recorded session replay)",
		`  requests: ${context.requests}, tool results: ${context.toolResults}`,
		`  tool-result characters sent: ${context.charsWithout.toLocaleString()} without, ${context.charsWith.toLocaleString()} with (${percent(context.reduction)} fewer)`,
		`  requests that rewrote cached messages: ${context.cacheBreaksBatched} batched, ${context.cacheBreaksOneByOne} one by one`,
		"",
		"Not measured here: task pass rate with a model in the loop. That needs real runs; see packages/evals.",
	].join("\n");
}
