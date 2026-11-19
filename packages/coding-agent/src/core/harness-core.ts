/**
 * Wires the model-independent harness core from `relay-agent-core` into a coding session:
 * settings, interactive authorization, constraint persistence, skills, and notifications.
 */

import { homedir, tmpdir } from "node:os";
import {
	type Agent,
	type AgentToolCall,
	type CompletionReport,
	type ContextPolicyStats,
	type DeveloperConstraint,
	type DeveloperCorrection,
	HarnessCore,
	type HarnessCoreEvent,
	type ToolEffect,
	TypeScriptHarnessEngine,
} from "@relay-harness/agent-core";
import { createHarnessWasmEngine } from "@relay-harness/agent-core/harness-wasm";
import type { ExtensionMode, ExtensionUIContext, ToolAnnotations } from "./extensions/index.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { createGitWorkspaceProbe } from "./workspace-probe.ts";

/**
 * The engine that runs the pillars: the Rust engine (WebAssembly) unless `RELAY_HARNESS_ENGINE` is
 * `typescript`, which keeps the TypeScript pillars for one release as a fallback.
 */
function harnessEngine() {
	return process.env.RELAY_HARNESS_ENGINE === "typescript" ? undefined : createHarnessWasmEngine;
}

/** The harness state of a session as data, for `/harness`-like views outside the terminal (RPC). */
export interface HarnessSnapshot {
	engine: "rust" | "typescript";
	pillars: { alignment: boolean; evidence: boolean; context: boolean };
	constraints: DeveloperConstraint[];
	corrections: DeveloperCorrection[];
	/** Operations blocked until the developer approves them. */
	pendingAuthorizations: string[];
	/** Recent calls the alignment policy blocked, newest last. */
	blockedCalls: Array<{ toolName: string; reason: string }>;
	latestReport?: CompletionReport;
	/** Files changed since the last passing check. */
	pendingChanges?: string[];
	contextStats?: ContextPolicyStats;
	verifyCommands: string[];
}

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
	/** Annotations a tool declares about itself (MCP `readOnlyHint`, `destructiveHint`, `openWorldHint`). */
	getToolAnnotations: (toolName: string) => ToolAnnotations | undefined;
	/** Interactive UI, when the session has one. */
	getUI: () => { ui?: ExtensionUIContext; mode: ExtensionMode };
}

/**
 * Effect of a tool that declares what it does. A tool without annotations keeps the default
 * classification: an unknown tool is a command whose effect is unknown.
 */
function annotatedEffect(toolCall: AgentToolCall, annotations: ToolAnnotations | undefined): ToolEffect | undefined {
	if (!annotations) return undefined;
	const path = (toolCall.arguments as { path?: unknown } | undefined)?.path;
	const paths = typeof path === "string" ? [path] : [];
	if (annotations.readOnlyHint === true) return { kind: "read", paths };
	if (annotations.destructiveHint === true) {
		return { kind: "destructive", paths, reason: `the tool ${toolCall.name} declares that it is destructive` };
	}
	if (annotations.readOnlyHint === false && annotations.openWorldHint === true) {
		return {
			kind: "external",
			paths,
			reason: `the tool ${toolCall.name} declares that it changes an external system`,
		};
	}
	return undefined;
}

/** Harness core installed on a coding session, plus the latest observations for `/harness`. */
export class CodingHarnessCore {
	readonly core: HarnessCore;
	private readonly blocked: Array<{ toolName: string; reason: string }> = [];
	private readonly sessionManager: SessionManager;
	private readonly uninstall: () => void;
	/** Saves the current constraints and corrections to the session; absent without the alignment pillar. */
	private persistLearnings?: () => void;

