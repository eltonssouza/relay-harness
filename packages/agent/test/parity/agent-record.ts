/**
 * Reference behavior of the `Agent` class, for the Rust port to match.
 *
 * Each case builds an agent from an initial state and runs steps: prompts, continuations, queued
 * messages, resets and setting changes. Tools and listeners can run the same operations while a
 * run is going, as an extension steering from a tool or an event handler does. The stream
 * function answers from the case's responses, as the loop recorder's does. The case records:
 *
 * - each event a listener saw, with the agent's state at that moment;
 * - each operation's outcome (an error message when the agent refuses it);
 * - each request the stream function received;
 * - the agent's state after each step.
 *
 * Times become 0.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent, Message, Model } from "@relay-harness/ai";
import { Agent } from "../../src/agent.ts";
import type { AgentEvent, AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../../src/types.ts";
import {
	call,
	clone,
	echo,
	eventStream,
	MODEL,
	object,
	type Response,
	responseEvents,
	type Schema,
	system,
	text,
	user,
	zeroTimes,
} from "./loop-record.ts";

export const AGENT_DIR = fileURLToPath(new URL("../../../../crates/fixtures/agent/", import.meta.url));

export type Op =
	| { op: "prompt"; text: string; images?: ImageContent[] }
	| { op: "promptMessages"; messages: AgentMessage[] }
	| { op: "continue" }
	| { op: "steer"; message: AgentMessage }
	| { op: "followUp"; message: AgentMessage }
	| { op: "abort" }
	| { op: "reset" }
	| { op: "clearQueues" }
	| { op: "peek" }
	| { op: "setThinkingLevel"; level: ThinkingLevel }
	| { op: "setTools"; tools: string[] };

interface AgentToolSpec {
	name: string;
	parameters: Schema;
	/** Run while the tool executes. */
	ops?: Op[];
}

export interface AgentCase {
	name: string;
	description: string;
	tools: AgentToolSpec[];
	initialState?: {
		systemPrompt?: string;
		thinkingLevel?: ThinkingLevel;
		/** Names from `tools`. */
		tools?: string[];
		messages?: AgentMessage[];
	};
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	responses: Response[];
	steps: Op[];
	/** Operations a listener runs on the `nth` event (from 1) of a type. */
	listen?: { on: AgentEvent["type"]; nth: number; ops: Op[] }[];
}

const work = (ops: Op[]): AgentToolSpec => ({ name: "work", parameters: object({}), ops });
const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };

