/**
 * Labelled cases for the harness pillars, loaded from `corpus.json` so that every implementation of
 * the harness is measured against the same cases. Each label is what a careful developer would want,
 * not what the code happens to do, so a rule change that trades one error for another shows up in the
 * rates. Cases the harness is known to get wrong are kept apart and reported, never hidden.
 *
 * A case with `open` reproduces the known defect that `open` names, such as `authorization-by-mention`.
 * Open cases stay out of the floors and must still reproduce, so a fix also removes the marker.
 */

import { readFileSync } from "node:fs";
import type { ToolEffect } from "@relay-harness/agent-core";

/** A command, written as a string, or as an object when it reproduces an open finding. */
type CommandEntry = string | { command: string; open: string };

export interface CommandCase {
	command: string;
	open?: string;
}

export type Step =
	| { effect: ToolEffect; isError?: boolean; output?: string }
	| { check: string; scope?: string[]; isError?: boolean; output?: string }
	/** A shell command classified as the harness would classify it, so what it edits is what the rules see. */
	| { shell: string; isError?: boolean; output?: string };

export interface CompletionScenario {
	name: string;
	steps: Step[];
	finalText: string;
	/** What the harness should conclude. */
	expected: "verified" | "unverified" | "contradicted" | "acknowledged" | "no-claim";
	open?: string;
}

/** A developer message, then one tool call: whether the alignment policy should let the call run. */
export interface AlignmentCase {
	request: string;
	/** The shell command the agent runs; absent when the case writes a file instead. */
	command?: string;
	/** The file the `write` tool writes. */
	write?: string;
	/** The developer's next message, sent after the call was blocked; the call is then retried unchanged. */
	answer?: string;
	expected: "allow" | "block";
	open?: string;
}

export interface IntentCase {
	text: string;
	/** True when the first edit of the turn should wait for the developer. */
	questionOnly: boolean;
}

/** A developer message and the standing rules the harness should record from it. */
export interface ConstraintCase {
	text: string;
	expected: string[];
	open?: string;
}

interface CorpusFile {
	authorization: {
		risky: CommandEntry[];
		safe: CommandEntry[];
		knownGaps: string[];
		knownFalsePrompts: string[];
	};
	alignment: AlignmentCase[];
	verification: { checks: CommandEntry[]; notChecks: CommandEntry[] };
	declaredVerification: { verifyCommands: string[]; checks: CommandEntry[]; notChecks: CommandEntry[] };
	completion: CompletionScenario[];
	intent: IntentCase[];
	constraints: ConstraintCase[];
}

const corpus = JSON.parse(readFileSync(new URL("./corpus.json", import.meta.url), "utf8")) as CorpusFile;

const commandCases = (entries: readonly CommandEntry[]): CommandCase[] =>
	entries.map((entry) => (typeof entry === "string" ? { command: entry } : entry));

/** Commands that must stop and ask. */
export const RISKY_COMMANDS = commandCases(corpus.authorization.risky);

/** Commands that must run without asking. */
export const SAFE_COMMANDS = commandCases(corpus.authorization.safe);

/**
 * Risky commands the harness cannot see. They are why the harness is a safeguard against mistakes,
 * not a security boundary. A sandbox is the answer; this list only keeps the claim honest.
 */
export const KNOWN_GAPS: readonly string[] = corpus.authorization.knownGaps;

/** Safe commands the harness still stops on: a text match cannot tell a mention from a use. */
export const KNOWN_FALSE_PROMPTS: readonly string[] = corpus.authorization.knownFalsePrompts;

/** Developer requests and answers, and the tool calls they should or should not authorize. */
export const ALIGNMENT_CASES: readonly AlignmentCase[] = corpus.alignment;

/** Commands that are checks (their result is evidence) and commands that only look like one. */
export const CHECK_COMMANDS = commandCases(corpus.verification.checks);
export const NOT_CHECK_COMMANDS = commandCases(corpus.verification.notChecks);

/** The same distinction when the project declares its verification commands. */
export const DECLARED_VERIFY_COMMANDS: readonly string[] = corpus.declaredVerification.verifyCommands;
export const DECLARED_CHECK_COMMANDS = commandCases(corpus.declaredVerification.checks);
export const DECLARED_NOT_CHECK_COMMANDS = commandCases(corpus.declaredVerification.notChecks);

export const COMPLETION_SCENARIOS: readonly CompletionScenario[] = corpus.completion;

export const INTENT_CASES: readonly IntentCase[] = corpus.intent;

export const CONSTRAINT_CASES: readonly ConstraintCase[] = corpus.constraints;
