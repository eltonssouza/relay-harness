/**
 * Offline benchmark of the harness pillars on labelled cases and on a recorded session. It needs
 * no model and no network, so it runs in CI and gives each rule change a number: how often the
 * harness stops work that was fine, and how often it lets unverified work through.
 */

import { readFileSync } from "node:fs";
import {
	type AgentMessage,
	type AgentToolCall,
	AlignmentPolicy,
	ContextWindowPolicy,
	classifyCommand,
	classifyToolCall,
	EvidenceLedger,
	extractConstraints,
	isQuestionOnly,
	requiresAuthorization,
	type ToolEffect,
} from "@relay-harness/agent-core";
import {
	ALIGNMENT_CASES,
	type AlignmentCase,
	CHECK_COMMANDS,
	COMPLETION_SCENARIOS,
	CONSTRAINT_CASES,
	type CompletionScenario,
	DECLARED_CHECK_COMMANDS,
	DECLARED_NOT_CHECK_COMMANDS,
	DECLARED_VERIFY_COMMANDS,
	INTENT_CASES,
	KNOWN_FALSE_PROMPTS,
	KNOWN_GAPS,
	NOT_CHECK_COMMANDS,
	RISKY_COMMANDS,
	SAFE_COMMANDS,
} from "./corpus.ts";

/** Where the labelled tool calls run, so paths outside the workspace and in the home directory are judged. */
const WORKSPACE = { cwd: "/work/app", home: "/home/dev" };

const gated = (command: string) => requiresAuthorization(classifyCommand(command).kind);

/** A case that reproduces an open finding. `reproduces` turns false once a fix makes the case pass. */
export interface OpenCase {
	/** The known defect the case reproduces, such as `authorization-by-mention`. */
	finding: string;
	label: string;
	reproduces: boolean;
}

/** Labels of the closed cases the harness gets wrong, and every open case with whether it still reproduces. */
function judge<T extends { open?: string }>(
	items: readonly T[],
	label: (item: T) => string,
	correct: (item: T) => boolean,
): { closed: number; wrong: string[]; open: OpenCase[] } {
	const wrong: string[] = [];
	const open: OpenCase[] = [];
	for (const item of items) {
		const ok = correct(item);
		if (item.open) open.push({ finding: item.open, label: label(item), reproduces: !ok });
		else if (!ok) wrong.push(label(item));
	}
	return { closed: items.length - open.length, wrong, open };
}

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
	open: OpenCase[];
}

export function authorizationMetrics(): AuthorizationMetrics {
	const risky = judge(
		RISKY_COMMANDS,
		(item) => item.command,
		(item) => gated(item.command),
	);
	const safe = judge(
		SAFE_COMMANDS,
		(item) => item.command,
		(item) => !gated(item.command),
	);
	return {
		risky: risky.closed,
		safe: safe.closed,
		falseAllows: risky.wrong,
		falsePrompts: safe.wrong,
		knownGapsStillOpen: KNOWN_GAPS.filter((command) => !gated(command)).length,
		knownGaps: KNOWN_GAPS.length,
		knownFalsePrompts: KNOWN_FALSE_PROMPTS.filter(gated).length,
		open: [...risky.open, ...safe.open],
	};
}

export interface AlignmentMetrics {
	cases: number;
	/** Calls that ran although the developer's messages did not authorize them. */
	falseAllows: string[];
	/** Calls that were stopped although the developer's messages authorized them. */
	falseBlocks: string[];
	open: OpenCase[];
}

/** Runs one case through a fresh alignment policy, retrying the call after the developer's answer. */
async function alignmentDecision(item: AlignmentCase): Promise<"allow" | "block"> {
	const toolCall: AgentToolCall =
		item.write !== undefined
			? { type: "toolCall", id: "bench", name: "write", arguments: { path: item.write, content: "" } }
			: { type: "toolCall", id: "bench", name: "bash", arguments: { command: item.command ?? "" } };
	const effect = classifyToolCall(toolCall, undefined, [], WORKSPACE);
	const policy = new AlignmentPolicy();
	policy.observeDeveloperMessage(item.request, 0, true);
	let decision = await policy.check(toolCall.name, effect);
	if (decision.action === "block" && item.answer !== undefined) {
		policy.observeDeveloperMessage(item.answer, 1, true);
		decision = await policy.check(toolCall.name, effect);
	}
	return decision.action;
}

function alignmentLabel(item: AlignmentCase): string {
	const call = item.write !== undefined ? `write ${item.write}` : item.command;
	return `"${item.request}"${item.answer !== undefined ? ` then "${item.answer}"` : ""} -> ${call}`;
}