export function agentCases(): AgentCase[] {
	const brief = { systemPrompt: "Be brief." };
	return [
		{
			name: "prompt-text",
			description: "A text prompt; the initial prompt and tools become the leading system message.",
			tools: [echo],
			initialState: { ...brief, tools: ["echo"] },
			responses: [{ content: [text("Hello.")] }],
			steps: [{ op: "prompt", text: "Hi" }],
		},
		{
			name: "prompt-images",
			description: "Images follow the prompt text in the user message.",
			tools: [],
			initialState: brief,
			responses: [{ content: [text("A picture.")] }],
			steps: [{ op: "prompt", text: "Look", images: [image] }],
		},
		{
			name: "prompt-messages",
			description: "A batch of messages is the prompt as given.",
			tools: [],
			initialState: brief,
			responses: [{ content: [text("Both.")] }],
			steps: [{ op: "promptMessages", messages: [user("One"), user("Two")] }],
		},
		{
			name: "initial-messages",
			description: "Messages that start with a system message keep it; the initial prompt is not added.",
			tools: [],
			initialState: { systemPrompt: "Unused.", messages: [system("Own prompt."), user("Earlier?")] },
			responses: [{ content: [text("Answer.")] }],
			steps: [{ op: "continue" }],
		},
		{
			name: "no-system-prompt",
			description: "Without a prompt or tools the transcript has no system message.",
			tools: [],
			responses: [{ content: [text("Hi.")] }],
			steps: [{ op: "prompt", text: "Hi" }],
		},
		{
			name: "thinking-level",
			description: "The thinking level is the request's reasoning; off is none.",
			tools: [],
			initialState: { ...brief, thinkingLevel: "high" },
			responses: [{ content: [text("One.")] }, { content: [text("Two.")] }],
			steps: [
				{ op: "prompt", text: "A" },
				{ op: "setThinkingLevel", level: "off" },
				{ op: "prompt", text: "B" },
			],
		},
		{
			name: "tool-run",
			description: "While a tool runs, its call is pending and the run is streaming.",
			tools: [{ ...echo, ops: [{ op: "peek" }] }],
			initialState: { ...brief, tools: ["echo"] },
			responses: [
				{ content: [call("call_1", "echo", { text: "a" })], stopReason: "toolUse" },
				{ content: [text("Done.")] },
			],
			steps: [{ op: "prompt", text: "Go" }],
		},
		{
			name: "steer-one-at-a-time",
			description: "Steered messages arrive one per turn by default.",
			tools: [
				work([
					{ op: "steer", message: user("A") },
					{ op: "steer", message: user("B") },
				]),
			],
			initialState: { ...brief, tools: ["work"] },
			responses: [
				{ content: [call("call_1", "work", {})], stopReason: "toolUse" },
				{ content: [text("Got A.")] },
				{ content: [text("Got B.")] },
			],
			steps: [{ op: "prompt", text: "Go" }],
		},
		{
			name: "steer-all",
			description: "In `all` mode the steered messages arrive together.",
			tools: [
				work([
					{ op: "steer", message: user("A") },
					{ op: "steer", message: user("B") },
				]),
			],
			initialState: { ...brief, tools: ["work"] },
			steeringMode: "all",
			responses: [
				{ content: [call("call_1", "work", {})], stopReason: "toolUse" },
				{ content: [text("Got both.")] },
			],
			steps: [{ op: "prompt", text: "Go" }],
		},
		{
			name: "follow-up-one-at-a-time",
			description: "Follow-ups wait until the agent would stop, then run one per turn.",
			tools: [
				work([
					{ op: "followUp", message: user("A") },
					{ op: "followUp", message: user("B") },
				]),
			],
			initialState: { ...brief, tools: ["work"] },
			responses: [
				{ content: [call("call_1", "work", {})], stopReason: "toolUse" },
				{ content: [text("Done.")] },
				{ content: [text("Got A.")] },
				{ content: [text("Got B.")] },
			],
			steps: [{ op: "prompt", text: "Go" }],
		},
		{
			name: "follow-up-all",
			description: "In `all` mode the follow-ups run together.",
			tools: [
				work([
					{ op: "followUp", message: user("A") },
					{ op: "followUp", message: user("B") },
				]),
			],
			initialState: { ...brief, tools: ["work"] },
			followUpMode: "all",
			responses: [
				{ content: [call("call_1", "work", {})], stopReason: "toolUse" },
				{ content: [text("Done.")] },
				{ content: [text("Got both.")] },
			],
			steps: [{ op: "prompt", text: "Go" }],
		},
		{
			name: "continue-queued",
			description: "Continuing after an answer runs the queued steering, then the queued follow-up.",
			tools: [],
			initialState: brief,
			responses: [{ content: [text("First.")] }, { content: [text("Steered.")] }, { content: [text("Followed.")] }],
			steps: [
				{ op: "prompt", text: "Hi" },
				{ op: "steer", message: user("X") },
				{ op: "continue" },
				{ op: "followUp", message: user("Y") },
				{ op: "continue" },
			],
		},
		{
			name: "continue-two-steered",
			description: "Continuing from two steered messages takes one as the prompt; the start skips its poll.",
			tools: [],
			initialState: brief,
			responses: [{ content: [text("First.")] }, { content: [text("Got X.")] }, { content: [text("Got W.")] }],
			steps: [
				{ op: "prompt", text: "Hi" },
				{ op: "steer", message: user("X") },
				{ op: "steer", message: user("W") },
				{ op: "continue" },
			],
		},
		{
			name: "continue-errors",
			description: "Nothing to continue from, then an answer with no queued messages.",
			tools: [],
			initialState: brief,
			responses: [{ content: [text("Hi.")] }],
			steps: [{ op: "continue" }, { op: "prompt", text: "Hi" }, { op: "continue" }],
		},
		{
			name: "busy",
			description: "Prompting, continuing or resetting during a run is refused.",
			tools: [work([{ op: "prompt", text: "Again" }, { op: "continue" }, { op: "reset" }])],
			initialState: { ...brief, tools: ["work"] },
			responses: [{ content: [call("call_1", "work", {})], stopReason: "toolUse" }, { content: [text("Done.")] }],
			steps: [{ op: "prompt", text: "Go" }],
		},
		{
			name: "reset",
			description: "Reset keeps the replayed system message and clears the queues.",
			tools: [echo],
			initialState: { ...brief, tools: ["echo"] },
			responses: [{ content: [text("First.")] }, { content: [text("Again.")] }],
			steps: [
				{ op: "prompt", text: "Hi" },
				{ op: "followUp", message: user("Z") },
				{ op: "reset" },
				{ op: "peek" },
				{ op: "prompt", text: "Again" },
			],
		},
		{
			name: "abort",
			description: "A tool aborts the run: the next request is aborted and its error is the agent's.",
			tools: [{ name: "stopper", parameters: object({}), ops: [{ op: "abort" }] }],
			initialState: { ...brief, tools: ["stopper"] },
			responses: [
				{ content: [call("call_1", "stopper", {})], stopReason: "toolUse" },
				{ content: [text("Fresh.")] },
			],
			steps: [
				{ op: "prompt", text: "Go" },
				{ op: "prompt", text: "Again" },
			],
		},
		{
			name: "error-response",
			description: "An error answer sets the agent's error; the next run clears it.",
			tools: [],
			initialState: brief,
			responses: [
				{ content: [text("Half")], stopReason: "error", errorMessage: "Boom." },
				{ content: [text("Ok.")] },
			],
			steps: [
				{ op: "prompt", text: "A" },
				{ op: "prompt", text: "B" },
			],
		},
		{
			name: "listener-steers",
			description: "A listener that steers on the first turn end is heard in the same run.",
			tools: [],
			initialState: brief,
			listen: [{ on: "turn_end", nth: 1, ops: [{ op: "steer", message: user("From listener.") }] }],
			responses: [{ content: [text("First.")] }, { content: [text("Heard.")] }],
			steps: [{ op: "prompt", text: "Hi" }],
		},
		{
			name: "peek-order",
			description: "Peeking shows steering before follow-ups without taking them; clearing empties both.",
			tools: [
				work([
					{ op: "followUp", message: user("A") },
					{ op: "steer", message: user("B") },
					{ op: "peek" },
					{ op: "clearQueues" },
					{ op: "peek" },
				]),
			],
			initialState: { ...brief, tools: ["work"] },
			responses: [{ content: [call("call_1", "work", {})], stopReason: "toolUse" }, { content: [text("Done.")] }],
			steps: [{ op: "prompt", text: "Go" }],
		},
		{
			name: "tool-change",
			description: "Tools added between prompts are announced before the next request.",
			tools: [echo, { name: "read", parameters: object({ path: { type: "string" } }, ["path"]) }],
			initialState: { ...brief, tools: ["echo"] },
			responses: [{ content: [text("One.")] }, { content: [text("Two.")] }],
			steps: [
				{ op: "prompt", text: "A" },
				{ op: "setTools", tools: ["echo", "read"] },
				{ op: "prompt", text: "B" },
			],
		},
		{
			name: "steer-before-prompt",
			description: "A message steered before a prompt goes with it.",
			tools: [],
			initialState: brief,
			responses: [{ content: [text("Both.")] }],
			steps: [
				{ op: "steer", message: user("Early.") },
				{ op: "prompt", text: "Hi" },
			],
		},
	];
}

