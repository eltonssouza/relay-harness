/**
 * The Rust engine behind the `HarnessEngine` interface, so `HarnessCore` runs the pillars in
 * WebAssembly: `new HarnessCore({ engine: createHarnessWasmEngine })`. Decisions match the
 * TypeScript pillars on every reference case (`harness-wasm.test.ts`).
 *
 * The module cannot call back into JavaScript, so the host does the parts that need it: a custom
 * classifier's effect is passed in, the interactive authorizer is asked between `check` and
 * `resolveAuthorization`, and tool results are sized here and only their stubs come back.
 */

import type {
	AlignmentDecision,
	CompletionReport,
	ContextPolicyStats,
	DeveloperConstraint,
	DeveloperCorrection,
	HarnessEngine,
	HarnessEngineOptions,
	ToolEffect,
} from "../harness/index.ts";
import type { AgentMessage, AgentToolCall } from "../types.ts";
import { HarnessWasmEngine } from "./loader.ts";

type WasmDecision = AlignmentDecision | { action: "ask"; fingerprint: string };

/** Characters of a tool result, as the context pillar sizes it: text length, a fixed weight per image. */
function resultChars(content: ReadonlyArray<{ type: string; text?: string }>, imageChars: number): number {
	let chars = 0;
	for (const block of content) chars += block.type === "text" ? (block.text ?? "").length : imageChars;
	return chars;
}

class RustHarnessEngine implements HarnessEngine {
	readonly pillars: HarnessEngine["pillars"];
	private readonly engine: HarnessWasmEngine;
	private readonly options: HarnessEngineOptions;
	private readonly imageChars: number;

	constructor(options: HarnessEngineOptions) {
		const { alignment, evidence, context } = options;
		this.options = options;
		this.engine = new HarnessWasmEngine({
			alignment:
				alignment === false
					? false
					: {
							maxConstraints: alignment?.maxConstraints,
							hasAuthorizer: alignment?.authorize !== undefined,
							scopeGuard: alignment?.scopeGuard,
							authorizationGate: alignment?.authorizationGate,
						},
			evidence: evidence === false ? false : { maxGatesPerRequest: evidence?.maxGatesPerRequest },
			context:
				context === false
					? false
					: {
							keepRecent: context?.keepRecent,
							batchSize: context?.batchSize,
							minElideChars: context?.minElideChars,
							maxDigestEntries: context?.maxDigestEntries,
							cwd: context?.cwd,
						},
			verifyCommands: options.verifyCommands,
			workspace: options.workspace,
		});
		this.imageChars = context === false ? 4000 : (context?.imageChars ?? 4000);
		this.pillars = { alignment: alignment !== false, evidence: evidence !== false, context: context !== false };
	}

	classify(toolCall: AgentToolCall): ToolEffect {
		const custom = this.options.classifyEffect?.(toolCall);
		if (custom) return custom;
		return this.engine.call("classify", {
			toolCall: { name: toolCall.name, arguments: toolCall.arguments ?? {} },
		}) as ToolEffect;
	}

	beginRequest(text: string): void {
		this.engine.call("beginRequest", { text });
	}

	observeDeveloperMessage(text: string, timestamp: number, afterAgentWork: boolean): void {
		if (!this.pillars.alignment) return;
		const before = this.learnings();
		this.engine.call("observeDeveloperMessage", { text, timestamp, afterAgentWork });
		if (this.learnings() !== before) this.options.onLearningsChange?.();
	}

	promptGuidelines(): readonly string[] {
		return this.engine.call("promptGuidelines") as string[];
	}

	async check(toolName: string, effect: ToolEffect, signal?: AbortSignal): Promise<AlignmentDecision> {
		const decision = this.engine.call("check", { toolName, effect }) as WasmDecision;
		if (decision.action !== "ask") return decision;
		const { fingerprint } = decision;
		const approved = await (this.options.alignment || undefined)?.authorize?.(
			{ toolName, effect, fingerprint },
			signal,
		);
		return this.engine.call("resolveAuthorization", { effect, fingerprint, approved }) as AlignmentDecision;
	}

	beginToolCall(): number | undefined {
		return (this.engine.call("beginToolCall") as number | null) ?? undefined;
	}

