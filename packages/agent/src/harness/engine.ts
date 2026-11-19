/**
 * The decisions of the three pillars behind one interface, so the Rust engine
 * (`@relay-harness/agent-core/harness-wasm`) can stand in for the TypeScript pillars. `HarnessCore`
 * keeps the agent wiring, events and workspace measurements; an engine keeps the pillars' state.
 */

import type { AgentMessage, AgentToolCall } from "../types.ts";
import {
	type AlignmentDecision,
	AlignmentPolicy,
	type AlignmentPolicyOptions,
	type DeveloperConstraint,
	type DeveloperCorrection,
	PAIR_PROGRAMMING_GUIDELINES,
	requestsAction,
} from "./alignment.ts";
import { type ContextPolicyOptions, type ContextPolicyStats, ContextWindowPolicy } from "./context.ts";
import { type ClassifyContext, classifyToolCall, type ToolEffect, type ToolEffectClassifier } from "./effects.ts";
import {
	type CompletionReport,
	EvidenceLedger,
	type EvidenceLedgerOptions,
	formatVerificationRequest,
} from "./evidence.ts";

export interface HarnessEngineOptions {
	alignment?: AlignmentPolicyOptions | false;
	evidence?: EvidenceLedgerOptions | false;
	context?: Omit<ContextPolicyOptions, "classifyEffect"> | false;
	/** The project's declared checks, without blank entries. */
	verifyCommands: readonly string[];
	classifyEffect?: ToolEffectClassifier;
	workspace: ClassifyContext;
	/** Constraints or corrections changed: a developer message, an added or removed constraint. */
	onLearningsChange?: () => void;
}

/** One instance of the pillars. Every method is synchronous except the alignment check, which may ask the developer. */
export interface HarnessEngine {
	readonly pillars: { readonly alignment: boolean; readonly evidence: boolean; readonly context: boolean };
	classify(toolCall: AgentToolCall): ToolEffect;
	beginRequest(text: string): void;
	observeDeveloperMessage(text: string, timestamp: number, afterAgentWork: boolean): void;
	promptGuidelines(): readonly string[];
	check(toolName: string, effect: ToolEffect, signal?: AbortSignal): Promise<AlignmentDecision>;
	/** The evidence clock when a call starts, for {@link recordToolOutcome}; undefined without the evidence pillar. */
	beginToolCall(): number | undefined;
	recordToolOutcome(effect: ToolEffect, isError: boolean, output?: string, startedAt?: number): void;
	/** Drop state that described another branch of the conversation: context stubs, approvals, grants. */
	resync(): void;
	/** The context policy applied to one request's messages; returns the input array when nothing changes. */
	transformContext(messages: AgentMessage[]): AgentMessage[];
	contextStats(): Readonly<ContextPolicyStats> | undefined;
	/** Harness state restated next to the latest message. `slices` is the measured slice reminder. */
	renderState(slices: string | undefined): string | undefined;
	/** Judge a final message. `verificationRequest` is set when the claim lacks evidence and the gate budget allows it. */
	assessFinalMessage(text: string): { report: CompletionReport; verificationRequest?: string } | undefined;
	latestReport(): CompletionReport | undefined;
	pendingChanges(): readonly string[] | undefined;
	pendingAuthorizations(): readonly string[];
	constraints(): readonly DeveloperConstraint[];
	corrections(): readonly DeveloperCorrection[];
	addConstraint(text: string, timestamp?: number): DeveloperConstraint | undefined;
	removeConstraint(id: string): boolean;
	/** Replace constraints and corrections with persisted ones, without notifying `onLearningsChange`. */
	restoreLearnings(constraints: readonly DeveloperConstraint[], corrections: readonly DeveloperCorrection[]): void;
	dispose(): void;
}

export type HarnessEngineFactory = (options: HarnessEngineOptions) => HarnessEngine;

/** The pillars as TypeScript classes, the reference the Rust engine is checked against. */
export class TypeScriptHarnessEngine implements HarnessEngine {
	readonly alignment?: AlignmentPolicy;
	readonly evidence?: EvidenceLedger;
	readonly context?: ContextWindowPolicy;
	readonly pillars: HarnessEngine["pillars"];
	private readonly options: HarnessEngineOptions;

