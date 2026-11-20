/**
 * Reference behavior of the session manager (`src/core/session-manager.ts`), for the Rust port:
 *
 * - `session/dates.json`: `new Date(text).getTime()` for the timestamp forms session files hold.
 * - `session/files.json`: handcrafted session files opened with `SessionManager.open`: the file
 *   after opening (migrated, repaired), the entries, the tree, and the context projection at
 *   every leaf.
 * - `session/operations.json`: scripted `SessionManager` calls, in memory and persisted: each
 *   call's result, then the entries, the tree, the projection and the file.
 * - `session/listing.json`: `list`, `findById`, `findMostRecentSession`, `continueRecent` and
 *   `forkFrom` over a directory of sessions with fixed modification times.
 *
 * Generated values become placeholders: entry ids `#N` and session ids `<session-N>` in order of
 * first appearance, the session directory `<root>`, the process's directory `<cwd>`, and, where
 * calls create entries, times taken
 * while they ran `<time>` (strings) or 0 (numbers). Files are recorded as their parsed lines.
 *
 * An entry that is its own parent makes the TypeScript path walk loop until the array overflows,
 * so no case has one.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildSessionProjection,
	findMostRecentSession,
	SessionManager,
	type SessionTreeNode,
} from "../../src/core/session-manager.ts";

export const SESSION_DIR = fileURLToPath(new URL("../../../../crates/fixtures/session/", import.meta.url));

const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

const DATE_TEXTS = [
	"2026-11-20T10:41:18.123Z",
	"2026-11-20T10:41:18Z",
	"2026-11-20T10:41Z",
	"2026-11-20T10:41:18.1Z",
	"2026-11-20T10:41:18.123456Z",
	"2026-11-20T10:41:18.123+02:00",
	"2026-11-20T10:41:18-05:30",
	"2026-11-20",
	"2026-11",
	"2026",
	"+012026-11-20T10:41:18.000Z",
	"-000001-01-01T00:00:00.000Z",
	"1970-01-01T00:00:00.000Z",
	"1969-12-31T23:59:59.999Z",
	"2024-02-29T00:00:00.000Z",
	"2026-11-20T24:00:00.000Z",
	"2026-13-01T00:00:00.000Z",
	"2026-11-31T00:00:00.000Z",
	"2026-11-32T00:00:00.000Z",
	"2026-11-00T00:00:00.000Z",
	"2026-00-10T00:00:00.000Z",
	"2026-11-20T10:60:00.000Z",
	"2026-11-20 10:41:18Z",
	"",
	"not a date",
	"2026-11-20T10:41:18.123ZZ",
];

/** A user message as the agent stores it. */
const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
const assistant = (text: string, timestamp: number, model = "claude-test") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "anthropic",
	model,
	usage: {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp,
});
const system = (content: string, timestamp: number, extra: Record<string, unknown> = {}) => ({
	role: "system",
	content,
	...extra,
	timestamp,
});
const toolResult = (text: string, timestamp: number) => ({
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp,
});

