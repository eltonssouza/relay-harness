/**
 * Pillar 2: success requires evidence.
 *
 * Problem: agents report "done" when the environment shows the work failed ("false success").
 * Among failed trajectories, 35.6% (tau2-bench) to 75.8% (AppWorld) were confident false
 * successes; reasoning models rationalize instead of checking; LLM judges anchor on words like
 * "successfully" and stay below AUROC 0.65, while structural signals reach 0.85-0.95
 * (Advani, 2026). Inaccurate self-reports are also 22.6% of real developer-agent misalignment
 * (Tang et al., 2026). A domain where an independent component re-checks the state had 3% false
 * success instead of ~45%.
 *
 * Solution: the harness is that independent component. `EvidenceLedger` records what the tool
 * calls actually did (mutations, verification commands and their exit status) and, when the
 * final message claims completion, compares the claim with that record. The check is
 * structural, needs no extra model call, and runs in microseconds:
 *
 * - changes + no passing check that covers them, when the turn ends -> `unverified`
 *   (an explicit claim is not needed: "I updated the function" ends the turn the same way)
 * - claim that checks pass + the last check failed or none ran        -> `contradicted`
 * - claim + change requested + no change made                         -> `no-effect`
 *
 * A check counts only if it ran tests (an empty run does not), exited successfully, and covers the
 * changed files (a check scoped to another package does not). A flagged report sends one
 * verification request back to the agent instead of ending the run.
 */

import { isMutation, type ToolEffect } from "./effects.ts";
import { clip, wordsPattern } from "./text.ts";

export type CompletionStatus =
	/** Changes were made and a check passed after the last change. */
	| "verified"
	/** The final message claims completion, but no check passed after the last change. */
	| "unverified"
	/** The final message claims checks pass, but the last check failed or none ran. */
	| "contradicted"
	/** The final message claims completion of a requested change, but nothing changed. */
	| "no-effect"
	/** The final message states what was not verified or that the work failed. */
	| "acknowledged"
	/** The final message makes no completion claim that needs evidence. */
	| "no-claim";

export interface VerificationRecord {
	command: string;
	/** Exit status was successful and the run executed at least one test. */
	passed: boolean;
	step: number;
	/** The command ran only tests matching a name pattern (`-t`, `--grep`, `-k`, ...). */
	nameFiltered: boolean;
	/** The command exited successfully but its output says no test ran. */
	empty: boolean;
	/** Directories the check covers; absent when it covers the whole workspace. */
	scope?: string[];
}