	constructor(options: CodingHarnessCoreOptions) {
		const settings = options.settingsManager.getHarnessCoreSettings();
		const { sessionManager, getUI } = options;
		this.sessionManager = sessionManager;

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
			workspace: { cwd: options.cwd, home: homedir(), tempDir: tmpdir() },
			classifyEffect: (toolCall) => annotatedEffect(toolCall, options.getToolAnnotations(toolCall.name)),
			onEvent: (event) => this.handleEvent(event, getUI),
			engine: harnessEngine(),
		});

		const { engine } = this.core;
		if (engine.pillars.alignment) {
			this.restoreFromBranch();
			const persist = () => {
				sessionManager.appendCustomEntry(HARNESS_CONSTRAINTS_ENTRY, {
					constraints: [...engine.constraints()],
					corrections: [...engine.corrections()],
				} satisfies ConstraintsEntryData);
			};
			this.core.onLearningsChange = persist;
			this.persistLearnings = persist;
		}

		this.uninstall = this.core.install(options.agent);
	}

	/** Drop one recorded constraint by its id (`c3`), for `/harness forget`. Returns whether it existed. */
	forgetConstraint(id: string): boolean {
		return this.core.engine.removeConstraint(id);
	}

	/** Drop every recorded constraint and correction of the current branch, for `/harness clear`. */
	clearLearnings(): void {
		if (!this.core.engine.pillars.alignment) return;
		this.core.engine.restoreLearnings([], []);
		this.persistLearnings?.();
	}

	/** Constraints and corrections the current branch recorded last, or none. */
	private restoreFromBranch(): void {
		if (!this.core.engine.pillars.alignment) return;
		const persisted = this.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === HARNESS_CONSTRAINTS_ENTRY);
		const data = persisted?.type === "custom" ? (persisted.data as ConstraintsEntryData | undefined) : undefined;
		this.core.engine.restoreLearnings(data?.constraints ?? [], data?.corrections ?? []);
	}

	/**
	 * The session moved to another branch of its tree. Constraints and corrections follow the new
	 * branch, and state that described the old conversation (context stubs, approvals) is dropped.
	 */
	resync(): void {
		this.core.resync();
		this.restoreFromBranch();
	}

	dispose(): void {
		this.uninstall();
		this.core.dispose();
	}

	/** Collaboration rules the system prompt adds while the alignment pillar is enabled. */
	promptGuidelines(): string[] {
		return [...this.core.promptGuidelines()];
	}

	/** Recent tool calls the alignment policy blocked, newest last. */
	getBlockedCalls(): ReadonlyArray<{ toolName: string; reason: string }> {
		return this.blocked;
	}

	/** Every pillar's state as data. */
	snapshot(): HarnessSnapshot {
		const { engine, verifyCommands } = this.core;
		const report = engine.latestReport();
		const pending = engine.pendingChanges();
		const stats = engine.contextStats();
		return {
			engine: engine instanceof TypeScriptHarnessEngine ? "typescript" : "rust",
			pillars: { ...engine.pillars },
			constraints: [...engine.constraints()],
			corrections: [...engine.corrections()],
			pendingAuthorizations: [...engine.pendingAuthorizations()],
			blockedCalls: [...this.blocked],
			...(report ? { latestReport: report } : {}),
			...(pending ? { pendingChanges: [...pending] } : {}),
			...(stats ? { contextStats: { ...stats } } : {}),
			verifyCommands: [...verifyCommands],
		};
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
		const { engine } = this.core;
		const sections: Array<{ title: string; lines: string[] }> = [];

		if (engine.pillars.alignment) {
			const constraints = engine.constraints();
			const pending = engine.pendingAuthorizations();
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
			const corrections = engine.corrections();
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

		if (engine.pillars.evidence) {
			const report = engine.latestReport();
			const pending = engine.pendingChanges();
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

		const stats = engine.contextStats();
		if (stats) {
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
				// A gated report goes back to the agent; only a report that stands is surfaced. A question
				// with unverified changes is not gated, so the developer is told before answering it.
				if ((flagged && !report.gated) || report.status === "question") {
					const what =
						report.status === "question"
							? "the agent asks a question with unverified changes"
							: "completion reported without evidence";
					getUI().ui?.notify(`Harness: ${what} (${report.detail ?? report.status}).`, "warning");
				}
				break;
			}
		}
	}
}