export async function alignmentMetrics(): Promise<AlignmentMetrics> {
	const decisions = new Map<AlignmentCase, "allow" | "block">();
	for (const item of ALIGNMENT_CASES) decisions.set(item, await alignmentDecision(item));
	const correct = (item: AlignmentCase) => decisions.get(item) === item.expected;
	const shouldBlock = judge(
		ALIGNMENT_CASES.filter((item) => item.expected === "block"),
		alignmentLabel,
		correct,
	);
	const shouldAllow = judge(
		ALIGNMENT_CASES.filter((item) => item.expected === "allow"),
		alignmentLabel,
		correct,
	);
	return {
		cases: shouldBlock.closed + shouldAllow.closed,
		falseAllows: shouldBlock.wrong,
		falseBlocks: shouldAllow.wrong,
		open: [...shouldBlock.open, ...shouldAllow.open],
	};
}

export interface VerificationMetrics {
	checks: number;
	notChecks: number;
	/** Commands counted as a check that are not one. */
	falseChecks: string[];
	/** Checks the harness did not recognize. */
	missedChecks: string[];
	open: OpenCase[];
}

function checkMetrics(
	checks: typeof CHECK_COMMANDS,
	notChecks: typeof NOT_CHECK_COMMANDS,
	verifyCommands: readonly string[] = [],
): VerificationMetrics {
	const isCheck = (command: string) => classifyCommand(command, verifyCommands).kind === "verify";
	const recognized = judge(
		checks,
		(item) => item.command,
		(item) => isCheck(item.command),
	);
	const rejected = judge(
		notChecks,
		(item) => item.command,
		(item) => !isCheck(item.command),
	);
	return {
		checks: recognized.closed,
		notChecks: rejected.closed,
		falseChecks: rejected.wrong,
		missedChecks: recognized.wrong,
		open: [...recognized.open, ...rejected.open],
	};
}

export function verificationMetrics(): VerificationMetrics {
	return checkMetrics(CHECK_COMMANDS, NOT_CHECK_COMMANDS);
}

/** Checks when the project declares its verification commands: only those count. */
export function declaredVerificationMetrics(): VerificationMetrics {
	return checkMetrics(DECLARED_CHECK_COMMANDS, DECLARED_NOT_CHECK_COMMANDS, DECLARED_VERIFY_COMMANDS);
}

export interface CompletionMetrics {
	scenarios: number;
	/** Work without evidence that the harness accepted. */
	falseSuccesses: string[];
	/** Work with evidence, or an honest report, that the harness flagged. */
	falseGates: string[];
	open: OpenCase[];
}

const FLAGGED = new Set(["unverified", "contradicted", "no-effect"]);

function scenarioStatus(scenario: CompletionScenario): string {
	const ledger = new EvidenceLedger();
	ledger.beginRequest(true);
	for (const step of scenario.steps) {
		if ("effect" in step) {
			ledger.recordToolOutcome(step.effect, step.isError ?? false, step.output);
			continue;
		}
		if ("shell" in step) {
			const toolCall: AgentToolCall = {
				type: "toolCall",
				id: "bench",
				name: "bash",
				arguments: { command: step.shell },
			};
			const effect = classifyToolCall(toolCall, undefined, [], { cwd: WORKSPACE.cwd });
			ledger.recordToolOutcome(effect, step.isError ?? false, step.output);
			continue;
		}
		const effect: ToolEffect = {
			...classifyCommand(step.check),
			paths: [],
			...(step.scope ? { scope: step.scope } : {}),
		};
		ledger.recordToolOutcome({ ...effect, kind: "verify" }, step.isError ?? false, step.output);
	}
	return ledger.assess(scenario.finalText).status;
}

