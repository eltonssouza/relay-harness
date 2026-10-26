/**
 * Wires the model-independent harness core from `relay-agent-core` into a coding session:
 * settings, interactive authorization, constraint persistence, skills, and notifications.
 */

import {
	type Agent,
	type DeveloperConstraint,
	type DeveloperCorrection,
	HarnessCore,
	type HarnessCoreEvent,
} from "@relay-harness/agent-core";
import type { ExtensionMode, ExtensionUIContext } from "./extensions/index.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { createGitWorkspaceProbe } from "./workspace-probe.ts";

/** Session entry type that persists developer constraints and corrections across resumes and compaction. */
export const HARNESS_CONSTRAINTS_ENTRY = "harness-core:constraints";

interface ConstraintsEntryData {
	constraints: DeveloperConstraint[];
	/** Absent in entries written before corrections were recorded. */
	corrections?: DeveloperCorrection[];
}

export interface CodingHarnessCoreOptions {
	agent: Agent;
	settingsManager: SettingsManager;
	sessionManager: SessionManager;
	/** Workspace root, for measuring changes. */
	cwd: string;
	/** Interactive UI, when the session has one. */
	getUI: () => { ui?: ExtensionUIContext; mode: ExtensionMode };
}

/** Harness core installed on a coding session, plus the latest observations for `/harness`. */
export class CodingHarnessCore {
	readonly core: HarnessCore;
	private readonly blocked: Array<{ toolName: string; reason: string }> = [];
	private readonly uninstall: () => void;

	constructor(options: CodingHarnessCoreOptions) {
		const settings = options.settingsManager.getHarnessCoreSettings();
		const { sessionManager, getUI } = options;

		this.core = new HarnessCore({
			alignment: settings.alignment
				? {
						authorizationGate: settings.authorizationGate,
						scopeGuard: settings.scopeGuard,
						authorize: async (request) => {
							const { ui, mode } = getUI();
							// Nobody can be asked: the call stays blocked until the developer approves in chat.
							if (!ui || (mode !== "tui" && mode !== "rpc")) return undefined;
							return ui.confirm(
								`Allow ${request.effect.kind} operation?`,
								`${request.effect.reason ?? request.toolName}\n\n${request.effect.command ?? request.fingerprint}`,
							);
						},
					}
				: false,
			evidence: settings.evidence ? {} : false,
			context: settings.context
				? { keepRecent: settings.contextKeepRecent, batchSize: settings.contextBatchSize }
				: false,
			slices:
				settings.evidence && (settings.maxChangedLines > 0 || settings.maxFileLines > 0)
					? {
							probe: createGitWorkspaceProbe(options.cwd),
							maxChangedLines: settings.maxChangedLines,
							maxFileLines: settings.maxFileLines,
						}
					: false,
			verifyCommands: settings.verifyCommands,
			onEvent: (event) => this.handleEvent(event, getUI),
		});

		const alignment = this.core.alignment;
		if (alignment) {
			const persisted = sessionManager
				.getBranch()
				.findLast((entry) => entry.type === "custom" && entry.customType === HARNESS_CONSTRAINTS_ENTRY);
			const data = persisted?.type === "custom" ? (persisted.data as ConstraintsEntryData | undefined) : undefined;
			if (data?.constraints) alignment.constraints.restore(data.constraints);
			if (data?.corrections) alignment.restoreCorrections(data.corrections);
			const persist = () => {
				sessionManager.appendCustomEntry(HARNESS_CONSTRAINTS_ENTRY, {
					constraints: [...alignment.constraints.list()],
					corrections: [...alignment.corrections()],
				} satisfies ConstraintsEntryData);
			};
			alignment.constraints.onChange = persist;
			alignment.onCorrection = persist;
		}

		this.uninstall = this.core.install(options.agent);
	}

	dispose(): void {
		this.uninstall();
	}

	/** Collaboration rules the system prompt adds while the alignment pillar is enabled. */
	promptGuidelines(): string[] {
		return [...this.core.promptGuidelines()];
	}

