/**
 * Harness core: the three pillars composed on top of the agent loop.
 *
 * Every pillar acts on the loop's provider-neutral hooks (`beforeToolCall`, `transformContext`,
 * `finishTurn`) and on its events, never on a provider API, so the behavior is the same for any
 * model the agent runs on.
 *
 * | Pillar      | Hook               | Effect                                                     |
 * |-------------|--------------------|------------------------------------------------------------|
 * | Alignment   | `beforeToolCall`   | gate destructive/external effects, guard question turns    |
 * | Alignment   | `transformContext` | restate developer constraints next to the latest message   |
 * | Evidence    | `finishTurn`       | send a verification request when a claim lacks evidence    |
 * | Evidence    | events, `transformContext` | flag oversized changes and files (needs a probe)   |
 * | Context     | `transformContext` | recent tool window, batched elision, progress digest       |
 */

import type { AssistantMessage } from "@relay-harness/ai";
import type { Agent } from "../agent.ts";
import type { AgentEvent, AgentMessage, AgentToolCall, BeforeToolCallResult } from "../types.ts";
import { type AlignmentDecision, AlignmentPolicy, type AlignmentPolicyOptions } from "./alignment.ts";
import {
	appendHarnessState,
	type ContextPolicyOptions,
	type ContextPolicyStats,
	type ContextWindowPolicy,
} from "./context.ts";
import type { ClassifyContext, ToolEffect, ToolEffectClassifier } from "./effects.ts";
import { type HarnessEngine, type HarnessEngineFactory, TypeScriptHarnessEngine } from "./engine.ts";
import type { CompletionReport, EvidenceLedger, EvidenceLedgerOptions } from "./evidence.ts";
import { SliceDiscipline, type SliceDisciplineOptions } from "./slices.ts";
import { messageOrigin, messageText } from "./text.ts";

/** Text of a tool result, for output-based evidence. */
function resultText(result: unknown): string {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && (block as { type?: string }).type === "text"
				? String((block as { text?: unknown }).text ?? "")
				: "",
		)
		.join("\n");
}

/**
 * Whether a call may change workspace files, so the slice signals measure around it: edits, shell
 * commands that write files, checks (builds and code generators write too), and risky operations.
 * A plain command such as `ls` or `git status` costs no git measurement.
 */
function mayChangeFiles(effect: ToolEffect): boolean {
	return (effect.kind !== "read" && effect.kind !== "execute") || effect.writes !== undefined;
}

/** Files a call writes by name: the edit tool's path and the files a shell command edits. */
function writtenPaths(effect: ToolEffect): string[] {
	return [...(effect.kind === "write" ? effect.paths : []), ...(effect.writes ?? [])];
}

/** One tool call a delegated agent ran: its effect, whether it failed, and its text output. */
export interface DelegatedOutcome {
	effect: ToolEffect;
	isError: boolean;
	output?: string;
}

export type HarnessCoreEvent =
	| { type: "tool_blocked"; toolName: string; effect: ToolEffect; kind: "authorization" | "scope"; reason: string }
	| { type: "tool_authorized"; toolName: string; effect: ToolEffect; via: "request" | "grant" | "authorizer" }
	| { type: "completion_assessed"; report: CompletionReport }
	| { type: "context_elided"; stats: ContextPolicyStats };

/** Options per pillar. `false` disables a pillar; omitting it uses defaults. */
export interface HarnessCoreOptions {
	alignment?: AlignmentPolicyOptions | false;
	evidence?: EvidenceLedgerOptions | false;
	context?: Omit<ContextPolicyOptions, "classifyEffect"> | false;
	/** Change-size and file-growth signals need a workspace probe, so they are off unless configured. */
	slices?: SliceDisciplineOptions | false;
	/**
	 * The project's verification commands, such as `npm run check`. When set, only commands that
	 * run one of them count as evidence; otherwise common test, build, and lint commands do.
	 */
	verifyCommands?: readonly string[];
	/** Classification for tools the default name-based rules do not know. */
	classifyEffect?: ToolEffectClassifier;
	/** Workspace root and home directory, so writes outside the workspace or to hooks and credentials are gated. */
	workspace?: ClassifyContext;
	/** Observer for pillar decisions, for UI, logs, and telemetry. Must not throw. */
	onEvent?: (event: HarnessCoreEvent) => void;
	/**
	 * The engine that runs the pillars. Default: the TypeScript pillars. The Rust engine is
	 * `createHarnessWasmEngine` from `@relay-harness/agent-core/harness-wasm`.
	 */
	engine?: HarnessEngineFactory;
}

/** The three pillars, usable directly by any runtime or installed on an {@link Agent}. */
export class HarnessCore {
	readonly engine: HarnessEngine;
	readonly slices?: SliceDiscipline;
	readonly verifyCommands: readonly string[];
	/** Called when constraints or corrections change, so a runtime can persist them. */
	onLearningsChange?: () => void;
	private readonly onEvent?: (event: HarnessCoreEvent) => void;
	private lastElidedResults = 0;