const header = (extra: Record<string, unknown> = {}) => ({
	type: "session",
	version: 3,
	id: "s-fixed",
	timestamp: "2026-11-01T09:00:00.000Z",
	cwd: "<root>/project",
	...extra,
});
const entry = (type: string, id: string, parentId: string | null, minute: number, fields: Record<string, unknown>) => ({
	type,
	id,
	parentId,
	timestamp: `2026-11-01T09:${String(minute).padStart(2, "0")}:00.000Z`,
	...fields,
});
const lines = (...values: unknown[]) => `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;

interface FileCase {
	name: string;
	text?: string;
	/** Bytes in base64, for files that are not valid UTF-8. */
	base64?: string;
}

const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }];

const FILE_CASES: FileCase[] = [
	{
		name: "linear v3",
		text: lines(
			header(),
			entry("message", "a1", null, 1, { message: system("You are a test agent.", 100, { toolsAdded: tools }) }),
			entry("message", "a2", "a1", 2, { message: user("hello", 200) }),
			entry("message", "a3", "a2", 3, { message: assistant("hi there", 300) }),
			entry("thinking_level_change", "a4", "a3", 4, { thinkingLevel: "high" }),
			entry("model_change", "a5", "a4", 5, { provider: "openai", modelId: "gpt-test" }),
			entry("message", "a6", "a5", 6, { message: toolResult("file text", 600) }),
		),
	},
	{
		name: "version 1",
		text: lines(
			{ type: "session", id: "s-old", timestamp: "2025-01-01T00:00:00.000Z", cwd: "<root>/old" },
			{ type: "message", timestamp: "2025-01-01T00:01:00.000Z", message: user("first", 1) },
			{ type: "message", timestamp: "2025-01-01T00:02:00.000Z", message: assistant("second", 2) },
			{ type: "message", timestamp: "2025-01-01T00:03:00.000Z", message: user("third", 3) },
			{
				type: "compaction",
				timestamp: "2025-01-01T00:04:00.000Z",
				summary: "the first two",
				firstKeptEntryIndex: 3,
				tokensBefore: 1234,
			},
			{
				type: "message",
				timestamp: "2025-01-01T00:05:00.000Z",
				message: { role: "hookMessage", customType: "note", content: "from a hook", display: true, timestamp: 5 },
			},
		),
	},
	{
		name: "version 2 hook message",
		text: lines(
			header({ version: 2 }),
			entry("message", "b1", null, 1, { message: user("hi", 1) }),
			entry("message", "b2", "b1", 2, {
				message: { role: "hookMessage", customType: "note", content: "hooked", display: false, timestamp: 2 },
			}),
		),
	},
	{
		name: "branches",
		text: lines(
			header(),
			entry("message", "c1", null, 1, { message: user("root question", 1) }),
			entry("message", "c2", "c1", 2, { message: assistant("first answer", 2) }),
			entry("message", "c3", "c2", 3, { message: user("follow-up", 3) }),
			entry("model_change", "c4", "c1", 4, { provider: "google", modelId: "gemini-test" }),
			entry("message", "c5", "c4", 5, { message: assistant("second answer", 5, "gemini-test") }),
			entry("thinking_level_change", "c6", "c2", 6, { thinkingLevel: "low" }),
		),
	},
	{
		name: "compactions",
		text: lines(
			header(),
			entry("message", "d1", null, 1, { message: system("Base prompt.", 10) }),
			entry("message", "d2", "d1", 2, { message: user("one", 20) }),
			entry("message", "d3", "d2", 3, { message: assistant("two", 30) }),
			entry("message", "d4", "d3", 4, { message: system("Later prompt.", 40, { sections: { rules: "be brief" } }) }),
			entry("message", "d5", "d4", 5, { message: user("three", 50) }),
			entry("compaction", "d6", "d5", 6, {
				summary: "first summary",
				firstKeptEntryId: "d3",
				tokensBefore: 500,
				systemMessage: system("Base prompt.\n\nLater prompt.", 1000),
			}),
			entry("message", "d7", "d6", 7, { message: assistant("four", 70) }),
			entry("compaction", "d8", "d7", 8, {
				summary: "second summary",
				firstKeptEntryId: "d6",
				tokensBefore: 900,
				details: { kept: true },
				fromHook: true,
			}),
			entry("message", "d9", "d8", 9, { message: user("five", 90) }),
			entry("compaction", "d10", "d9", 10, {
				summary: "self kept",
				firstKeptEntryId: "d10",
				tokensBefore: 100,
			}),
		),
	},
	{
		name: "context edits",
		text: lines(
			header(),
			entry("message", "e1", null, 1, { message: user("original question", 1) }),
			entry("message", "e2", "e1", 2, { message: assistant("original answer", 2) }),
			entry("message", "e3", "e2", 3, { message: toolResult("tool output", 3) }),
			entry("custom_message", "e4", "e3", 4, { customType: "note", content: "a note", display: true }),
			entry("context_edit", "e5", "e4", 5, { targetId: "e2", replacement: { content: "edited answer" } }),
			entry("context_edit", "e6", "e5", 6, { targetId: "e1", replacement: { content: "edited question" } }),
			entry("context_edit", "e7", "e6", 7, { targetId: "e3", replacement: null }),
			entry("context_edit", "e8", "e7", 8, {
				targetId: "e4",
				replacement: { content: [{ type: "text", text: "edited note" }] },
			}),
			entry("context_edit", "e9", "e8", 9, { targetId: "e2", replacement: { content: "edited twice" } }),
		),
	},
	{
		name: "other entries",
		text: lines(
			header({ parentSession: "/sessions/parent.jsonl" }),
			entry("message", "f1", null, 1, { message: user("hello", 1) }),
			entry("custom", "f2", "f1", 2, { customType: "state", data: { count: 2 } }),
			entry("custom_message", "f3", "f2", 3, {
				customType: "reminder",
				content: [{ type: "text", text: "remember" }],
				display: false,
				details: { source: "test" },
			}),
			entry("branch_summary", "f4", "f3", 4, { fromId: "f9", summary: "the abandoned branch" }),
			entry("branch_summary", "f5", "f4", 5, { fromId: "f9", summary: "" }),
			entry("label", "f6", "f5", 6, { targetId: "f1", label: "start" }),
			entry("label", "f7", "f6", 7, { targetId: "f3", label: "reminder" }),
			entry("label", "f8", "f7", 8, { targetId: "f3" }),
			entry("session_info", "f9", "f8", 9, { name: "  First name  " }),
			entry("usage", "f10", "f9", 10, {
				kind: "cache_warm",
				provider: "anthropic",
				model: "claude-test",
				usage: assistant("", 0).usage,
			}),
			entry("session_info", "f11", "f10", 11, { name: "Final name" }),
			entry("message", "f12", "f11", 12, {
				message: {
					role: "bashExecution",
					command: "ls",
					output: "a\nb",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 12,
				},
			}),
		),
	},
	{
		name: "cleared name",
		text: lines(
			header(),
			entry("session_info", "g1", null, 1, { name: "Named" }),
			entry("session_info", "g2", "g1", 2, { name: "   " }),
		),
	},
	{
		name: "missing content",
		text: lines(
			header(),
			entry("message", "h1", null, 1, { message: { role: "system", content: null, timestamp: 1 } }),
			entry("message", "h2", "h1", 2, { message: { role: "user", timestamp: 2 } }),
			entry("message", "h3", "h2", 3, { message: { ...assistant("", 3), content: null } }),
			entry("custom_message", "h4", "h3", 4, { customType: "empty", display: true }),
		),
	},
	{
		name: "malformed lines without a final newline",
		text: `${JSON.stringify(header())}\n\n   \n{not json}\n${JSON.stringify(
			entry("message", "i1", null, 1, { message: user("kept", 1) }),
		)}\r\n${JSON.stringify(entry("message", "i2", "i1", 2, { message: assistant("last", 2) }))}`,
	},
	{
		name: "invalid utf-8",
		base64: Buffer.concat([
			Buffer.from(
				`${JSON.stringify(header())}\n{"type":"message","id":"j1","parentId":null,"timestamp":"2026-11-01T09:01:00.000Z","message":{"role":"user","content":"bad `,
			),
			Buffer.from([0xff, 0xc3, 0x28]),
			Buffer.from(` bytes","timestamp":1}}\n`),
		]).toString("base64"),
	},
	{
		name: "orphans",
		text: lines(
			header(),
			entry("message", "k1", null, 1, { message: user("root", 1) }),
			entry("message", "k2", "missing", 2, { message: user("orphan", 2) }),
			entry("message", "k5", "k1", 5, { message: assistant("later child", 5) }),
			entry("message", "k4", "k1", 4, { message: assistant("earlier child", 4) }),
		),
	},
	{ name: "header only", text: lines(header()) },
	{ name: "empty file", text: "" },
	{ name: "not a session", text: lines({ type: "message", id: "x", parentId: null, message: user("x", 1) }) },
	{ name: "header not first", text: lines(entry("message", "x", null, 1, { message: user("x", 1) }), header()) },
	{ name: "header without id", text: lines({ type: "session", version: 3, timestamp: "2026-11-01T09:00:00.000Z" }) },
];

