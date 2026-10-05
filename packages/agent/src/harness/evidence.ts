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
 * - claim + changes + no passing check after the last change   -> `unverified`
 * - claim that checks pass + the last check failed or none ran  -> `contradicted`
 * - claim + change requested + no change made                   -> `no-effect`
 *
 * A flagged report sends one verification request back to the agent instead of ending the run.
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
	passed: boolean;
	step: number;
	/** The command ran only tests matching a name pattern (`-t`, `--grep`, `-k`, ...). */
	nameFiltered: boolean;
}

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
	"(?:could not|couldn't|unable to|did not|didn't) (?:run|verify|test|validate)",
	"failed",
	"failing",
	"still fail(?:s|ing)?",
	"não (?:foi |foram )?(?:verificad|testad|rodad|executad|validad)[oa]s?",
	"não (?:consegui|pude) (?:rodar|executar|testar|verificar|validar)",
	"não (?:verifiquei|testei|rodei|executei|validei)",
	"sem verificação",
	"falhou",
	"falharam",
	"ainda falha",
]);

/** Changes to these files cannot be checked by running code; they need no verification command. */
const DOCUMENTATION_PATH = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;

export interface EvidenceLedgerOptions {
	/** Verification requests per developer request before a flagged report is accepted. Default: 1. */
	maxGatesPerRequest?: number;
}

/** Tracks what the tool calls of one developer request actually did. */
export class EvidenceLedger {
	private readonly maxGates: number;
	private step = 0;
	private mutations = 0;
	/** Successful calls whose effect is unknown: commands and unrecognized tools. */
	private opaqueEffects = 0;
	private lastMutationStep = -1;
	private changed = new Set<string>();
	private codeChanged = false;
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
		this.lastMutationStep = -1;
		this.changed = new Set();
		this.codeChanged = false;
		this.verifications = [];
		this.actionRequested = actionRequested;
		this.gates = 0;
		this.lastReport = undefined;
	}

	/** Record the outcome of an executed tool call. Blocked calls should not be recorded. */
	recordToolOutcome(effect: ToolEffect, isError: boolean): void {
		const step = this.step++;
		if (isMutation(effect.kind) && !isError) {
			this.mutations++;
			this.lastMutationStep = step;
			for (const path of effect.paths) this.changed.add(path);
			const documentationOnly =
				effect.paths.length > 0 && effect.paths.every((path) => DOCUMENTATION_PATH.test(path));
			if (!documentationOnly) this.codeChanged = true;
		}
		if (effect.kind === "execute" && !isError) this.opaqueEffects++;
		if (effect.kind === "verify") {
			const command = effect.command ?? "";
			this.verifications.push({
				command: clip(command, 120),
				passed: !isError,
				step,
				nameFiltered: NAME_FILTER.test(command),
			});
		}
	}

	/** Changes made since the last passing check, for the harness state reminder. */
	pendingChanges(): string[] | undefined {
		if (this.mutations === 0 || !this.codeChanged) return undefined;
		const lastPass = this.verifications.findLast((record) => record.passed);
		if (lastPass && lastPass.step > this.lastMutationStep) return undefined;
		return [...this.changed];
	}

	/** Compare the final message of a turn with the recorded evidence. */
	assess(finalText: string): CompletionReport {
		const claimed = COMPLETION_CLAIM.test(finalText) || CHECK_CLAIM.test(finalText);
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
					detail: lastCheck
						? `the message says checks pass, but the last check failed: \`${lastCheck.command}\``
						: "the message says checks pass, but no test, type check, build, or lint command ran in this request",
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
			if (this.pendingChanges()) {
				return {
					...base,
					status: "unverified",
					detail: lastCheck
						? `files changed after the last check (\`${lastCheck.command}\`${lastCheck.passed ? "" : ", which failed"})`
						: "files changed and no test, type check, build, or lint command ran afterwards",
				};
			}
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

/** The verification request sent to the agent for a flagged report. */
export function formatVerificationRequest(report: CompletionReport): string {
	const changed = report.changedPaths.slice(0, 8).join(", ");
	return [
		`[harness:evidence] Completion check: your last message reports the work as finished, but the harness has no evidence for it: ${report.detail}.`,
		changed ? `Changed in this request: ${changed}${report.changedPaths.length > 8 ? ", ..." : ""}.` : "",
		"Before reporting completion, run the project's verification for the changed code (tests, type check, or build) and report the actual result.",
		"If verification is not possible, say exactly what was not verified and why. Do not restate success without evidence.",
	]
		.filter(Boolean)
		.join("\n");
}
