/**
 * Harness core: the four pillars composed on top of the agent loop.
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
 * | Context     | `transformContext` | recent tool window, batched elision, progress digest       |
 * | Skills      | events             | resource uptake, fanout, and phase telemetry per run       |
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Agent } from "../agent.ts";
import type { AgentEvent, AgentMessage, AgentToolCall, BeforeToolCallResult } from "../types.ts";
import {
	type AlignmentDecision,
	AlignmentPolicy,
	type AlignmentPolicyOptions,
	PAIR_PROGRAMMING_GUIDELINES,
	requestsAction,
} from "./alignment.ts";
import {
	appendHarnessState,
	type ContextPolicyOptions,
	type ContextPolicyStats,
	ContextWindowPolicy,
} from "./context.ts";
import { classifyToolCall, type ToolEffect, type ToolEffectClassifier } from "./effects.ts";
import {
	type CompletionReport,
	EvidenceLedger,
	type EvidenceLedgerOptions,
	formatVerificationRequest,
} from "./evidence.ts";
import { type SkillUsageReport, SkillUsageTracker, type SkillUsageTrackerOptions } from "./skills.ts";
import { isDeveloperMessage, messageText } from "./text.ts";

export type HarnessCoreEvent =
	| { type: "tool_blocked"; toolName: string; effect: ToolEffect; kind: "authorization" | "scope"; reason: string }
	| { type: "tool_authorized"; toolName: string; effect: ToolEffect; via: "request" | "grant" | "authorizer" }
	| { type: "completion_assessed"; report: CompletionReport }
	| { type: "context_elided"; stats: ContextPolicyStats }
	| { type: "skill_usage"; report: SkillUsageReport };

/** Options per pillar. `false` disables a pillar; omitting it uses defaults. */
export interface HarnessCoreOptions {
	alignment?: AlignmentPolicyOptions | false;
	evidence?: EvidenceLedgerOptions | false;
	context?: Omit<ContextPolicyOptions, "classifyEffect"> | false;
	/** Skill telemetry needs to know the skills, so it is off unless configured. */
	skills?: SkillUsageTrackerOptions | false;
	/** Classification for tools the default name-based rules do not know. */
	classifyEffect?: ToolEffectClassifier;
	/** Observer for pillar decisions, for UI, logs, and telemetry. Must not throw. */
	onEvent?: (event: HarnessCoreEvent) => void;
}

/** The four pillars, usable directly by any runtime or installed on an {@link Agent}. */
export class HarnessCore {
	readonly alignment?: AlignmentPolicy;
	readonly evidence?: EvidenceLedger;
	readonly context?: ContextWindowPolicy;
	readonly skills?: SkillUsageTracker;
	private readonly classifyEffect?: ToolEffectClassifier;
	private readonly onEvent?: (event: HarnessCoreEvent) => void;
	private lastElidedResults = 0;

	constructor(options: HarnessCoreOptions = {}) {
		this.classifyEffect = options.classifyEffect;
		this.onEvent = options.onEvent;
		if (options.alignment !== false) this.alignment = new AlignmentPolicy(options.alignment);
		if (options.evidence !== false) this.evidence = new EvidenceLedger(options.evidence);
		if (options.context !== false) {
			this.context = new ContextWindowPolicy({ ...options.context, classifyEffect: options.classifyEffect });
		}
		if (options.skills) this.skills = new SkillUsageTracker(options.skills);
	}

	classify(toolCall: AgentToolCall): ToolEffect {
		return classifyToolCall(toolCall, this.classifyEffect);
	}

	/** A developer request starts: reset per-request evidence and skill telemetry. */
	beginRequest(text: string): void {
		this.evidence?.beginRequest(requestsAction(text));
		this.skills?.beginRun();
	}

	/**
	 * A developer message arrived, at the start of a request or while it runs. `afterAgentWork`
	 * says whether the agent had already responded, so the message can correct it.
	 */
	observeDeveloperMessage(text: string, timestamp = Date.now(), afterAgentWork = true): void {
		this.alignment?.observeDeveloperMessage(text, timestamp, afterAgentWork);
	}

	/** Collaboration rules for the system prompt, empty when the alignment pillar is disabled. */
	promptGuidelines(): readonly string[] {
		return this.alignment ? PAIR_PROGRAMMING_GUIDELINES : [];
	}

	/** Alignment check for a validated tool call. */
	async beforeToolCall(toolCall: AgentToolCall, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> {
		if (!this.alignment) return undefined;
		const effect = this.classify(toolCall);
		const decision: AlignmentDecision = await this.alignment.check(toolCall.name, effect, signal);
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

	/** Record the outcome of an executed (or blocked) tool call. */
	recordToolOutcome(toolCall: AgentToolCall, isError: boolean): void {
		const effect = this.classify(toolCall);
		this.evidence?.recordToolOutcome(effect, isError);
		this.skills?.recordToolCall(effect, isError);
	}

	/** Project the messages of one provider request: context policy plus harness state. */
	transformContext(messages: AgentMessage[]): AgentMessage[] {
		let projected = this.context ? this.context.transform(messages) : messages;
		const stats = this.context?.getStats();
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
		if (!this.evidence) return undefined;
		const report = this.evidence.assess(messageText(message));
		const gate = this.evidence.shouldGate(report);
		this.onEvent?.({ type: "completion_assessed", report });
		if (!gate) return { report };
		return {
			report,
			verificationRequest: {
				role: "user",
				content: [{ type: "text", text: formatVerificationRequest(report) }],
				timestamp: Date.now(),
			},
		};
	}

	/** Harness state restated next to the latest message, or undefined when there is none. */
	renderState(): string | undefined {
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
		const progress = this.context?.renderProgress();
		if (progress) sections.push(progress);
		if (sections.length === 0) return undefined;
		return ["Generated by the harness, not written by the developer.", ...sections].join("\n\n");
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
		let awaitingRequest = false;
		// A resumed conversation already contains the agent's work.
		let agentHasResponded = agent.state.messages.some((message) => message.role === "assistant");

		const unsubscribe = agent.subscribe((event: AgentEvent) => {
			switch (event.type) {
				case "agent_start":
					// The run's own prompt message follows `agent_start`; continuations and retries have none.
					awaitingRequest = true;
					break;
				case "message_end":
					if (isDeveloperMessage(event.message)) {
						const text = messageText(event.message);
						if (awaitingRequest) this.beginRequest(text);
						awaitingRequest = false;
						this.observeDeveloperMessage(text, event.message.timestamp, agentHasResponded);
					} else if (event.message.role === "assistant") {
						awaitingRequest = false;
						agentHasResponded = true;
					}
					break;
				case "tool_execution_start":
					toolCalls.set(event.toolCallId, {
						type: "toolCall",
						id: event.toolCallId,
						name: event.toolName,
						arguments: event.args ?? {},
					});
					break;
				case "tool_execution_end": {
					const toolCall = toolCalls.get(event.toolCallId);
					toolCalls.delete(event.toolCallId);
					if (toolCall) this.recordToolOutcome(toolCall, event.isError);
					break;
				}
				case "agent_end": {
					const report = this.skills?.report();
					if (report && report.events.length > 0) this.onEvent?.({ type: "skill_usage", report });
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