	recordToolOutcome(effect: ToolEffect, isError: boolean, output?: string, startedAt?: number): void {
		this.engine.call("recordToolOutcome", { effect, isError, output: output ?? "", startedAt });
	}

	resync(): void {
		this.engine.call("resync");
	}

	transformContext(messages: AgentMessage[]): AgentMessage[] {
		if (!this.pillars.context) return messages;
		const summary = messages.map((message) => {
			if (message.role === "assistant") {
				return {
					role: "assistant",
					toolCalls: message.content.flatMap((block) => {
						if (block.type !== "toolCall") return [];
						const effect = this.options.classifyEffect?.(block);
						return [
							{
								id: block.id,
								name: block.name,
								arguments: block.arguments ?? {},
								argumentsJson: JSON.stringify(block.arguments ?? {}),
								...(effect ? { effect } : {}),
							},
						];
					}),
				};
			}
			if (message.role === "toolResult") {
				return {
					role: "toolResult",
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					chars: resultChars(message.content, this.imageChars),
					isError: message.isError,
				};
			}
			return { role: message.role };
		});
		const elided = this.engine.call("transformContext", { messages: summary }) as Array<{
			toolCallId: string;
			stub: string;
		}>;
		if (elided.length === 0) return messages;
		const stubs = new Map(elided.map((item) => [item.toolCallId, item.stub]));
		let changed = false;
		const result = messages.map((message) => {
			if (message.role !== "toolResult") return message;
			const stub = stubs.get(message.toolCallId);
			if (stub === undefined) return message;
			changed = true;
			return { ...message, content: [{ type: "text" as const, text: stub }] };
		});
		return changed ? result : messages;
	}

	contextStats(): Readonly<ContextPolicyStats> | undefined {
		return (this.engine.call("contextStats") as ContextPolicyStats | null) ?? undefined;
	}

	renderState(slices: string | undefined): string | undefined {
		return (this.engine.call("renderState", { slices }) as string | null) ?? undefined;
	}

	assessFinalMessage(text: string): { report: CompletionReport; verificationRequest?: string } | undefined {
		const assessment = this.engine.call("assessFinalMessage", { text }) as {
			report: CompletionReport;
			verificationRequest: string | null;
		} | null;
		if (!assessment) return undefined;
		const { report, verificationRequest } = assessment;
		return verificationRequest === null ? { report } : { report, verificationRequest };
	}

	latestReport(): CompletionReport | undefined {
		return (this.engine.call("latestReport") as CompletionReport | null) ?? undefined;
	}

	pendingChanges(): readonly string[] | undefined {
		return (this.engine.call("pendingChanges") as string[] | null) ?? undefined;
	}

	pendingAuthorizations(): readonly string[] {
		return this.engine.call("pendingAuthorizations") as string[];
	}

	constraints(): readonly DeveloperConstraint[] {
		return this.engine.call("constraints") as DeveloperConstraint[];
	}

	corrections(): readonly DeveloperCorrection[] {
		return this.engine.call("corrections") as DeveloperCorrection[];
	}

	addConstraint(text: string, timestamp = Date.now()): DeveloperConstraint | undefined {
		const constraint = this.engine.call("addConstraint", { text, timestamp }) as DeveloperConstraint | null;
		if (constraint) this.options.onLearningsChange?.();
		return constraint ?? undefined;
	}

	removeConstraint(id: string): boolean {
		const removed = this.engine.call("removeConstraint", { id }) as boolean;
		if (removed) this.options.onLearningsChange?.();
		return removed;
	}

	restoreLearnings(constraints: readonly DeveloperConstraint[], corrections: readonly DeveloperCorrection[]): void {
		this.engine.call("restoreLearnings", { constraints, corrections });
	}

	dispose(): void {
		this.engine.dispose();
	}

	/** Constraints and corrections as one string, to tell whether a message changed them. */
	private learnings(): string {
		return JSON.stringify([this.engine.call("constraints"), this.engine.call("corrections")]);
	}
}

/** Engine factory for `HarnessCore` that runs the pillars in the Rust engine. */
export function createHarnessWasmEngine(options: HarnessEngineOptions): HarnessEngine {
	return new RustHarnessEngine(options);
}
