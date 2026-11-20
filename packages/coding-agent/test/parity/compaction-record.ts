/**
 * Reference behavior of compaction (`src/core/compaction/`) and the assistant retry loop
 * (`packages/ai/src/utils/retry.ts`), for the Rust port:
 *
 * - `compaction/estimate.json`: token estimates of messages and contexts, `shouldCompact`, and the
 *   projected estimate that distrusts usage from before an edit or compaction.
 * - `compaction/prepare.json`: `findCutPoint` and `prepareCompaction` on handcrafted session paths.
 * - `compaction/serialize.json`: `convertToLlm` with `serializeConversation`, and the file lists.
 * - `compaction/compact.json`: `compact` with a scripted stream function: each request it received
 *   and the result or error.
 * - `compaction/retry.json`: `isRetryableAssistantError`, `retryDelayMs` and `retryAssistantCall`
 *   with its callbacks.
 *
 * Generated session ids become `<uuid7>` and the summary request's time 0.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@relay-harness/agent-core";
import {
	type AssistantMessage,
	isRetryableAssistantError,
	type Model,
	type RetryPolicy,
	retryAssistantCall,
	retryDelayMs,
	type Usage,
} from "@relay-harness/ai";
import {
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateProjectedContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	getLastAssistantUsage,
	prepareCompaction,
	shouldCompact,
} from "../../src/core/compaction/compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	serializeConversation,
} from "../../src/core/compaction/utils.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { buildSessionProjection, type SessionEntry } from "../../src/core/session-manager.ts";

export const COMPACTION_DIR = fileURLToPath(new URL("../../../../crates/fixtures/compaction/", import.meta.url));

const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

const usage = (total: number, input = total, output = 0): Usage => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: total,
	cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
});

const user = (content: unknown, timestamp = 1) => ({ role: "user", content, timestamp });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-test",
	usage: usage(0),
	stopReason: "stop",
	timestamp: 2,
	...extra,
});
const text = (value: string) => ({ type: "text", text: value });
const toolCall = (name: string, args: Record<string, unknown>, id = "call-1") => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
const toolResult = (content: unknown[], extra: Record<string, unknown> = {}) => ({
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	content,
	isError: false,
	timestamp: 3,
	...extra,
});
const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

const ESTIMATED_MESSAGES: unknown[] = [
	user("hello world"),
	user([text("abc"), image, text("🙂 emoji")]),
	user([]),
	assistant([
		text("answer"),
		{ type: "thinking", thinking: "thinking it through" },
		toolCall("read", { path: "a.ts", options: { offset: 1, nested: ["x"] } }),
	]),
	toolResult([text("file contents"), image]),
	{ role: "custom", customType: "note", content: "custom text", display: true, timestamp: 4 },
	{ role: "custom", customType: "note", content: [text("blocks"), image], display: true, timestamp: 4 },
	{
		role: "bashExecution",
		command: "ls -la",
		output: "a\nb",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 5,
	},
	{ role: "branchSummary", summary: "branch summary text", fromId: "x", timestamp: 6 },
	{ role: "compactionSummary", summary: "compaction summary", tokensBefore: 10, timestamp: 7 },
	{
		role: "system",
		content: [text("system prompt"), image],
		sections: { rules: "be brief", gone: null },
		toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object" } }],
		timestamp: 0,
	},
	{ role: "system", content: "plain system", timestamp: 0 },
	{ role: "unknown", content: "ignored", timestamp: 0 },
];

const CONTEXTS: unknown[][] = [
	[user("no usage here"), assistant([text("reply")])],
	[user("before"), assistant([text("x")], { usage: usage(120) }), user("after usage"), toolResult([text("more")])],
	[
		user("q"),
		assistant([text("x")], { usage: usage(500) }),
		assistant([text("failed")], { usage: usage(900), stopReason: "error" }),
	],
	[
		user("q"),
		assistant([text("x")], { usage: usage(500) }),
		assistant([text("stopped")], { usage: usage(900), stopReason: "aborted" }),
	],
	[user("q"), assistant([text("x")], { usage: { ...usage(0, 10, 5), cacheRead: 3, cacheWrite: 2 } })],
	[user("q"), assistant([text("x")], { usage: usage(0, 0, 0) })],
	[],
];

const entry = (type: string, id: string, parentId: string | null, fields: Record<string, unknown>) => ({
	type,
	id,
	parentId,
	timestamp: `2026-11-01T09:00:${id.replace(/\D/g, "").padStart(2, "0").slice(-2)}.000Z`,
	...fields,
});

/** A linear path of entries, each the child of the one before. */
function path(...items: [string, Record<string, unknown>][]): SessionEntry[] {
	let parent: string | null = null;
	return items.map(([type, fields], index) => {
		const id = `e${index + 1}`;
		const value = entry(type, id, parent, fields);
		parent = id;
		return value as SessionEntry;
	});
}