export function completionMetrics(): CompletionMetrics {
	const statuses = new Map(COMPLETION_SCENARIOS.map((scenario) => [scenario, scenarioStatus(scenario)]));
	const label = (scenario: CompletionScenario) => `${scenario.name}: ${statuses.get(scenario)}`;
	const correct = (scenario: CompletionScenario) =>
		FLAGGED.has(scenario.expected) === FLAGGED.has(statuses.get(scenario) ?? "");
	const shouldFlag = judge(
		COMPLETION_SCENARIOS.filter((scenario) => FLAGGED.has(scenario.expected)),
		label,
		correct,
	);
	const shouldPass = judge(
		COMPLETION_SCENARIOS.filter((scenario) => !FLAGGED.has(scenario.expected)),
		label,
		correct,
	);
	return {
		scenarios: shouldFlag.closed + shouldPass.closed,
		falseSuccesses: shouldFlag.wrong,
		falseGates: shouldPass.wrong,
		open: [...shouldFlag.open, ...shouldPass.open],
	};
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

export interface ConstraintMetrics {
	cases: number;
	/** Messages whose recorded constraints differ from the expected ones. */
	wrong: string[];
	open: OpenCase[];
}

export function constraintMetrics(): ConstraintMetrics {
	const result = judge(
		CONSTRAINT_CASES,
		(item) => `${item.text} -> ${JSON.stringify(extractConstraints(item.text))}`,
		(item) => JSON.stringify(extractConstraints(item.text)) === JSON.stringify(item.expected),
	);
	return { cases: result.closed, wrong: result.wrong, open: result.open };
}

/** Every open case of the corpus. */
export async function openCases(): Promise<OpenCase[]> {
	return [
		...authorizationMetrics().open,
		...(await alignmentMetrics()).open,
		...verificationMetrics().open,
		...declaredVerificationMetrics().open,
		...completionMetrics().open,
		...constraintMetrics().open,
	];
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

export async function formatReport(sessionFile: string): Promise<string> {
	const auth = authorizationMetrics();
	const alignment = await alignmentMetrics();
	const verification = verificationMetrics();
	const declared = declaredVerificationMetrics();
	const completion = completionMetrics();
	const intent = intentMetrics();
	const constraints = constraintMetrics();
	const context = contextMetrics(sessionFile);
	const open = await openCases();
	const list = (items: readonly string[]) =>
		items.length === 0 ? "none" : items.map((item) => `\n    - ${item}`).join("");
	const findings = [...new Set(open.map((item) => item.finding))].sort();
	return [
		"Harness benchmark (offline, labelled cases)",
		"",
		"Authorization",
		`  risky commands let through: ${auth.falseAllows.length}/${auth.risky} (${percent(auth.falseAllows.length / auth.risky)})${auth.falseAllows.length ? list(auth.falseAllows) : ""}`,
		`  safe commands that asked:   ${auth.falsePrompts.length}/${auth.safe} (${percent(auth.falsePrompts.length / auth.safe)})${auth.falsePrompts.length ? list(auth.falsePrompts) : ""}`,
		`  known gaps still open:      ${auth.knownGapsStillOpen}/${auth.knownGaps} (a sandbox is the answer)`,
		`  known false prompts:        ${auth.knownFalsePrompts}/${KNOWN_FALSE_PROMPTS.length} (text match cannot tell a mention from a use)`,
		"",
		"Alignment (developer requests and answers)",
		`  calls run without authorization: ${alignment.falseAllows.length}/${alignment.cases}${alignment.falseAllows.length ? list(alignment.falseAllows) : ""}`,
		`  authorized calls stopped:        ${alignment.falseBlocks.length}/${alignment.cases}${alignment.falseBlocks.length ? list(alignment.falseBlocks) : ""}`,
		"",
		"Verification",
		`  look-alikes counted as checks: ${verification.falseChecks.length}/${verification.notChecks}${verification.falseChecks.length ? list(verification.falseChecks) : ""}`,
		`  checks not recognized:         ${verification.missedChecks.length}/${verification.checks}${verification.missedChecks.length ? list(verification.missedChecks) : ""}`,
		`  with declared commands (${DECLARED_VERIFY_COMMANDS.join(", ")}):`,
		`    other commands counted as checks: ${declared.falseChecks.length}/${declared.notChecks}${declared.falseChecks.length ? list(declared.falseChecks) : ""}`,
		`    declared checks not recognized:   ${declared.missedChecks.length}/${declared.checks}${declared.missedChecks.length ? list(declared.missedChecks) : ""}`,
		"",
		"Completion gate",
		`  unverified work accepted: ${completion.falseSuccesses.length}/${completion.scenarios}${completion.falseSuccesses.length ? list(completion.falseSuccesses) : ""}`,
		`  verified work flagged:    ${completion.falseGates.length}/${completion.scenarios}${completion.falseGates.length ? list(completion.falseGates) : ""}`,
		"",
		"Intent (question-only turns)",
		`  wrong: ${intent.wrong.length}/${intent.cases}${intent.wrong.length ? list(intent.wrong) : ""}`,
		"",
		"Constraints (standing rules recorded from developer messages)",
		`  wrong: ${constraints.wrong.length}/${constraints.cases}${constraints.wrong.length ? list(constraints.wrong) : ""}`,
		"",
		"Context (recorded session replay)",
		`  requests: ${context.requests}, tool results: ${context.toolResults}`,
		`  tool-result characters sent: ${context.charsWithout.toLocaleString()} without, ${context.charsWith.toLocaleString()} with (${percent(context.reduction)} fewer)`,
		`  requests that rewrote cached messages: ${context.cacheBreaksBatched} batched, ${context.cacheBreaksOneByOne} one by one`,
		"",
		"Open findings (kept out of the rates above until fixed)",
		...(findings.length === 0
			? ["  none"]
			: findings.map((finding) => {
					const cases = open.filter((item) => item.finding === finding);
					const reproducing = cases.filter((item) => item.reproduces);
					return `  ${finding}: ${reproducing.length}/${cases.length} cases still reproduce${list(cases.map((item) => `${item.reproduces ? "" : "(fixed) "}${item.label}`))}`;
				})),
		"",
		"Not measured here: task pass rate with a model in the loop. That needs real runs; see packages/evals.",
	].join("\n");
}