const isTimeKey = (key: string | undefined) => key === "timestamp" || key === "labelTimestamp";

/** `bytes` with every `from` replaced by `to`, for files that are not valid UTF-8. */
function replaceBytes(bytes: Buffer, from: Buffer, to: Buffer): Buffer {
	const parts: Buffer[] = [];
	let start = 0;
	for (let at = bytes.indexOf(from); at !== -1; at = bytes.indexOf(from, start)) {
		parts.push(bytes.subarray(start, at), to);
		start = at + from.length;
	}
	parts.push(bytes.subarray(start));
	return Buffer.concat(parts);
}

/** Placeholders for generated values, numbered in order of first appearance. */
class Normalizer {
	private readonly entryIds = new Map<string, string>();
	private readonly sessionIds = new Map<string, string>();
	private readonly root: string;
	private readonly fixedIds: Set<string>;
	private readonly window: [number, number] | undefined;

	constructor(root: string, fixedIds: Set<string>, window?: [number, number]) {
		this.root = root;
		this.fixedIds = fixedIds;
		this.window = window;
	}

	private isTime(value: number): boolean {
		return this.window !== undefined && value >= this.window[0] && value <= this.window[1];
	}

	private text(value: string, key?: string): string {
		if (this.window && isTimeKey(key) && /^\d{4}-\d\d-\d\dT/.test(value)) {
			const time = new Date(value).getTime();
			if (this.isTime(time)) return "<time>";
		}
		if (/^[0-9a-f]{8}$/.test(value) && !this.fixedIds.has(value)) {
			if (!this.entryIds.has(value)) this.entryIds.set(value, `#${this.entryIds.size + 1}`);
			return this.entryIds.get(value)!;
		}
		// A file without a header takes the process's working directory.
		let text = value.split(this.root).join("<root>").split(process.cwd()).join("<cwd>");
		text = text.replace(/<(?:root|cwd)>[^'\s\]"]*/g, (path) => path.replaceAll("\\", "/"));
		text = text.replace(/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_/g, "<stamp>_");
		text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, (id) => {
			if (!this.sessionIds.has(id)) this.sessionIds.set(id, `<session-${this.sessionIds.size + 1}>`);
			return this.sessionIds.get(id)!;
		});
		// Entry ids inside messages, such as errors naming an entry.
		return text.replace(/\b[0-9a-f]{8}\b/g, (id) => {
			if (this.fixedIds.has(id)) return id;
			if (!this.entryIds.has(id)) this.entryIds.set(id, `#${this.entryIds.size + 1}`);
			return this.entryIds.get(id)!;
		});
	}

	walk(value: unknown, key?: string): unknown {
		if (typeof value === "string") return this.text(value, key);
		if (typeof value === "number") return isTimeKey(key) && this.isTime(value) ? 0 : value;
		if (Array.isArray(value)) return value.map((item) => this.walk(item));
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.walk(item, name)]));
		}
		return value;
	}
}