const big = (label: string, chars: number) => `${label} ${"x".repeat(chars)}`;

const PATHS: Record<string, SessionEntry[]> = {
	simple: path(
		["message", { message: user(big("first question", 400)) }],
		["message", { message: assistant([text(big("first answer", 400))]) }],
		["message", { message: user(big("second question", 400)) }],
		["message", { message: assistant([text(big("second answer", 400))], { usage: usage(800) }) }],
		["message", { message: user(big("third question", 400)) }],
		["message", { message: assistant([text(big("third answer", 400))]) }],
	),
	"split turn": path(
		["message", { message: user(big("old question", 200)) }],
		["message", { message: assistant([text("old answer")]) }],
		["message", { message: user("do the long task") }],
		["message", { message: assistant([toolCall("read", { path: "src/a.ts" })]) }],
		["message", { message: toolResult([text(big("contents", 800))]) }],
		["message", { message: assistant([toolCall("edit", { path: "src/b.ts", edits: [] })]) }],
		["message", { message: toolResult([text(big("edited", 800))], { toolName: "edit" }) }],
		["message", { message: assistant([text("done with the task")]) }],
	),
	"previous compaction": path(
		["message", { message: user(big("ancient", 300)) }],
		["message", { message: assistant([toolCall("write", { path: "old.txt", content: "x" })]) }],
		["message", { message: user(big("kept question", 300)) }],
		[
			"compaction",
			{
				summary: "earlier summary",
				firstKeptEntryId: "e3",
				tokensBefore: 999,
				details: { readFiles: ["r.txt", "both.txt"], modifiedFiles: ["m.txt"] },
			},
		],
		["message", { message: assistant([toolCall("read", { path: "both.txt" })]) }],
		["message", { message: toolResult([text(big("read result", 300))]) }],
		["message", { message: user(big("new question", 300)) }],
		["message", { message: assistant([text(big("new answer", 300))]) }],
	),
	"hook compaction details ignored": path(
		["message", { message: user(big("question", 300)) }],
		[
			"compaction",
			{
				summary: "hook summary",
				firstKeptEntryId: "e1",
				tokensBefore: 5,
				details: { readFiles: ["hook.txt"] },
				fromHook: true,
			},
		],
		["message", { message: assistant([text(big("answer", 300))]) }],
		["message", { message: user(big("more", 300)) }],
		["message", { message: assistant([text(big("reply", 300))]) }],
	),
	"ends with a compaction": path(
		["message", { message: user("q") }],
		["compaction", { summary: "s", firstKeptEntryId: "e1", tokensBefore: 1 }],
	),
	"everything kept": path(
		["message", { message: user("short") }],
		["message", { message: assistant([text("tiny")]) }],
	),
	"metadata before the cut": path(
		["message", { message: user(big("one", 400)) }],
		["message", { message: assistant([text(big("two", 400))]) }],
		["model_change", { provider: "openai", modelId: "gpt" }],
		["label", { targetId: "e1", label: "start" }],
		["thinking_level_change", { thinkingLevel: "high" }],
		["message", { message: user(big("three", 400)) }],
		["message", { message: assistant([text(big("four", 400))]) }],
	),
	"system messages are not summarized": path(
		["message", { message: { role: "system", content: "Prompt.", timestamp: 0 } }],
		["message", { message: user(big("one", 400)) }],
		["message", { message: { role: "system", content: "More prompt.", timestamp: 1 } }],
		["message", { message: assistant([text(big("two", 400))]) }],
		["message", { message: user(big("three", 400)) }],
		["message", { message: assistant([text(big("four", 400))]) }],
	),
	"omitted recovery attempt": path(
		["message", { message: user(big("question", 600)) }],
		["message", { message: assistant([text(big("answer", 600))]) }],
		["message", { message: user(big("retry this", 600)) }],
		[
			"message",
			{ message: assistant([text(big("failed attempt", 600))], { stopReason: "error", errorMessage: "x" }) },
		],
		["context_edit", { targetId: "e4", replacement: null }],
	),
	"edit replacing earlier content": path(
		["message", { message: user(big("question", 600)) }],
		["message", { message: assistant([text(big("answer", 600))]) }],
		["message", { message: user(big("retry this", 600)) }],
		["message", { message: assistant([text(big("failed attempt", 600))]) }],
		["context_edit", { targetId: "e4", replacement: null }],
		["context_edit", { targetId: "e1", replacement: { content: "short question" } }],
	),
	"usage before an edit": path(
		["message", { message: user(big("question", 200)) }],
		["message", { message: assistant([text(big("answer", 200))], { usage: usage(900) }) }],
		["message", { message: user(big("follow-up", 200)) }],
		["context_edit", { targetId: "e1", replacement: { content: "short" } }],
	),
	"usage after an edit": path(
		["message", { message: user(big("question", 200)) }],
		["context_edit", { targetId: "e1", replacement: { content: "short" } }],
		["message", { message: assistant([text(big("answer", 200))], { usage: usage(900) }) }],
		["message", { message: user(big("follow-up", 200)) }],
	),
	"compaction keeping everything": path(
		["message", { message: user(big("one", 400)) }],
		["message", { message: assistant([text(big("two", 400))]) }],
		["message", { message: user(big("three", 400)) }],
		["compaction", { summary: "keeps all", firstKeptEntryId: "e1", tokensBefore: 10 }],
	),
	"nested tool calls and other turn starts": path(
		[
			"message",
			{
				message: {
					role: "bashExecution",
					command: big("make", 300),
					output: "ok",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				},
			},
		],
		[
			"message",
			{
				message: toolResult([text(big("script", 300))], {
					toolName: "codemode",
					nestedCalls: {
						calls: [
							{ name: "write", arguments: { path: "gen.ts" } },
							{ name: "read", arguments: { path: 5 } },
						],
					},
				}),
			},
		],
		["custom_message", { customType: "note", content: big("custom", 300), display: true }],
		["branch_summary", { fromId: "e1", summary: big("branch", 300) }],
		["message", { message: assistant([text(big("final", 300))]) }],
	),
};