	constructor(options: HarnessCoreOptions = {}) {
		this.onEvent = options.onEvent;
		this.verifyCommands = (options.verifyCommands ?? []).filter((command) => command.trim().length > 0);
		if (options.slices) this.slices = new SliceDiscipline(options.slices);
		const createEngine = options.engine ?? ((engineOptions) => new TypeScriptHarnessEngine(engineOptions));
		this.engine = createEngine({
			alignment: options.alignment,
			evidence: options.evidence,
			context: options.context,
			verifyCommands: this.verifyCommands,
			classifyEffect: options.classifyEffect,
			workspace: options.workspace ?? {},
			onLearningsChange: () => this.onLearningsChange?.(),
		});
	}

	/** The alignment pillar's TypeScript class, when the TypeScript engine runs the pillars. */
	get alignment(): AlignmentPolicy | undefined {
		return this.engine instanceof TypeScriptHarnessEngine ? this.engine.alignment : undefined;
	}

	/** The evidence pillar's TypeScript class, when the TypeScript engine runs the pillars. */
	get evidence(): EvidenceLedger | undefined {
		return this.engine instanceof TypeScriptHarnessEngine ? this.engine.evidence : undefined;
	}

	/** The context pillar's TypeScript class, when the TypeScript engine runs the pillars. */
	get context(): ContextWindowPolicy | undefined {
		return this.engine instanceof TypeScriptHarnessEngine ? this.engine.context : undefined;
	}

	classify(toolCall: AgentToolCall): ToolEffect {
		return this.engine.classify(toolCall);
	}

	/** A developer request starts: reset per-request evidence and slices. */
	beginRequest(text: string): void {
		this.engine.beginRequest(text);
		this.slices?.beginRequest();
	}

	/**
	 * A developer message arrived, at the start of a request or while it runs. `afterAgentWork`
	 * says whether the agent had already responded, so the message can correct it.
	 */
	observeDeveloperMessage(text: string, timestamp = Date.now(), afterAgentWork = true): void {
		this.engine.observeDeveloperMessage(text, timestamp, afterAgentWork);
	}

	/** Collaboration rules for the system prompt, empty when the alignment pillar is disabled. */
	promptGuidelines(): readonly string[] {
		return this.engine.promptGuidelines();
	}

