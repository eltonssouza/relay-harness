/**
 * Pillar 3: less context, better agents.
 *
 * Problem: every tool result stays in context forever. Old results describe states that no
 * longer exist (a file before it was edited), so the model acts on stale state, and the
 * transcript grows until it is compacted. Keeping only the last 5 tool interactions plus a
 * compact progress summary raised task completion from 71.0% to 91.6% while cutting tokens by
 * 62.7% and time by 60.2%; pruning without the summary lost track of progress and ended tasks
 * early (Lodha et al., 2026).
 *
 * Solution, at the request boundary only (the stored transcript is never changed):
 * - Recent window: the last `keepRecent` tool results are sent verbatim.
 * - Elision: older large results are replaced by a one-line stub naming the call, its size and
 *   outcome, and whether the file changed later (the stale-state signal).
 * - Progress digest: the elided calls become a compact, deterministic summary of the work done,
 *   restated near the latest message so global progress survives pruning.
 *
 * Prompt caching: rewriting an old message invalidates the provider's cached prefix after it.
 * Sliding the window by one result per request would invalidate the cache on every request.
 * Elision therefore advances in batches (hysteresis): nothing changes until `batchSize` large
 * results have aged out of the window, then they are elided together and stay elided. Between
 * batches the prefix is byte-identical, so the cache keeps hitting.
 */

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentToolCall } from "../types.ts";
import { classifyToolCall, isMutation, type ToolEffectClassifier } from "./effects.ts";
import { clip } from "./text.ts";

export interface ContextPolicyOptions {
	/** Tool results always sent verbatim, counted from the newest. Default: 6. */
	keepRecent?: number;
	/** Aged-out large results that trigger one elision batch. Default: 6. */
	batchSize?: number;
	/** Results shorter than this many characters are never elided; they cost little. Default: 1500. */
	minElideChars?: number;
	/** Most digest entries restated per request. Default: 30. */
	maxDigestEntries?: number;
	/** Character weight of one image when sizing a result. Default: 4000. */
	imageChars?: number;
	classifyEffect?: ToolEffectClassifier;
}

export interface DigestEntry {
	tool: string;
	call: string;
	ok: boolean;
	chars: number;
	stale: boolean;
}

export interface ContextPolicyStats {
	elidedResults: number;
	elidedChars: number;
	batches: number;
}

interface ElisionRecord {
	stub: string;
	entry: DigestEntry;
}

function resultChars(message: ToolResultMessage, imageChars: number): number {
	let chars = 0;
	for (const block of message.content) chars += block.type === "text" ? block.text.length : imageChars;
	return chars;
}

/** Recent-window pruning with a deterministic progress digest. */
export class ContextWindowPolicy {
	private readonly keepRecent: number;
	private readonly batchSize: number;
	private readonly minElideChars: number;
	private readonly maxDigestEntries: number;
	private readonly imageChars: number;
	private readonly classifyEffect?: ToolEffectClassifier;
	/** Elision decisions by tool call id. Once elided, a result stays elided. */
	private readonly elided = new Map<string, ElisionRecord>();
	private readonly digest: DigestEntry[] = [];
	private readonly stats: ContextPolicyStats = { elidedResults: 0, elidedChars: 0, batches: 0 };

	constructor(options: ContextPolicyOptions = {}) {
		this.keepRecent = Math.max(1, options.keepRecent ?? 6);
		this.batchSize = Math.max(1, options.batchSize ?? 6);
		this.minElideChars = options.minElideChars ?? 1500;
		this.maxDigestEntries = options.maxDigestEntries ?? 30;
		this.imageChars = options.imageChars ?? 4000;
		this.classifyEffect = options.classifyEffect;
	}