export interface AgentRecording {
	events: unknown[];
	ops: unknown[];
	calls: unknown[];
	states: unknown[];
}

export async function recordAgent(testCase: AgentCase): Promise<AgentRecording> {
	const events: unknown[] = [];
	const ops: unknown[] = [];
	const calls: unknown[] = [];
	const states: unknown[] = [];
	let responseIndex = 0;
	let agent: Agent | undefined;

	const tools = new Map<string, AgentTool>(
		testCase.tools.map((spec) => [
			spec.name,
			{
				name: spec.name,
				label: spec.name,
				description: `${spec.name} tool`,
				parameters: spec.parameters as never,
				execute: async () => {
					await runOps(spec.ops ?? [], `tool:${spec.name}`);
					return { content: [{ type: "text", text: `${spec.name} ok` }], details: {} };
				},
			},
		]),
	);
	const toolsNamed = (names: string[]) => names.map((name) => tools.get(name) as AgentTool);

	const queued = () => ({
		queued: zeroTimes(clone(agent?.peekQueuedMessages() ?? [])),
		has: agent?.hasQueuedMessages() ?? false,
	});

	async function perform(op: Op): Promise<unknown> {
		const current = agent as Agent;
		switch (op.op) {
			case "prompt":
				return current.prompt(op.text, op.images);
			case "promptMessages":
				return current.prompt(clone(op.messages));
			case "continue":
				return current.continue();
			case "steer":
				return current.steer(clone(op.message));
			case "followUp":
				return current.followUp(clone(op.message));
			case "abort":
				return current.abort();
			case "reset":
				return current.reset();
			case "clearQueues":
				return current.clearAllQueues();
			case "peek":
				return queued();
			case "setThinkingLevel":
				current.state.thinkingLevel = op.level;
				return undefined;
			case "setTools":
				current.state.tools = toolsNamed(op.tools);
				return undefined;
		}
	}

	async function runOps(list: Op[], at: string): Promise<void> {
		for (const op of list) {
			const entry: Record<string, unknown> = { at, op: op.op };
			try {
				const value = await perform(op);
				entry.result = "ok";
				if (value !== undefined) entry.value = value;
			} catch (error) {
				entry.result = { error: error instanceof Error ? error.message : String(error) };
			}
			ops.push(entry);
		}
	}

	const snapshot = () => {
		const state = (agent as Agent).state;
		return {
			streaming: state.isStreaming,
			streamingRole: (state.streamingMessage as { role?: string } | undefined)?.role ?? null,
			pending: [...state.pendingToolCalls],
			messages: state.messages.length,
			error: state.errorMessage ?? null,
		};
	};

	const fullState = (after: string) => {
		const state = (agent as Agent).state;
		return {
			after,
			systemPrompt: state.systemPrompt,
			model: state.model.id,
			thinkingLevel: state.thinkingLevel,
			messages: zeroTimes(clone(state.messages)),
			isStreaming: state.isStreaming,
			streamingMessage: (state.streamingMessage as { role?: string } | undefined)?.role ?? null,
			pending: [...state.pendingToolCalls],
			errorMessage: state.errorMessage ?? null,
			...queued(),
		};
	};

	const streamFn = (
		model: Model<"openai-responses">,
		context: { messages: Message[] },
		options?: { reasoning?: string; signal?: AbortSignal },
	) => {
		calls.push({ model: model.id, messages: clone(context.messages), reasoning: options?.reasoning ?? null });
		if (options?.signal?.aborted) {
			return eventStream(
				responseEvents({ content: [], stopReason: "aborted", errorMessage: "Request was aborted" }, model),
			);
		}
		const response = testCase.responses[responseIndex++];
		if (!response) throw new Error(`${testCase.name}: no response ${responseIndex}`);
		return eventStream(responseEvents(response, model));
	};

	const initial = testCase.initialState ?? {};
	agent = new Agent({
		initialState: {
			...(initial.systemPrompt !== undefined ? { systemPrompt: initial.systemPrompt } : {}),
			model: MODEL,
			...(initial.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
			tools: toolsNamed(initial.tools ?? []),
			messages: clone(initial.messages ?? []),
		},
		streamFn: streamFn as never,
		...(testCase.steeringMode ? { steeringMode: testCase.steeringMode } : {}),
		...(testCase.followUpMode ? { followUpMode: testCase.followUpMode } : {}),
	});

	const seen = new Map<string, number>();
	agent.subscribe(async (event) => {
		const nth = (seen.get(event.type) ?? 0) + 1;
		seen.set(event.type, nth);
		const entry: Record<string, unknown> = { type: event.type };
		if ("message" in event) entry.role = (event.message as { role?: string }).role ?? null;
		if ("toolCallId" in event) entry.toolCallId = event.toolCallId;
		entry.state = snapshot();
		events.push(entry);
		for (const trigger of testCase.listen ?? []) {
			if (trigger.on === event.type && trigger.nth === nth)
				await runOps(trigger.ops, `listener:${event.type}#${nth}`);
		}
	});

	for (const step of testCase.steps) {
		await runOps([step], "step");
		states.push(fullState(step.op));
	}
	return { events, ops, calls: zeroTimes(calls) as unknown[], states };
}

export async function agentJson(testCase: AgentCase): Promise<string> {
	const recording = await recordAgent(testCase);
	const tools = testCase.tools.map((tool) => ({ ...tool, parameters: clone(tool.parameters) }));
	return `${JSON.stringify({ ...testCase, tools, ...recording }, null, "\t")}\n`;
}

export function readAgentCase(name: string): string {
	return readFileSync(join(AGENT_DIR, `${name}.json`), "utf8");
}