function tree(nodes: SessionTreeNode[]): unknown[] {
	return nodes.map((node) => ({
		id: node.entry.id,
		...(node.label !== undefined ? { label: node.label } : {}),
		...(node.labelTimestamp !== undefined ? { labelTimestamp: node.labelTimestamp } : {}),
		children: tree(node.children),
	}));
}

/** The projection at a leaf; `<default>` is the last entry. */
function projection(manager: SessionManager, leafId: string | null | undefined) {
	const result = buildSessionProjection(manager.getEntries(), leafId);
	return JSON.parse(
		JSON.stringify({
			leafId: leafId === undefined ? "<default>" : leafId,
			entryIds: result.entries.map((projected) => projected.sourceEntry.id),
			messages: result.messages,
			thinkingLevel: result.thinkingLevel,
			model: result.model,
		}),
	);
}

function fileLines(path: string | undefined): unknown {
	if (!path || !existsSync(path)) return "<absent>";
	const text = readFileSync(path, "utf8");
	return {
		lines: text.split("\n").map((line) => {
			if (!line) return "";
			try {
				return JSON.parse(line);
			} catch {
				return { unparsed: line };
			}
		}),
	};
}

function state(manager: SessionManager) {
	return {
		header: manager.getHeader(),
		leafId: manager.getLeafId(),
		sessionName: manager.getSessionName() ?? null,
		entries: manager.getEntries(),
		tree: tree(manager.getTree()),
		context: manager.buildSessionContext(),
	};
}