/** Output of a test run that executed nothing: a green exit that proves nothing. */
const EMPTY_RUN = [
	/no test files? found/i,
	/no tests? (?:found|ran|were run|were executed|to run|collected)/i,
	/collected 0 items/i,
	/^\s*Tests:\s+0 total/m,
	/^\s*Test Suites:\s+0 total/m,
	/^(?:#|ℹ)\s*tests\s+0\s*$/m,
	/^\s*0 passing\b/m,
	/\bRan 0 tests\b/,
	/\b0 examples, 0 failures\b/,
];

/** Test-runner flags that select tests by name, so the rest of the file or suite does not run. */
const NAME_FILTER = /\s(?:-t|--testNamePattern|--test-name-pattern|--grep|-g|-k|--filter|--test-name)(?:[\s=]|$)/;

export interface CompletionReport {
	status: CompletionStatus;
	/** Whether the final message claims completion. */
	claimed: boolean;
	/** Paths changed during the request, in order of first change. */
	changedPaths: string[];
	mutations: number;
	verifications: VerificationRecord[];
	/** Human-readable reason for a flagged status. */
	detail?: string;
	/** Whether the harness asked the agent to verify before accepting this report. */
	gated: boolean;
}

const COMPLETION_CLAIM = wordsPattern([
	"done",
	"complete",
	"completed",
	"finished",
	"implemented",
	"fixed",
	"resolved",
	"all set",
	"ready",
	"works",
	"working",
	"successfully",
	"concluído",
	"concluída",
	"concluido",
	"pronto",
	"pronta",
	"feito",
	"finalizado",
	"finalizada",
	"implementado",
	"implementada",
	"corrigido",
	"corrigida",
	"resolvido",
	"resolvida",
	"funcionando",
	"funciona",
	"com sucesso",
]);

const CHECK_CLAIM = wordsPattern([
	"tests? (?:now )?pass(?:es|ing|ed)?",
	"all tests pass",
	"(?:build|check|lint|type ?check)s? (?:now )?(?:pass(?:es|ed)?|succeed(?:s|ed)?|is green|are green)",
	"verified",
	"validated",
	"testes (?:agora )?passa(?:m|ram|ndo)",
	"(?:build|check|lint) (?:agora )?(?:passa|passou|passando)",
	"verificad[oa]s?",
	"validad[oa]s?",
]);

/** Claims about the whole suite, which a name-filtered run cannot support. */
const ALL_TESTS_CLAIM = wordsPattern([
	"all (?:the )?tests (?:now )?pass(?:es|ing|ed)?",
	"(?:the )?(?:whole|full|entire) (?:test )?suite (?:now )?(?:passes|passed|is green)",
	"todos os testes (?:agora )?passa(?:m|ram|ndo)",
	"(?:a )?suíte (?:inteira|completa) (?:agora )?(?:passa|passou|está verde)",
]);

const ACKNOWLEDGEMENT = wordsPattern([
	"not (?:yet )?(?:verified|tested|run|validated)",
	"untested",
	"unverified",
	"(?:could not|couldn't|unable to|did not|didn't|haven't|have not|hasn't|has not) (?:run|verify|test|validate)",
	"still fail(?:s|ing)?",
	"(?:tests?|checks?|builds?|lint|type ?checks?) (?:still )?fail(?:s|ed|ing)?",
	"não (?:foi |foram )?(?:verificad|testad|rodad|executad|validad)[oa]s?",
	"não (?:consegui|pude) (?:rodar|executar|testar|verificar|validar)",
	"não (?:verifiquei|testei|rodei|executei|validei)",
	"sem verificação",
	"(?:testes?|checks?|builds?|lint) (?:ainda )?(?:falh(?:a|am|ou|aram|ando))",
	"ainda falha",
]);

/** Changes to these files cannot be checked by running code; they need no verification command. */
const DOCUMENTATION_PATH = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;

export interface EvidenceLedgerOptions {
	/** Verification requests per developer request before a flagged report is accepted. Default: 1. */
	maxGatesPerRequest?: number;
}

/** A mutation of one path (or of unknown paths) at a step of the request. */
interface Change {
	path: string | undefined;
	step: number;
	documentation: boolean;
}

/** Whether a check scoped to `scope` covers `path`. A check without scope covers everything. */
function covers(scope: readonly string[] | undefined, path: string | undefined): boolean {
	if (!scope || scope.length === 0 || path === undefined) return true;
	const file = path.replace(/\\/g, "/");
	return scope.some((dir) => {
		if (file.startsWith(`${dir}/`) || file.includes(`/${dir}/`)) return true;
		// A relative edit path against an absolute scope: some ancestor directory ends the scope.
		if (dir.startsWith("/") && !file.startsWith("/")) {
			const parts = file.split("/");
			parts.pop();
			for (let length = parts.length; length > 0; length--) {
				if (dir.endsWith(`/${parts.slice(0, length).join("/")}`)) return true;
			}
		}
		return false;
	});
}

/** Whether a message ends by asking the developer something, so it is not a completion report. */
function endsWithQuestion(text: string): boolean {
	return /\?[\s*_`"')\]]*$/.test(text.trim());
}

/** Tracks what the tool calls of one developer request actually did. */
export class EvidenceLedger {
	private readonly maxGates: number;
	private step = 0;
	private mutations = 0;
	/** Successful calls whose effect is unknown: commands and unrecognized tools. */
	private opaqueEffects = 0;
	private changes: Change[] = [];
	private changed = new Set<string>();
	private verifications: VerificationRecord[] = [];
	private actionRequested = false;
	private gates = 0;
	private lastReport: CompletionReport | undefined;

	constructor(options: EvidenceLedgerOptions = {}) {
		this.maxGates = options.maxGatesPerRequest ?? 1;
	}

	/** Start a developer request. `actionRequested` marks requests for a change rather than an answer. */
	beginRequest(actionRequested: boolean): void {
		this.step = 0;
		this.mutations = 0;
		this.opaqueEffects = 0;
		this.changes = [];
		this.changed = new Set();
		this.verifications = [];
		this.actionRequested = actionRequested;
		this.gates = 0;
		this.lastReport = undefined;
	}

	/**
	 * Record the outcome of an executed tool call. Blocked calls should not be recorded. `output` is
	 * the call's text result; a green test run whose output says no test ran is not evidence.
	 */
	recordToolOutcome(effect: ToolEffect, isError: boolean, output = ""): void {
		let step = this.step++;
		const record = (paths: readonly string[]) => {
			this.mutations++;
			for (const path of paths.length > 0 ? paths : [undefined]) {
				this.changes.push({ path, step, documentation: path !== undefined && DOCUMENTATION_PATH.test(path) });
				if (path !== undefined) this.changed.add(path);
			}
		};
		if (isMutation(effect.kind) && !isError) record(effect.paths);
		// Files a shell command edited before its own check: the check can cover them. A failed check
		// still ran after the edit; any other failed command may not have reached it.
		if (effect.writes && (!isError || effect.kind === "verify")) {
			record(effect.writes);
			if (effect.kind === "verify") step = this.step++;
		}
		if (effect.kind === "execute" && !isError) this.opaqueEffects++;
		if (effect.kind === "verify") {
			const command = effect.command ?? "";
			const empty = !isError && EMPTY_RUN.some((pattern) => pattern.test(output));
			this.verifications.push({
				command: clip(command, 120),
				passed: !isError && !empty,
				step,
				nameFiltered: NAME_FILTER.test(command),
				empty,
				...(effect.scope ? { scope: effect.scope } : {}),
			});
		}
	}

	/** Changes no passing check covers, for the harness state reminder and the completion gate. */
	private uncovered(): Change[] {
		return this.changes.filter(
			(change) =>
				!change.documentation &&
				!this.verifications.some(
					(check) => check.passed && check.step > change.step && covers(check.scope, change.path),
				),
		);
	}

	/** Paths changed since a passing check that covers them, or undefined when every change is covered. */
	pendingChanges(): string[] | undefined {
		const pending = this.uncovered();
		if (pending.length === 0) return undefined;
		return [...new Set(pending.map((change) => change.path ?? "(shell command)"))];
	}

	/** Why the pending changes are not covered, for the verification request. */
	private pendingDetail(pending: readonly string[]): string {
		const last = this.verifications.at(-1);
		if (!last) return "files changed and no test, type check, build, or lint command ran afterwards";
		if (last.empty) return `the last check ran no tests (\`${last.command}\`)`;
		if (!last.passed) return `files changed after the last check (\`${last.command}\`, which failed)`;
		const lateChange = this.uncovered().some((change) => change.step > last.step);
		if (lateChange) return `files changed after the last check (\`${last.command}\`)`;
		return `the last check (\`${last.command}\`) covers ${last.scope?.join(", ") ?? "other files"}, not ${pending.slice(0, 3).join(", ")}`;
	}

	/**
	 * Compare the final message of a turn with the recorded evidence. A turn that ends with changes
	 * no passing check covers is a completion report whatever its wording, unless it asks a question.
	 */
	assess(finalText: string): CompletionReport {
		const pending = this.pendingChanges();
		const explicit = COMPLETION_CLAIM.test(finalText) || CHECK_CLAIM.test(finalText);
		const claimed = explicit || (pending !== undefined && !endsWithQuestion(finalText));
		const base = {
			claimed,
			changedPaths: [...this.changed],
			mutations: this.mutations,
			verifications: this.verifications.slice(),
			gated: false,
		};
		const report = ((): CompletionReport => {
			if (!claimed) return { ...base, status: "no-claim" };
			if (ACKNOWLEDGEMENT.test(finalText)) return { ...base, status: "acknowledged" };

			const lastCheck = this.verifications.at(-1);
			if (ALL_TESTS_CLAIM.test(finalText) && lastCheck?.passed && lastCheck.nameFiltered) {
				return {
					...base,
					status: "contradicted",
					detail: `the message says all tests pass, but the last check ran only tests matching a name filter: \`${lastCheck.command}\``,
				};
			}
			if (CHECK_CLAIM.test(finalText) && (!lastCheck || !lastCheck.passed)) {
				return {
					...base,
					status: "contradicted",
					detail: !lastCheck
						? "the message says checks pass, but no test, type check, build, or lint command ran in this request"
						: lastCheck.empty
							? `the message says checks pass, but the last check ran no tests: \`${lastCheck.command}\``
							: `the message says checks pass, but the last check failed: \`${lastCheck.command}\``,
				};
			}
			if (this.mutations === 0) {
				// Only a trajectory of pure observation shows that nothing changed. A command or an
				// unrecognized tool may have done the requested work without the harness seeing it.
				return this.actionRequested && this.opaqueEffects === 0
					? {
							...base,
							status: "no-effect",
							detail:
								"the developer requested a change and the message reports it done, but the tool calls only read state",
						}
					: { ...base, status: "no-claim" };
			}
			if (pending) return { ...base, status: "unverified", detail: this.pendingDetail(pending) };
			return { ...base, status: "verified" };
		})();
		this.lastReport = report;
		return report;
	}

	/**
	 * Whether a report should go back to the agent as a verification request. Consumes one gate.
	 * After the budget is spent, the report stands and is surfaced to the developer instead.
	 */
	shouldGate(report: CompletionReport): boolean {
		const flagged =
			report.status === "unverified" || report.status === "contradicted" || report.status === "no-effect";
		if (!flagged || this.gates >= this.maxGates) return false;
		this.gates++;
		report.gated = true;
		return true;
	}

	/** The most recent assessment in this request. */
	latestReport(): CompletionReport | undefined {
		return this.lastReport;
	}
}

/**
 * The verification request sent to the agent for a flagged report. `verifyCommands` are the
 * project's declared checks, named so the agent runs those instead of guessing.
 */
export function formatVerificationRequest(report: CompletionReport, verifyCommands: readonly string[] = []): string {
	const changed = report.changedPaths.slice(0, 8).join(", ");
	const how =
		verifyCommands.length > 0
			? `run the project's verification (${verifyCommands.map((command) => `\`${command}\``).join(", ")}) without piping its output, and report the actual result.`
			: "run the project's verification for the changed code (tests, type check, or build) without piping its output, and report the actual result.";
	return [
		`[harness:evidence] Completion check: your last message reports the work as finished, but the harness has no evidence for it: ${report.detail}.`,
		changed ? `Changed in this request: ${changed}${report.changedPaths.length > 8 ? ", ..." : ""}.` : "",
		`Before reporting completion, ${how}`,
		"If verification is not possible, say exactly what was not verified and why. Do not restate success without evidence.",
	]
		.filter(Boolean)
		.join("\n");
}