	/** Alignment check for a validated tool call. */
	async beforeToolCall(toolCall: AgentToolCall, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> {
		if (!this.engine.pillars.alignment) return undefined;
		const effect = this.classify(toolCall);
		const decision: AlignmentDecision = await this.engine.check(toolCall.name, effect, signal);
		if (decision.action === "block") {
			this.onEvent?.({
				type: "tool_blocked",
				toolName: toolCall.name,
				effect,
				kind: decision.kind,
				reason: decision.reason,
			});
		} else if (decision.via) {
			this.onEvent?.({ type: "tool_authorized", toolName: toolCall.name, effect, via: decision.via });
		}
		return AlignmentPolicy.toHookResult(decision);
	}

	/**
	 * Record the outcome of an executed (or blocked) tool call. `output` is its text result;
	 * `startedAt` is what {@link EvidenceLedger.beginToolCall} returned when the call started.
	 */
	recordToolOutcome(toolCall: AgentToolCall, isError: boolean, output?: string, startedAt?: number): void {
		this.engine.recordToolOutcome(this.classify(toolCall), isError, output, startedAt);
	}

	/**
	 * Record the tool calls a delegated agent ran, in order, as if this agent had run them. The
	 * parent then sees the subagent's edits and checks: a delegated edit without a check is still
	 * gated when this agent reports completion. Call it while the delegating tool call runs.
	 */
	recordDelegatedEffects(outcomes: readonly DelegatedOutcome[]): void {
		for (const outcome of outcomes) this.engine.recordToolOutcome(outcome.effect, outcome.isError, outcome.output);
	}

	/**
	 * The conversation changed under the pillars (the developer moved to another branch). Drop what
	 * belongs to the old one: context stubs and digest, pending approvals and grants. Constraints and
	 * corrections are restored by the caller from the new branch.
	 */
	resync(): void {
		this.engine.resync();
	}

	/** Project the messages of one provider request: context policy plus harness state. */
	transformContext(messages: AgentMessage[]): AgentMessage[] {
		let projected = this.engine.transformContext(messages);
		const stats = this.engine.contextStats();
		if (stats && stats.elidedResults !== this.lastElidedResults) {
			this.lastElidedResults = stats.elidedResults;
			this.onEvent?.({ type: "context_elided", stats: { ...stats } });
		}
		const state = this.renderState();
		if (state) projected = appendHarnessState(projected, state);
		return projected;
	}

	/**
	 * Assess a final assistant message. Returns the verification request to send back to the
	 * agent when the claim lacks evidence and the gate budget allows it.
	 */
	assessFinalMessage(
		message: AssistantMessage,
	): { report: CompletionReport; verificationRequest?: AgentMessage } | undefined {
		const assessment = this.engine.assessFinalMessage(messageText(message));
		if (!assessment) return undefined;
		const { report, verificationRequest } = assessment;
		this.onEvent?.({ type: "completion_assessed", report });
		if (verificationRequest === undefined) return { report };
		return {
			report,
			verificationRequest: {
				role: "user",
				content: [{ type: "text", text: verificationRequest }],
				timestamp: Date.now(),
				origin: "harness",
			},
		};
	}

	/** Harness state restated next to the latest message, or undefined when there is none. */
	renderState(): string | undefined {
		return this.engine.renderState(this.slices?.render());
	}

	/** Release the engine's state. The core must not be used afterwards. */
	dispose(): void {
		this.engine.dispose();
	}

	/**
	 * Install the pillars on an agent. Existing hooks keep running: the harness wraps them.
	 * Returns a function that restores the previous hooks and unsubscribes.
	 */
	install(agent: Agent): () => void {
		const previousBeforeToolCall = agent.beforeToolCall;
		const previousTransformContext = agent.transformContext;
		const previousFinishTurn = agent.finishTurn;
		const toolCalls = new Map<string, AgentToolCall>();
		/** When each running call started, so a check run in parallel with an edit does not cover it. */
		const startedAt = new Map<string, number>();
		let awaitingRequest = false;
		// A resumed conversation already contains the agent's work.
		let agentHasResponded = agent.state.messages.some((message) => message.role === "assistant");

		// The agent awaits listeners, so workspace measurements finish before the loop moves on.
		const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
			switch (event.type) {
				case "agent_start":
					// The run's own prompt message follows `agent_start`; continuations and retries have none.
					awaitingRequest = true;
					break;
				case "message_end": {
					const origin = messageOrigin(event.message);
					if (origin === "developer") {
						const text = messageText(event.message);
						if (awaitingRequest) this.beginRequest(text);
						awaitingRequest = false;
						this.observeDeveloperMessage(text, event.message.timestamp, agentHasResponded);
					} else if (origin === "extension" || origin === "agent") {
						// An extension or a delegating agent started this run. A brief is written by a model,
						// so "delete dist and push" in it must not authorize the push: it is a request for
						// evidence, but it states no constraints, grants no approvals and corrects nothing.
						if (awaitingRequest) this.beginRequest(messageText(event.message));
						awaitingRequest = false;
					} else if (event.message.role === "assistant") {
						awaitingRequest = false;
						agentHasResponded = true;
					}
					break;
				}
				case "tool_execution_start": {
					const toolCall: AgentToolCall = {
						type: "toolCall",
						id: event.toolCallId,
						name: event.toolName,
						arguments: event.args ?? {},
					};
					toolCalls.set(event.toolCallId, toolCall);
					const start = this.engine.beginToolCall();
					if (start !== undefined) startedAt.set(event.toolCallId, start);
					const effect = this.classify(toolCall);
					if (mayChangeFiles(effect)) await this.slices?.beforeChange(toolCall.id, writtenPaths(effect));
					break;
				}
				case "tool_execution_end": {
					const toolCall = toolCalls.get(event.toolCallId);
					const start = startedAt.get(event.toolCallId);
					toolCalls.delete(event.toolCallId);
					startedAt.delete(event.toolCallId);
					if (!toolCall) break;
					this.recordToolOutcome(toolCall, event.isError, resultText(event.result), start);
					const effect = this.classify(toolCall);
					if (mayChangeFiles(effect))
						await this.slices?.afterChange(toolCall.id, writtenPaths(effect), event.isError);
					break;
				}
				case "agent_end": {
					// No workspace measurement outlives the run that started it.
					await this.slices?.refresh();
					break;
				}
			}
		});

		agent.beforeToolCall = async (context, signal) => {
			const result = await this.beforeToolCall(context.toolCall, signal);
			if (result?.block) return result;
			return previousBeforeToolCall?.(context, signal);
		};

		agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			await this.slices?.refresh();
			return this.transformContext(transformed);
		};

		agent.finishTurn = async (turn, signal) => {
			const decision = await previousFinishTurn?.(turn, signal);
			if (decision?.action === "end") return decision;
			const message = turn.message;
			const final = message.stopReason === "stop" && !message.content.some((block) => block.type === "toolCall");
			if (!final || signal?.aborted) return decision ?? undefined;
			const assessment = this.assessFinalMessage(message);
			// Steering is polled right after `finishTurn`, so the request runs as the next turn.
			if (assessment?.verificationRequest) agent.steer(assessment.verificationRequest);
			return decision ?? undefined;
		};

		return () => {
			unsubscribe();
			agent.beforeToolCall = previousBeforeToolCall;
			agent.transformContext = previousTransformContext;
			agent.finishTurn = previousFinishTurn;
		};
	}
}