	/** Apply the policy to the messages of one request. Returns the input array when nothing changes. */
	transform(messages: AgentMessage[]): AgentMessage[] {
		const toolResultIndexes: number[] = [];
		const toolCalls = new Map<string, AgentToolCall>();
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index];
			if (message.role === "toolResult") toolResultIndexes.push(index);
			if (message.role === "assistant") {
				for (const block of message.content) if (block.type === "toolCall") toolCalls.set(block.id, block);
			}
		}

		this.advanceBatch(messages, toolResultIndexes, toolCalls);
		if (this.elided.size === 0) return messages;

		let changed = false;
		const result = messages.map((message) => {
			if (message.role !== "toolResult") return message;
			const record = this.elided.get(message.toolCallId);
			if (!record) return message;
			changed = true;
			return { ...message, content: [{ type: "text" as const, text: record.stub }] };
		});
		return changed ? result : messages;
	}

	/** Compact digest of elided work, or undefined when nothing was elided. */
	renderProgress(): string | undefined {
		if (this.digest.length === 0) return undefined;
		const shown = this.digest.slice(-this.maxDigestEntries);
		const omitted = this.digest.length - shown.length;
		return [
			`Earlier tool results elided from context (${this.digest.length} calls). Progress so far:`,
			...(omitted > 0 ? [`- ... ${omitted} earlier calls`] : []),
			...shown.map(
				(entry) =>
					`- ${entry.tool} ${entry.call}: ${entry.ok ? "ok" : "error"}${entry.stale ? " (file changed later)" : ""}`,
			),
		].join("\n");
	}

	getStats(): Readonly<ContextPolicyStats> {
		return this.stats;
	}

	private advanceBatch(
		messages: AgentMessage[],
		toolResultIndexes: number[],
		toolCalls: Map<string, AgentToolCall>,
	): void {
		const aged = toolResultIndexes.slice(0, Math.max(0, toolResultIndexes.length - this.keepRecent));
		const candidates = aged.filter((index) => {
			const message = messages[index] as ToolResultMessage;
			return !this.elided.has(message.toolCallId) && resultChars(message, this.imageChars) >= this.minElideChars;
		});
		if (candidates.length < this.batchSize) return;

		this.stats.batches++;
		for (const index of candidates) {
			const message = messages[index] as ToolResultMessage;
			const toolCall = toolCalls.get(message.toolCallId);
			const chars = resultChars(message, this.imageChars);
			const effect = toolCall ? classifyToolCall(toolCall, this.classifyEffect) : undefined;
			const call = effect?.command
				? `\`${clip(effect.command, 100)}\``
				: effect?.paths.length
					? effect.paths.join(", ")
					: toolCall
						? clip(JSON.stringify(toolCall.arguments ?? {}), 100)
						: "";
			const stale =
				effect?.kind === "read" &&
				effect.paths.length > 0 &&
				this.changedAfter(messages, index, toolCalls, new Set(effect.paths));
			const entry: DigestEntry = { tool: message.toolName, call, ok: !message.isError, chars, stale };
			const stub =
				`[harness:context] Result elided to keep context focused: ${message.toolName} ${call} ` +
				`(${chars} chars, ${message.isError ? "error" : "ok"}).` +
				(stale ? " The file was changed later, so this content was stale." : "") +
				" Re-run the call if you need the content.";
			this.elided.set(message.toolCallId, { stub, entry });
			this.digest.push(entry);
			this.stats.elidedResults++;
			this.stats.elidedChars += chars - stub.length;
		}
	}

	/** Whether any of `paths` was mutated by a tool call issued after message `index`. */
	private changedAfter(
		messages: AgentMessage[],
		index: number,
		toolCalls: Map<string, AgentToolCall>,
		paths: Set<string>,
	): boolean {
		for (let later = index + 1; later < messages.length; later++) {
			const message = messages[later];
			if (message.role !== "toolResult" || message.isError) continue;
			const toolCall = toolCalls.get(message.toolCallId);
			if (!toolCall) continue;
			const effect = classifyToolCall(toolCall, this.classifyEffect);
			if (isMutation(effect.kind) && effect.paths.some((path) => paths.has(path))) return true;
		}
		return false;
	}
}

/**
 * Append harness state to the newest user or tool-result message of a request. The tail is the
 * cheapest position for prompt caching and the most salient one for the model. Messages ending
 * in another role are returned unchanged.
 */
export function appendHarnessState(messages: AgentMessage[], state: string): AgentMessage[] {
	const last = messages.at(-1);
	if (!last || (last.role !== "user" && last.role !== "toolResult")) return messages;
	const block = { type: "text" as const, text: `<harness_state>\n${state}\n</harness_state>` };
	const content = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
	return [...messages.slice(0, -1), { ...last, content: [...content, block] } as AgentMessage];
}