const CUT_CASES: { path: string; start: number; end?: number; keep: number }[] = [
	{ path: "simple", start: 0, keep: 150 },
	{ path: "simple", start: 0, keep: 1 },
	{ path: "simple", start: 0, keep: 100000 },
	{ path: "simple", start: 2, keep: 150 },
	{ path: "split turn", start: 0, keep: 300 },
	{ path: "split turn", start: 0, keep: 150 },
	{ path: "metadata before the cut", start: 0, keep: 150 },
	{ path: "nested tool calls and other turn starts", start: 0, keep: 100 },
	{ path: "ends with a compaction", start: 0, keep: 1 },
];

const PREPARE_CASES: { path: string; keepRecentTokens: number }[] = [
	{ path: "simple", keepRecentTokens: 150 },
	{ path: "simple", keepRecentTokens: 1 },
	{ path: "split turn", keepRecentTokens: 300 },
	{ path: "split turn", keepRecentTokens: 150 },
	{ path: "previous compaction", keepRecentTokens: 100 },
	{ path: "hook compaction details ignored", keepRecentTokens: 100 },
	{ path: "ends with a compaction", keepRecentTokens: 1 },
	{ path: "everything kept", keepRecentTokens: 100000 },
	{ path: "metadata before the cut", keepRecentTokens: 150 },
	{ path: "system messages are not summarized", keepRecentTokens: 150 },
	{ path: "omitted recovery attempt", keepRecentTokens: 200 },
	{ path: "omitted recovery attempt", keepRecentTokens: 100 },
	{ path: "edit replacing earlier content", keepRecentTokens: 200 },
	{ path: "edit replacing earlier content", keepRecentTokens: 100 },
	{ path: "compaction keeping everything", keepRecentTokens: 10 },
	{ path: "nested tool calls and other turn starts", keepRecentTokens: 100 },
];