	constructor(options: HarnessEngineOptions) {
		this.options = options;
		const cwd = options.workspace.cwd;
		if (options.alignment !== false) {
			const alignment = new AlignmentPolicy(options.alignment);
			alignment.constraints.onChange = () => options.onLearningsChange?.();
			alignment.onCorrection = () => options.onLearningsChange?.();
			this.alignment = alignment;
		}
		if (options.evidence !== false) this.evidence = new EvidenceLedger({ cwd, ...options.evidence });
		if (options.context !== false) {
			this.context = new ContextWindowPolicy({ cwd, ...options.context, classifyEffect: options.classifyEffect });
		}
		this.pillars = { alignment: !!this.alignment, evidence: !!this.evidence, context: !!this.context };
	}

	classify(toolCall: AgentToolCall): ToolEffect {
		return classifyToolCall(
			toolCall,
			this.options.classifyEffect,
			this.options.verifyCommands,
			this.options.workspace,
		);
	}

	beginRequest(text: string): void {
		this.evidence?.beginRequest(requestsAction(text));
	}

	observeDeveloperMessage(text: string, timestamp: number, afterAgentWork: boolean): void {
		this.alignment?.observeDeveloperMessage(text, timestamp, afterAgentWork);
	}

	promptGuidelines(): readonly string[] {
		return this.alignment ? PAIR_PROGRAMMING_GUIDELINES : [];
	}

	async check(toolName: string, effect: ToolEffect, signal?: AbortSignal): Promise<AlignmentDecision> {
		return this.alignment ? this.alignment.check(toolName, effect, signal) : { action: "allow" };
	}

	beginToolCall(): number | undefined {
		return this.evidence?.beginToolCall();
	}

	recordToolOutcome(effect: ToolEffect, isError: boolean, output?: string, startedAt?: number): void {
		this.evidence?.recordToolOutcome(effect, isError, output, startedAt);
	}

	resync(): void {
		this.context?.reset();
		this.alignment?.resetConversationState();
	}

	transformContext(messages: AgentMessage[]): AgentMessage[] {
		return this.context ? this.context.transform(messages) : messages;
	}

	contextStats(): Readonly<ContextPolicyStats> | undefined {
		return this.context?.getStats();
	}

	renderState(slices: string | undefined): string | undefined {
		const sections: string[] = [];
		const correction = this.alignment?.renderCorrection();
		if (correction) sections.push(correction);
		const constraints = this.alignment?.renderConstraints();
		if (constraints) sections.push(constraints);
		const pending = this.evidence?.pendingChanges();
		if (pending && pending.length > 0) {
			const shown = pending.slice(0, 8).join(", ");
			sections.push(
				`Changed since the last passing check: ${shown}${pending.length > 8 ? ", ..." : ""}. Verify before reporting completion.`,
			);
		}
		if (slices) sections.push(slices);
		const progress = this.context?.renderProgress();
		if (progress) sections.push(progress);
		if (sections.length === 0) return undefined;
		return ["Generated by the harness, not written by the developer.", ...sections].join("\n\n");
	}

	assessFinalMessage(text: string): { report: CompletionReport; verificationRequest?: string } | undefined {
		if (!this.evidence) return undefined;
		const report = this.evidence.assess(text);
		if (!this.evidence.shouldGate(report)) return { report };
		return { report, verificationRequest: formatVerificationRequest(report, this.options.verifyCommands) };
	}

	latestReport(): CompletionReport | undefined {
		return this.evidence?.latestReport();
	}

	pendingChanges(): readonly string[] | undefined {
		return this.evidence?.pendingChanges();
	}

	pendingAuthorizations(): readonly string[] {
		return this.alignment?.pendingAuthorizations() ?? [];
	}

	constraints(): readonly DeveloperConstraint[] {
		return this.alignment?.constraints.list() ?? [];
	}

	corrections(): readonly DeveloperCorrection[] {
		return this.alignment?.corrections() ?? [];
	}

	addConstraint(text: string, timestamp?: number): DeveloperConstraint | undefined {
		return this.alignment?.constraints.add(text, timestamp);
	}

	removeConstraint(id: string): boolean {
		return this.alignment?.constraints.remove(id) ?? false;
	}

	restoreLearnings(constraints: readonly DeveloperConstraint[], corrections: readonly DeveloperCorrection[]): void {
		this.alignment?.constraints.restore(constraints);
		this.alignment?.restoreCorrections(corrections);
	}

	dispose(): void {}
}