	/** Recent tool calls the alignment policy blocked, newest last. */
	getBlockedCalls(): ReadonlyArray<{ toolName: string; reason: string }> {
		return this.blocked;
	}

	private describeSlices(): string[] {
		const slices = this.core.slices;
		if (!slices) return ["slice signals: disabled"];
		const status = slices.status();
		return [
			`changed in this request: about ${status.changedLines} lines in ${status.changedFiles} files`,
			...[...status.oversizedFiles].map(([path, lines]) => `over the file-size guideline: ${path} (${lines} lines)`),
		];
	}

	/** Plain-text status of every pillar, as sections of lines, for `/harness`. */
	describe(): Array<{ title: string; lines: string[] }> {
		const { alignment, evidence, context } = this.core;
		const sections: Array<{ title: string; lines: string[] }> = [];

		if (alignment) {
			const constraints = alignment.constraints.list();
			const pending = alignment.pendingAuthorizations();
			sections.push({
				title: "Alignment",
				lines: [
					...(constraints.length > 0
						? constraints.map((c) => `constraint ${c.id}: ${c.text}`)
						: ["no constraints recorded"]),
					...pending.map((operation) => `waiting for approval: ${operation}`),
					...this.blocked.slice(-5).map((call) => `blocked ${call.toolName}: ${call.reason.split(". ")[0]}`),
				],
			});
			const corrections = alignment.corrections();
			if (constraints.length > 0 || corrections.length > 0) {
				sections.push({
					title: "Learnings (candidates for AGENTS.md)",
					lines: [
						...corrections.map((correction) => `correction: ${correction.text}`),
						...constraints.map((constraint) => `constraint: ${constraint.text}`),
						"These last for this session only. Record lasting ones in AGENTS.md so the next session starts with them.",
					],
				});
			}
		} else {
			sections.push({ title: "Alignment", lines: ["disabled"] });
		}

		if (evidence) {
			const report = evidence.latestReport();
			const pending = evidence.pendingChanges();
			sections.push({
				title: "Evidence",
				lines: [
					report
						? `last completion: ${report.status}${report.detail ? ` (${report.detail})` : ""}`
						: "no completion assessed in this request",
					...(report?.verifications.length
						? [
								`checks: ${report.verifications.map((v) => `${v.command} ${v.passed ? "passed" : "failed"}`).join("; ")}`,
							]
						: []),
					...(pending ? [`changed since last passing check: ${pending.join(", ")}`] : []),
					this.core.verifyCommands.length > 0
						? `verification commands: ${this.core.verifyCommands.join(", ")}`
						: "verification commands: not declared (common test, build, and lint commands count)",
					...this.describeSlices(),
				],
			});
		} else {
			sections.push({ title: "Evidence", lines: ["disabled"] });
		}

		if (context) {
			const stats = context.getStats();
			sections.push({
				title: "Context",
				lines: [
					`elided tool results: ${stats.elidedResults} in ${stats.batches} batches`,
					`characters kept out of requests: ${stats.elidedChars.toLocaleString()}`,
				],
			});
		} else {
			sections.push({ title: "Context", lines: ["disabled"] });
		}

		return sections;
	}

	private handleEvent(event: HarnessCoreEvent, getUI: CodingHarnessCoreOptions["getUI"]): void {
		switch (event.type) {
			case "tool_blocked":
				this.blocked.push({ toolName: event.toolName, reason: event.reason });
				if (this.blocked.length > 20) this.blocked.shift();
				break;
			case "completion_assessed": {
				const { report } = event;
				const flagged =
					report.status === "unverified" || report.status === "contradicted" || report.status === "no-effect";
				// A gated report goes back to the agent; only a report that stands is surfaced.
				if (flagged && !report.gated) {
					getUI().ui?.notify(
						`Harness: completion reported without evidence (${report.detail ?? report.status}).`,
						"warning",
					);
				}
				break;
			}
		}
	}
}