/** A preparation as JSON: file operation sets as their arrays. */
function preparationJson(preparation: ReturnType<typeof prepareCompaction>): unknown {
	if (!preparation) return "<undefined>";
	return JSON.parse(
		JSON.stringify({
			...preparation,
			fileOps: {
				read: [...preparation.fileOps.read],
				written: [...preparation.fileOps.written],
				edited: [...preparation.fileOps.edited],
			},
		}),
	);
}

function estimateJson(): string {
	const projectedPaths = [
		"simple",
		"previous compaction",
		"omitted recovery attempt",
		"edit replacing earlier content",
		"usage before an edit",
		"usage after an edit",
	];
	return json({
		messages: ESTIMATED_MESSAGES.map((message) => ({ message, tokens: estimateTokens(message as AgentMessage) })),
		contexts: CONTEXTS.map((messages) => ({ messages, estimate: estimateContextTokens(messages as AgentMessage[]) })),
		usages: [usage(0, 10, 5), usage(42), usage(99, 10, 5), { ...usage(0, 0, 0), cacheRead: 7, cacheWrite: 1 }].map(
			(value) => ({
				usage: value,
				tokens: calculateContextTokens(value),
			}),
		),
		shouldCompact: [
			[1000, 2000, DEFAULT_COMPACTION_SETTINGS],
			[190000, 200000, DEFAULT_COMPACTION_SETTINGS],
			[183616, 200000, DEFAULT_COMPACTION_SETTINGS],
			[183617, 200000, DEFAULT_COMPACTION_SETTINGS],
			[190000, 200000, { ...DEFAULT_COMPACTION_SETTINGS, enabled: false }],
		].map(([tokens, window, settings]) => ({
			tokens,
			window,
			settings,
			result: shouldCompact(tokens as number, window as number, settings as typeof DEFAULT_COMPACTION_SETTINGS),
		})),
		lastAssistantUsage: Object.entries(PATHS).map(([name, entries]) => ({
			path: name,
			usage: getLastAssistantUsage(entries) ?? "<undefined>",
		})),
		projected: projectedPaths.map((name) => ({
			path: name,
			estimate: estimateProjectedContextTokens(buildSessionProjection(PATHS[name]), PATHS[name]),
		})),
	});
}

function prepareJson(): string {
	return json({
		paths: PATHS,
		cuts: CUT_CASES.map((testCase) => {
			const entries = PATHS[testCase.path];
			const end = testCase.end ?? entries.length;
			return {
				...testCase,
				result: findCutPoint(entries, testCase.start, end, testCase.keep),
				turnStarts: entries.map((_, index) => findTurnStartIndex(entries, index, testCase.start)),
			};
		}),
		preparations: PREPARE_CASES.map((testCase) => ({
			...testCase,
			preparation: preparationJson(
				prepareCompaction(PATHS[testCase.path], {
					...DEFAULT_COMPACTION_SETTINGS,
					keepRecentTokens: testCase.keepRecentTokens,
				}),
			),
		})),
	});
}

const SERIALIZED: unknown[][] = [
	[user("plain question"), user([text("block one"), image, text("block two")]), user([image])],
	[
		assistant([
			{ type: "thinking", thinking: "first thought" },
			text("visible answer"),
			{ type: "thinking", thinking: "second thought" },
			toolCall("bash", { command: "ls", options: { all: true, depth: 2 }, list: [1, "two"] }),
			toolCall("read", {}, "call-2"),
		]),
		assistant([toolCall("write", { path: "a.txt", content: 'quote " and \\ backslash' })]),
		assistant([{ type: "thinking", thinking: "only thinking" }]),
		assistant([]),
	],
	[
		toolResult([text("short result")]),
		toolResult([text("y".repeat(2500))]),
		toolResult([image]),
		toolResult([text("🙂".repeat(1500))]),
	],
	[
		{
			role: "bashExecution",
			command: "npm test",
			output: "all good",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		},
		{
			role: "bashExecution",
			command: "make",
			output: "",
			exitCode: 2,
			cancelled: false,
			truncated: true,
			fullOutputPath: "/tmp/out.log",
			timestamp: 1,
		},
		{
			role: "bashExecution",
			command: "sleep",
			output: "partial",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
			timestamp: 1,
		},
		{
			role: "bashExecution",
			command: "hidden",
			output: "x",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: 1,
		},
		{ role: "custom", customType: "note", content: "custom string", display: true, timestamp: 1 },
		{ role: "custom", customType: "note", content: [text("custom block")], display: false, timestamp: 1 },
		{ role: "branchSummary", summary: "what the branch did", fromId: "x", timestamp: 1 },
		{ role: "compactionSummary", summary: "what came before", tokensBefore: 5, timestamp: 1 },
		{ role: "system", content: "system prompt", timestamp: 0 },
	],
];