function filesJson(): string {
	const root = mkdtempSync(join(tmpdir(), "relay-session-"));
	try {
		const results = FILE_CASES.map((testCase) => {
			const path = join(root, "case.jsonl");
			// `<root>` in a case is the temporary directory, as JSON writes it.
			const escapedRoot = JSON.stringify(root).slice(1, -1);
			const bytes =
				testCase.base64 !== undefined ? Buffer.from(testCase.base64, "base64") : Buffer.from(testCase.text ?? "");
			writeFileSync(path, replaceBytes(bytes, Buffer.from("<root>"), Buffer.from(escapedRoot)));
			const fixedIds = new Set<string>();
			for (const line of (testCase.text ?? "").split("\n")) {
				try {
					const value = JSON.parse(line) as { id?: string };
					if (value.id) fixedIds.add(value.id);
				} catch {}
			}
			const started = Date.now();
			let outcome: Record<string, unknown>;
			try {
				const manager = SessionManager.open(path, join(root, "sessions"));
				const leaves: (string | null | undefined)[] = [undefined, null, ...manager.getEntries().map((e) => e.id)];
				outcome = {
					...state(manager),
					cwd: manager.getCwd(),
					sessionId: manager.getSessionId(),
					file: fileLines(path),
					projections: leaves.map((leafId) => projection(manager, leafId)),
				};
			} catch (error) {
				outcome = { error: error instanceof Error ? error.message : String(error), file: fileLines(path) };
			}
			rmSync(path, { force: true });
			// An empty file gets a new header, written at this time.
			const normalizer = new Normalizer(root, fixedIds, [started - 1000, Date.now() + 1000]);
			return normalizer.walk({ ...testCase, ...JSON.parse(JSON.stringify(outcome)) });
		});
		return json(results);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** A scripted call; `$N` in a string argument is the result of call N. */
type Operation = Record<string, unknown> & { op: string };

interface OperationCase {
	name: string;
	persist: boolean;
	operations: Operation[];
}

const OPERATION_CASES: OperationCase[] = [
	{
		name: "a conversation",
		persist: true,
		operations: [
			{ op: "model", provider: "anthropic", modelId: "claude-test" },
			{ op: "thinking", level: "medium" },
			{ op: "message", message: system("System prompt.", 10, { toolsAdded: tools }) },
			{ op: "file" },
			{ op: "message", message: user("question", 20) },
			{ op: "file" },
			{ op: "message", message: assistant("answer", 30) },
			{
				op: "usage",
				kind: "cache_warm",
				provider: "anthropic",
				model: "claude-test",
				usage: assistant("", 0).usage,
			},
			{
				op: "usage",
				kind: "probe",
				provider: "anthropic",
				model: "claude-test",
				usage: assistant("", 0).usage,
				note: "a note",
			},
			{ op: "info", name: "  line one\r\nline two  " },
			{ op: "name" },
			{ op: "custom", customType: "state", data: { step: 1 } },
			{ op: "custom", customType: "empty" },
			{ op: "customMessage", customType: "reminder", content: "remember", display: true },
			{
				op: "customMessage",
				customType: "hidden",
				content: [{ type: "text", text: "x" }],
				display: false,
				details: { a: 1 },
			},
		],
	},
	{
		name: "setup entries alone are not written",
		persist: true,
		operations: [
			{ op: "model", provider: "anthropic", modelId: "claude-test" },
			{ op: "thinking", level: "off" },
			{ op: "custom", customType: "state" },
			{ op: "file" },
		],
	},
	{
		name: "labels and branches",
		persist: true,
		operations: [
			{ op: "message", message: user("one", 1) },
			{ op: "message", message: assistant("two", 2) },
			{ op: "label", target: "$0", label: "first" },
			{ op: "message", message: user("three", 3) },
			{ op: "label", target: "$1", label: "second" },
			{ op: "label", target: "$1" },
			{ op: "label", target: "$3", label: "" },
			{ op: "label", target: "missing", label: "x" },
			{ op: "getLabel", target: "$0" },
			{ op: "getLabel", target: "$1" },
			{ op: "branch", target: "$1" },
			{ op: "message", message: user("three again", 4) },
			{ op: "children", target: "$1" },
			{ op: "getBranch" },
			{ op: "getBranch", target: "$3" },
			{ op: "branch", target: "missing" },
			{ op: "resetLeaf" },
			{ op: "message", message: user("new root", 5) },
			{
				op: "branchWithSummary",
				target: "$0",
				summary: "left the second branch",
				details: { files: 1 },
				fromHook: false,
			},
			{ op: "branchWithSummary", target: null, summary: "from nothing" },
			{ op: "resetLeaf" },
			{ op: "branchWithSummary", target: "$0", summary: "from the root" },
			{ op: "branchWithSummary", target: "missing", summary: "x" },
		],
	},
	{
		name: "compaction keeps the system message",
		persist: false,
		operations: [
			{ op: "message", message: system("Prompt.", 10, { toolsAdded: tools }) },
			{ op: "message", message: user("one", 20) },
			{ op: "message", message: assistant("two", 30) },
			{ op: "message", message: system("More.", 40, { sections: { s: "v", t: "kept" } }) },
			{ op: "message", message: system("", 45, { sections: { s: "patched", t: null, u: "new" } }) },
			{
				op: "compaction",
				summary: "summary",
				firstKept: "$2",
				tokensBefore: 123,
				details: { d: 1 },
				fromHook: true,
			},
			{ op: "message", message: user("three", 50) },
			{ op: "compaction", summary: "keep all", firstKept: null, tokensBefore: 7 },
		],
	},
	{
		name: "compaction without a system message",
		persist: false,
		operations: [
			{ op: "message", message: user("one", 20) },
			{ op: "compaction", summary: "s", firstKept: "$0", tokensBefore: 1, usage: assistant("", 0).usage },
		],
	},
	{
		name: "context edits",
		persist: false,
		operations: [
			{ op: "message", message: user("question", 1) },
			{ op: "message", message: assistant("answer", 2) },
			{ op: "message", message: toolResult("output", 3) },
			{ op: "customMessage", customType: "note", content: "note", display: true },
			{ op: "thinking", level: "high" },
			{ op: "contextEdit", target: "$1", replacement: { content: "short answer" } },
			{ op: "contextEdit", target: "$0", replacement: { content: "short question" } },
			{ op: "contextEdit", target: "$2", replacement: null },
			{ op: "contextEdit", target: "$3", replacement: { content: [{ type: "text", text: "edited" }] } },
			{ op: "contextEdit", target: "$4", replacement: null },
			{ op: "contextEdit", target: "missing", replacement: null },
			{ op: "contextEdit", target: "$0", replacement: { content: 5 } },
			{ op: "contextEdit", target: "$0", replacement: {} },
			{ op: "contextEdit", target: "$0", replacement: "text" },
			{ op: "branch", target: "$0" },
			{ op: "contextEdit", target: "$1", replacement: null },
		],
	},
	{
		name: "branched session",
		persist: true,
		operations: [
			{ op: "message", message: user("one", 1) },
			{ op: "label", target: "$0", label: "start" },
			{ op: "message", message: assistant("two", 2) },
			{ op: "label", target: "$2", label: "reply" },
			{ op: "compaction", summary: "s", firstKept: "$1", tokensBefore: 3 },
			{ op: "message", message: user("three", 3) },
			{ op: "label", target: "$5", label: "other branch" },
			{ op: "createBranchedSession", target: "$5" },
			{ op: "createBranchedSession", target: "missing" },
		],
	},
	{
		name: "branched session in memory",
		persist: false,
		operations: [
			{ op: "message", message: user("one", 1) },
			{ op: "label", target: "$0", label: "start" },
			{ op: "message", message: assistant("two", 2) },
			{ op: "createBranchedSession", target: "$2" },
		],
	},
	{
		name: "branched session without a conversation",
		persist: true,
		operations: [
			{ op: "message", message: user("one", 1) },
			{ op: "branch", target: "$0" },
			{ op: "model", provider: "a", modelId: "b" },
			{ op: "createBranchedSession", target: "$2" },
		],
	},
	{
		name: "new sessions",
		persist: true,
		operations: [
			{ op: "message", message: user("one", 1) },
			{ op: "newSession", id: "custom-id.1", parentSession: "/parent.jsonl" },
			{ op: "message", message: user("two", 2) },
			{ op: "file" },
			{ op: "newSession", id: "-bad" },
			{ op: "newSession", id: "" },
			{ op: "newSession", id: "a" },
			{ op: "newSession" },
		],
	},
];

function resolveArgument(value: unknown, results: unknown[]): unknown {
	if (typeof value === "string" && /^\$\d+$/.test(value)) return results[Number(value.slice(1))];
	return value;
}

function runOperation(manager: SessionManager, operation: Operation, results: unknown[]): unknown {
	const arg = (name: string) => resolveArgument(operation[name], results);
	switch (operation.op) {
		case "message":
			return manager.appendMessage(operation.message as never);
		case "thinking":
			return manager.appendThinkingLevelChange(operation.level as string);
		case "model":
			return manager.appendModelChange(operation.provider as string, operation.modelId as string);
		case "usage":
			return manager.appendUsage(
				operation.kind as string,
				operation.provider as string,
				operation.model as string,
				operation.usage as never,
				operation.note as string | undefined,
			).id;
		case "compaction":
			return manager.appendCompaction(
				operation.summary as string,
				arg("firstKept") as string | null,
				operation.tokensBefore as number,
				operation.details,
				operation.fromHook as boolean | undefined,
				operation.usage as never,
			);
		case "custom":
			return manager.appendCustomEntry(operation.customType as string, operation.data);
		case "info":
			return manager.appendSessionInfo(operation.name as string);
		case "name":
			return manager.getSessionName() ?? null;
		case "customMessage":
			return manager.appendCustomMessageEntry(
				operation.customType as string,
				operation.content as never,
				operation.display as boolean,
				operation.details,
			);
		case "contextEdit":
			return manager.appendContextEdit(arg("target") as string, operation.replacement as never);
		case "label":
			return manager.appendLabelChange(arg("target") as string, operation.label as string | undefined);
		case "getLabel":
			return manager.getLabel(arg("target") as string) ?? null;
		case "branch":
			manager.branch(arg("target") as string);
			return null;
		case "resetLeaf":
			manager.resetLeaf();
			return null;
		case "branchWithSummary":
			return manager.branchWithSummary(
				arg("target") as string | null,
				operation.summary as string,
				operation.details,
				operation.fromHook as boolean | undefined,
			);
		case "createBranchedSession":
			return manager.createBranchedSession(arg("target") as string) ?? null;
		case "newSession":
			return (
				manager.newSession(
					operation.id !== undefined || operation.parentSession !== undefined
						? {
								id: operation.id as string | undefined,
								parentSession: operation.parentSession as string | undefined,
							}
						: undefined,
				) ?? null
			);
		case "children":
			return manager.getChildren(arg("target") as string).map((child) => child.id);
		case "getBranch":
			return manager.getBranch(arg("target") as string | undefined).map((item) => item.id);
		case "file":
			return fileLines(manager.getSessionFile());
		default:
			throw new Error(`unknown operation ${operation.op}`);
	}
}

function operationsJson(): string {
	const results = OPERATION_CASES.map((testCase) => {
		const root = mkdtempSync(join(tmpdir(), "relay-session-"));
		const started = Date.now();
		try {
			const cwd = join(root, "project");
			mkdirSync(cwd);
			const manager = testCase.persist
				? SessionManager.create(cwd, join(root, "sessions"))
				: SessionManager.inMemory(cwd);
			const outcomes: unknown[] = [];
			const values: unknown[] = [];
			for (const operation of testCase.operations) {
				try {
					const value = runOperation(manager, operation, values);
					values.push(value);
					outcomes.push({ result: JSON.parse(JSON.stringify(value ?? null)) });
				} catch (error) {
					values.push(undefined);
					outcomes.push({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			const recorded = {
				...testCase,
				outcomes,
				...JSON.parse(JSON.stringify(state(manager))),
				sessionFile: manager.getSessionFile() ?? null,
				file: fileLines(manager.getSessionFile()),
			};
			return new Normalizer(root, new Set(), [started - 1000, Date.now() + 1000]).walk(recorded);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	return json(results);
}

/** A session file for the listing, with its modification time in seconds. */
interface ListedFile {
	name: string;
	mtime: number;
	entries: unknown[];
	raw?: string;
}

function listingFiles(cwd: string, other: string): ListedFile[] {
	return [
		{
			name: "a.jsonl",
			mtime: 1_700_000_100,
			entries: [
				header({ id: "s-a", cwd, timestamp: "2026-10-01T00:00:00.000Z" }),
				entry("message", "l1", null, 1, { message: user("first question about a", Date.UTC(2026, 9, 1, 1)) }),
				entry("message", "l2", "l1", 2, { message: assistant("reply", Date.UTC(2026, 9, 1, 2)) }),
				entry("session_info", "l3", "l2", 3, { name: " Session A " }),
			],
		},
		{
			name: "b.jsonl",
			mtime: 1_700_000_300,
			entries: [
				header({ id: "s-b", cwd: other, timestamp: "2026-10-02T00:00:00.000Z" }),
				entry("message", "m1", null, 1, {
					message: { role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: 5 },
				}),
				entry("message", "m2", "m1", 2, {
					message: {
						role: "user",
						content: [
							{ type: "text", text: "two" },
							{ type: "text", text: "parts" },
						],
					},
				}),
			],
		},
		{
			name: "c.jsonl",
			mtime: 1_700_000_200,
			entries: [header({ id: "s-c", cwd, timestamp: "2026-10-03T00:00:00.000Z", parentSession: "/p.jsonl" })],
		},
		{ name: "d.jsonl", mtime: 1_700_000_400, entries: [], raw: "not a session\n" },
		{
			name: "f.jsonl",
			mtime: 1_700_000_150,
			entries: [
				header({ id: "s-f", cwd, timestamp: "2026-10-04T00:00:00.000Z" }),
				entry("message", "o1", null, 1, { message: assistant("assistant speaks first", 1) }),
				entry("message", "o2", "o1", 2, { message: user("then the user", 2) }),
				entry("message", "o3", "o2", 3, { message: system("not listed", 3) }),
			],
		},
		{ name: "notes.txt", mtime: 1_700_000_500, entries: [header({ id: "s-txt", cwd })] },
		{
			name: "e.jsonl",
			mtime: 1_700_000_050,
			entries: [header({ id: "s-e", cwd: "", timestamp: "bad time" }), entry("custom", "n1", null, 1, {})],
		},
	];
}

async function listingJson(): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "relay-session-"));
	const started = Date.now();
	try {
		const cwd = join(root, "project");
		const other = join(root, "other");
		mkdirSync(cwd);
		mkdirSync(other);
		const dir = join(root, "sessions");
		mkdirSync(dir);
		const files = listingFiles(cwd, other);
		for (const file of files) {
			const path = join(dir, file.name);
			writeFileSync(path, file.raw ?? lines(...file.entries));
			utimesSync(path, file.mtime, file.mtime);
		}
		const sessions = await SessionManager.list(cwd, dir);
		const recorded = {
			files,
			list: JSON.parse(JSON.stringify(sessions)),
			mostRecent: findMostRecentSession(dir),
			mostRecentForCwd: findMostRecentSession(dir, cwd),
			mostRecentMissingDir: findMostRecentSession(join(root, "missing")),
			findById: SessionManager.findById(cwd, "s-c", dir) ?? null,
			findOtherCwd: SessionManager.findById(cwd, "s-b", dir) ?? null,
			findMissing: SessionManager.findById(cwd, "nothing", dir) ?? null,
			continueRecent: SessionManager.continueRecent(cwd, dir).getSessionFile(),
			openWithCwd: SessionManager.open(join(dir, "a.jsonl"), undefined, other).getCwd(),
			openReadsCwd: SessionManager.open(join(dir, "b.jsonl")).getCwd(),
		};
		const forked = SessionManager.forkFrom(join(dir, "a.jsonl"), other, join(root, "forks"));
		const forkFile = forked.getSessionFile();
		const result = {
			...recorded,
			fork: { sessionFile: forkFile, file: fileLines(forkFile), entries: forked.getEntries() },
			forkEmpty: (() => {
				try {
					SessionManager.forkFrom(join(dir, "d.jsonl"), other, join(root, "forks"));
					return null;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			})(),
		};
		const fixedIds = new Set(files.flatMap((file) => file.entries.map((e) => (e as { id?: string }).id ?? "")));
		const window: [number, number] = [started - 1000, Date.now() + 1000];
		return json(new Normalizer(root, fixedIds, window).walk(JSON.parse(JSON.stringify(result))));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** An invalid date's NaN becomes null. */
function datesJson(): string {
	return json(DATE_TEXTS.map((text) => ({ text, time: new Date(text).getTime() })));
}

export async function sessionFiles(): Promise<Record<string, string>> {
	return {
		"dates.json": datesJson(),
		"files.json": filesJson(),
		"operations.json": operationsJson(),
		"listing.json": await listingJson(),
	};
}

export function readSessionFile(name: string): string {
	return readFileSync(join(SESSION_DIR, name), "utf8");
}