function serializeJson(): string {
	const fileOpCases = [
		[
			assistant([
				toolCall("read", { path: "b.ts" }),
				toolCall("read", { path: "a.ts" }),
				toolCall("edit", { path: "a.ts" }),
			]),
		],
		[
			assistant([
				toolCall("write", { path: "z.ts" }),
				toolCall("bash", { path: "ignored" }),
				toolCall("read", { path: "" }),
			]),
			toolResult([], { nestedCalls: { calls: [{ name: "edit", arguments: { path: "n.ts" } }, { name: "read" }] } }),
			user("not a tool call"),
		],
		[],
	];
	return json({
		conversations: SERIALIZED.map((messages) => ({
			messages,
			llm: convertToLlm(messages as AgentMessage[]),
			text: serializeConversation(convertToLlm(messages as AgentMessage[])),
		})),
		fileOperations: fileOpCases.map((messages) => {
			const fileOps = createFileOps();
			for (const message of messages) extractFileOpsFromMessage(message as AgentMessage, fileOps);
			const lists = computeFileLists(fileOps);
			return { messages, lists, text: formatFileOperations(lists.readFiles, lists.modifiedFiles) };
		}),
	});
}

const baseModel = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
} as unknown as Model<string>;

/** A scripted response: assistant content and stop reason. */
interface Script {
	content?: unknown[];
	stopReason?: string;
	errorMessage?: string;
	usage?: Usage;
}

function response(script: Script): AssistantMessage {
	return {
		...(assistant(script.content ?? [text("SUMMARY")], {
			stopReason: script.stopReason ?? "stop",
			usage: script.usage ?? usage(30, 20, 10),
		}) as unknown as AssistantMessage),
		...(script.errorMessage ? { errorMessage: script.errorMessage } : {}),
	};
}

interface CompactCase {
	name: string;
	path: string;
	keepRecentTokens: number;
	reserveTokens?: number;
	model?: Partial<Model<string>>;
	apiKey?: string;
	headers?: Record<string, string>;
	customInstructions?: string;
	thinkingLevel?: string;
	sessionId?: string;
	retry?: RetryPolicy;
	abortBefore?: boolean;
	responses: Script[];
}

const COMPACT_CASES: CompactCase[] = [
	{
		name: "history summary",
		path: "simple",
		keepRecentTokens: 150,
		apiKey: "key",
		headers: { "x-test": "1" },
		responses: [{}],
	},
	{
		name: "split turn",
		path: "split turn",
		keepRecentTokens: 300,
		thinkingLevel: "high",
		sessionId: "session-1",
		responses: [
			{ content: [text("HISTORY")] },
			{ content: [text("PREFIX"), { type: "thinking", thinking: "hidden" }], usage: usage(5, 3, 2) },
		],
	},
	{
		name: "split turn with a longer prefix",
		path: "split turn",
		keepRecentTokens: 150,
		responses: [{ content: [text("HISTORY")] }, {}],
	},
	{
		name: "split turn without earlier history",
		path: "metadata before the cut",
		keepRecentTokens: 150,
		responses: [{ content: [text("PREFIX ONLY")] }],
	},
	{ name: "an omitted attempt split off", path: "omitted recovery attempt", keepRecentTokens: 200, responses: [{}] },
	{
		name: "update with instructions",
		path: "previous compaction",
		keepRecentTokens: 100,
		customInstructions: "Focus on tests.",
		thinkingLevel: "off",
		responses: [{ content: [text("UPDATED"), text("TWICE")] }],
	},
	{
		name: "no reasoning and no output cap",
		path: "simple",
		keepRecentTokens: 150,
		reserveTokens: 1001,
		thinkingLevel: "medium",
		model: { reasoning: false, maxTokens: 0 },
		responses: [{}],
	},
	{
		name: "split turn budgets",
		path: "split turn",
		keepRecentTokens: 300,
		reserveTokens: 1001,
		model: { maxTokens: 0 },
		responses: [{}, {}],
	},
	{
		name: "an error",
		path: "simple",
		keepRecentTokens: 150,
		responses: [{ stopReason: "error", errorMessage: "boom" }],
	},
	{ name: "an error without a message", path: "simple", keepRecentTokens: 150, responses: [{ stopReason: "error" }] },
	{ name: "the token cap", path: "simple", keepRecentTokens: 150, responses: [{ stopReason: "length" }] },
	{
		name: "a tool call",
		path: "simple",
		keepRecentTokens: 150,
		responses: [{ content: [toolCall("read", { path: "x" })] }],
	},
	{
		name: "a turn prefix error",
		path: "split turn",
		keepRecentTokens: 300,
		responses: [{}, { stopReason: "error", errorMessage: "prefix failed" }],
	},
	{
		name: "a transient error retried",
		path: "simple",
		keepRecentTokens: 150,
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
		responses: [{ stopReason: "error", errorMessage: "529 overloaded" }, {}],
	},
	{
		name: "a quota error not retried",
		path: "simple",
		keepRecentTokens: 150,
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
		responses: [{ stopReason: "error", errorMessage: "429 insufficient_quota" }, {}],
	},
	{
		name: "an abort during the backoff",
		path: "simple",
		keepRecentTokens: 150,
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
		abortBefore: true,
		responses: [{ content: [text("partial")], stopReason: "error", errorMessage: "connection error" }],
	},
];

async function compactJson(): Promise<string> {
	const results: unknown[] = [];
	for (const testCase of COMPACT_CASES) {
		const preparation = prepareCompaction(PATHS[testCase.path], {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: testCase.keepRecentTokens,
			...(testCase.reserveTokens !== undefined ? { reserveTokens: testCase.reserveTokens } : {}),
		});
		if (!preparation) throw new Error(`no preparation for ${testCase.name}`);
		const requests: unknown[] = [];
		const scripted = [...testCase.responses];
		const streamFn = async (
			model: Model<string>,
			context: { messages: unknown[] },
			options: Record<string, unknown>,
		) => {
			const { signal: _signal, ...rest } = options;
			requests.push(JSON.parse(JSON.stringify({ model: model.id, messages: context.messages, options: rest })));
			const script = scripted.shift() ?? {};
			return { result: async () => response(script) };
		};
		const controller = new AbortController();
		if (testCase.abortBefore) controller.abort();
		const callbacks: unknown[] = [];
		let outcome: Record<string, unknown>;
		try {
			const result = await compact(
				preparation,
				{ ...baseModel, ...testCase.model } as Model<string>,
				testCase.apiKey,
				testCase.headers,
				testCase.customInstructions,
				controller.signal,
				testCase.thinkingLevel as never,
				streamFn as never,
				undefined,
				testCase.retry,
				{
					onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
						callbacks.push({ scheduled: { attempt, maxAttempts, delayMs, errorMessage } });
					},
					onRetryAttemptStart: () => {
						callbacks.push("attemptStart");
					},
					onRetryFinished: (success, attempt, finalError) => {
						callbacks.push({
							finished: { success, attempt, ...(finalError !== undefined ? { finalError } : {}) },
						});
					},
				},
				testCase.sessionId,
			);
			outcome = { result: JSON.parse(JSON.stringify(result)) };
		} catch (error) {
			outcome = { error: error instanceof Error ? error.message : String(error) };
		}
		results.push(normalizeRequests({ ...testCase, requests, callbacks, ...outcome }));
	}
	return json(results);
}

/** Generated session ids become `<uuid7>`, and the summary request's time 0. */
function normalizeRequests(value: unknown, key?: string): unknown {
	if (typeof value === "string") {
		return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, "<uuid7>");
	}
	if (typeof value === "number") return key === "timestamp" && value > 1_000_000_000_000 ? 0 : value;
	if (Array.isArray(value)) return value.map((item) => normalizeRequests(item));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalizeRequests(item, name)]));
	}
	return value;
}

const RETRYABLE_TEXTS = [
	"529 overloaded",
	"Rate limit reached",
	"rate-limit hit",
	"Too Many Requests",
	"HTTP 503 Service Unavailable",
	"fetch failed",
	"socket hang up",
	"Request timed out",
	"request time out",
	"stream ended before message_stop",
	"Provider returned error",
	"ResourceExhausted",
	"429 insufficient_quota",
	"Monthly usage limit reached",
	"billing problem",
	"invalid api key",
	"",
];

async function retryJson(): Promise<string> {
	const classify = RETRYABLE_TEXTS.map((errorMessage) => ({
		errorMessage,
		retryable: isRetryableAssistantError(response({ stopReason: "error", errorMessage: errorMessage || undefined })),
	}));
	classify.push({
		errorMessage: "overloaded but stopped",
		retryable: isRetryableAssistantError(response({ stopReason: "stop", errorMessage: "overloaded" })),
	});
	const delays = [
		[{ baseDelayMs: 2000 }, 1],
		[{ baseDelayMs: 2000 }, 2],
		[{ baseDelayMs: 2000 }, 3],
		[{ baseDelayMs: 2000 }, 0],
		[{ baseDelayMs: 2000, maxAgentDelayMs: 5000 }, 3],
		[{ baseDelayMs: 2000 }, 2000],
		[{ baseDelayMs: 0.5, maxAgentDelayMs: 1e300 }, 1],
	].map(([policy, attempt]) => ({ policy, attempt, delay: retryDelayMs(policy as RetryPolicy, attempt as number) }));
	const sequences: { name: string; policy?: RetryPolicy; abortBefore?: boolean; responses: Script[] }[] = [
		{ name: "no policy", responses: [{ stopReason: "error", errorMessage: "overloaded" }] },
		{
			name: "disabled",
			policy: { enabled: false, maxRetries: 3, baseDelayMs: 0 },
			responses: [{ stopReason: "error", errorMessage: "overloaded" }],
		},
		{ name: "success at once", policy: { enabled: true, maxRetries: 3, baseDelayMs: 0 }, responses: [{}] },
		{
			name: "two retries then success",
			policy: { enabled: true, maxRetries: 3, baseDelayMs: 0 },
			responses: [
				{ stopReason: "error", errorMessage: "overloaded" },
				{ stopReason: "error", errorMessage: "fetch failed" },
				{},
			],
		},
		{
			name: "retries exhausted",
			policy: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			responses: [
				{ stopReason: "error", errorMessage: "overloaded" },
				{ stopReason: "error", errorMessage: "still overloaded" },
			],
		},
		{
			name: "aborted after a retry",
			policy: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			responses: [{ stopReason: "error", errorMessage: "overloaded" }, { stopReason: "aborted" }],
		},
		{
			name: "deterministic error after a retry",
			policy: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			responses: [
				{ stopReason: "error", errorMessage: "overloaded" },
				{ stopReason: "error", errorMessage: "invalid request" },
			],
		},
		{
			name: "aborted at once",
			policy: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			responses: [{ stopReason: "aborted" }],
		},
		{
			name: "aborted during the backoff",
			policy: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			abortBefore: true,
			responses: [{ stopReason: "error", errorMessage: "overloaded" }],
		},
	];
	const runs: unknown[] = [];
	for (const sequence of sequences) {
		const scripted = [...sequence.responses];
		const log: unknown[] = [];
		let calls = 0;
		const controller = new AbortController();
		if (sequence.abortBefore) controller.abort();
		const result = await retryAssistantCall(
			async () => {
				calls++;
				return response(scripted.shift() ?? {});
			},
			sequence.policy,
			controller.signal,
			{
				onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
					log.push({ scheduled: { attempt, maxAttempts, delayMs, errorMessage } });
				},
				onRetryAttemptStart: () => {
					log.push("attemptStart");
				},
				onRetryFinished: (success, attempt, finalError) => {
					log.push({ finished: { success, attempt, ...(finalError !== undefined ? { finalError } : {}) } });
				},
			},
		);
		runs.push({
			...sequence,
			calls,
			callbacks: log,
			result: { stopReason: result.stopReason, errorMessage: result.errorMessage ?? null },
		});
	}
	return json({ classify, delays, runs });
}

export async function compactionFiles(): Promise<Record<string, string>> {
	return {
		"estimate.json": estimateJson(),
		"prepare.json": prepareJson(),
		"serialize.json": serializeJson(),
		"compact.json": await compactJson(),
		"retry.json": await retryJson(),
	};
}

export function readCompactionFile(name: string): string {
	return readFileSync(join(COMPACTION_DIR, name), "utf8");
}
