/**
 * Reference outputs of the shell tools, for the Rust port:
 *
 * - `tools/output.json`: the output accumulator on chunked bytes with small limits: split
 *   characters, invalid bytes, BOMs and enough text to trim its tail. Each case has the snapshot
 *   after every chunk, the final snapshot, the output file's bytes and the full output at a few
 *   limits.
 * - `tools/bash.json`: the bash and powershell declarations, and what bash calls returned or threw,
 *   with their first and last updates.
 *
 * The output file's path becomes `<output>` and the tree's `<root>`. Strings over 2000 characters
 * become their length, FNV-1a hash and ends, so the file stays small.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { OutputAccumulator } from "../../src/core/tools/output-accumulator.ts";
import { createPowerShellToolDefinition } from "../../src/core/tools/powershell.ts";

/** FNV-1a over the UTF-8 bytes, as eight hexadecimal digits. */
function fnv(text: string): string {
	let hash = 0x811c9dc5;
	for (const byte of Buffer.from(text, "utf8")) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

const OUTPUT_PATH = new RegExp(
	`${tmpdir().replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}[\\\\/]relay-[a-z]+-[0-9a-f]{16}\\.log`,
	"g",
);

/** `<output>` for output file paths, `<root>` for the tree, and long strings summarized. */
function portable(value: unknown, root?: string): unknown {
	if (typeof value === "string") {
		let text = value.replace(OUTPUT_PATH, "<output>");
		if (root)
			text = text
				.split(root)
				.join("<root>")
				.replace(/<root>[^'\s\]]*/g, (path) => path.replaceAll("\\", "/"));
		if (text.length <= 2000) return text;
		const points = Array.from(text);
		return {
			long: text.length,
			fnv: fnv(text),
			start: points.slice(0, 80).join(""),
			end: points.slice(-80).join(""),
		};
	}
	if (Array.isArray(value)) return value.map((item) => portable(item, root));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item, root)]));
	}
	return value;
}

const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

interface AccumulatorCase {
	name: string;
	maxLines: number;
	maxBytes: number;
	chunks: number[][];
}

/** Seeded random byte streams cut at random points, often inside a character. */
function randomCases(count: number): AccumulatorCase[] {
	let seed = 20261119;
	const random = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const pieces: number[][] = [
		[0x61],
		[0x62],
		[0x0a],
		[0x0a],
		[0x0d, 0x0a],
		[...Buffer.from("é")],
		[...Buffer.from("日")],
		[...Buffer.from("🙂")],
		[0xff],
		[0xe6, 0x97],
		[0xef, 0xbb, 0xbf],
	];
	return Array.from({ length: count }, (_, index) => {
		const bytes: number[] = [];
		const length = Math.floor(random() * 120);
		for (let piece = 0; piece < length; piece++) bytes.push(...pieces[Math.floor(random() * pieces.length)]);
		const chunks: number[][] = [];
		let at = 0;
		while (at < bytes.length) {
			const size = 1 + Math.floor(random() * 40);
			chunks.push(bytes.slice(at, at + size));
			at += size;
		}
		if (random() < 0.2) chunks.splice(Math.floor(random() * (chunks.length + 1)), 0, []);
		return {
			name: `random ${index}`,
			maxLines: 1 + Math.floor(random() * 6),
			maxBytes: 4 + Math.floor(random() * 40),
			chunks,
		};
	});
}

function accumulatorCases(): AccumulatorCase[] {
	const text = (value: string) => [...Buffer.from(value)];
	return [
		{ name: "empty", maxLines: 3, maxBytes: 20, chunks: [] },
		{ name: "one line", maxLines: 3, maxBytes: 20, chunks: [text("hello\n")] },
		{ name: "no final newline", maxLines: 3, maxBytes: 20, chunks: [text("a\nb")] },
		{ name: "split character", maxLines: 3, maxBytes: 20, chunks: [[0xc3], [0xa9, 0x0a]] },
		{ name: "split four bytes", maxLines: 3, maxBytes: 20, chunks: [[0xf0, 0x9f], [0x99], [0x82]] },
		{ name: "incomplete at end", maxLines: 3, maxBytes: 20, chunks: [text("x"), [0xe6, 0x97]] },
		{ name: "invalid then text", maxLines: 3, maxBytes: 20, chunks: [[0xc3], text("A")] },
		{ name: "leading bom", maxLines: 3, maxBytes: 20, chunks: [[0xef, 0xbb, 0xbf], text("hi")] },
		{ name: "split bom", maxLines: 3, maxBytes: 20, chunks: [[0xef], [0xbb, 0xbf, 0x68]] },
		{ name: "second bom kept", maxLines: 3, maxBytes: 20, chunks: [text("a"), [0xef, 0xbb, 0xbf]] },
		{ name: "lines limit", maxLines: 3, maxBytes: 100, chunks: [text("1\n2\n3\n4\n5\n")] },
		{ name: "bytes limit", maxLines: 100, maxBytes: 10, chunks: [text("aaaa\nbbbb\ncccc\n")] },
		{ name: "long last line", maxLines: 100, maxBytes: 10, chunks: [text("x".repeat(25))] },
		{ name: "long line then newline", maxLines: 100, maxBytes: 10, chunks: [text(`${"x".repeat(25)}\n`)] },
		{ name: "raw bytes over the limit", maxLines: 100, maxBytes: 4, chunks: [[0xef, 0xbb, 0xbf, 0x61, 0x62]] },
		{
			name: "trimmed tail",
			maxLines: 2,
			maxBytes: 5,
			chunks: [text("0123456789\n0123456789\n"), text("abcdefghij\nklmnopqrst\nuv")],
		},
		{ name: "trim inside a character", maxLines: 50, maxBytes: 4, chunks: [text(`${"日".repeat(7)}\nok`)] },
		{ name: "full output head and tail", maxLines: 100, maxBytes: 100, chunks: [text(`é${"z".repeat(30)}日\n`)] },
		...randomCases(60),
	];
}

function accumulatorFile() {
	const cases = accumulatorCases().map((testCase) => {
		const output = new OutputAccumulator({
			maxLines: testCase.maxLines,
			maxBytes: testCase.maxBytes,
			tempFilePrefix: "relay-parity",
		});
		const snapshots = testCase.chunks.map((chunk) => {
			output.append(Buffer.from(chunk));
			return output.snapshot();
		});
		output.finish();
		const final = output.snapshot({ persistIfTruncated: true });
		return { testCase, output, snapshots, final };
	});
	return cases;
}

async function outputJson(): Promise<string> {
	const results: unknown[] = [];
	for (const { testCase, output, snapshots, final } of accumulatorFile()) {
		await output.closeTempFile();
		const fullOutputs = [];
		for (const maxBytes of [1, 7, 16, 1000])
			fullOutputs.push({ maxBytes, ...(await output.readFullOutput(maxBytes)) });
		const file = final.fullOutputPath ? readFileSync(final.fullOutputPath).toString("base64") : undefined;
		if (final.fullOutputPath) rmSync(final.fullOutputPath, { force: true });
		results.push(
			portable({
				...testCase,
				chunks: testCase.chunks.map((chunk) => Buffer.from(chunk).toString("base64")),
				snapshots,
				final,
				lastLineBytes: output.getLastLineBytes(),
				file,
				fullOutputs,
			}),
		);
	}
	return json(results);
}

type ShellDefinition = {
	name: string;
	description: string;
	parameters: unknown;
	constrainedSampling?: unknown;
	execute: (
		id: string,
		args: never,
		signal?: AbortSignal,
		onUpdate?: (update: unknown) => void,
		ctx?: never,
	) => Promise<unknown>;
};

/** A bash call: its arguments, and the tool options, session or abort it runs with. */
interface BashCall {
	name: string;
	args: { command: string; timeout?: number };
	/** Abort once an update's text contains this. */
	abortOn?: string;
	abortBefore?: boolean;
	tool?: "prefix" | "hook" | "missing cwd" | "hidden session";
	session?: {
		cwd?: string;
		sessionId: string;
		sessionFile?: string;
		model?: [string, string];
		thinkingLevel?: string;
	};
	/**
	 * Must end within this many seconds, well before the processes it starts: a call that waits
	 * for them, or does not kill them, answers the same, only later.
	 */
	withinSeconds?: number;
}

const SESSION_ECHO =
	'echo "[$RELAY_SESSION_ID|$RELAY_SESSION_FILE|$RELAY_PROVIDER|$RELAY_MODEL|$RELAY_REASONING_LEVEL]"';

const BASH_CALLS: BashCall[] = [
	{ name: "printf", args: { command: "printf hello" } },
	{ name: "echo", args: { command: "echo hello" } },
	{ name: "no output", args: { command: "true" } },
	{ name: "exit code", args: { command: "exit 3" } },
	{ name: "exit code over 255", args: { command: "exit 300" } },
	{ name: "stderr", args: { command: "echo oops >&2; exit 2" } },
	{ name: "crlf kept", args: { command: "printf 'a\\r\\nb\\n'" } },
	{ name: "invalid byte", args: { command: "printf 'a\\xffb'" } },
	{ name: "bom dropped", args: { command: "printf '\\xef\\xbb\\xbfhi'" } },
	{ name: "split character", args: { command: "printf '\\xc3'; sleep 0.2; printf '\\xa9'" } },
	{ name: "working directory", args: { command: "cat file.txt" } },
	{ name: "lines limit", args: { command: "printf 'line %s\\n' {1..3000}" } },
	{ name: "one long line", args: { command: "printf '%.0sa' {1..60000}" } },
	{ name: "bytes limit", args: { command: "printf '%.0s0123456789012345678901234567890123456789\\n' {1..1500}" } },
	{ name: "structured head and tail", args: { command: "printf 'abcdefghij%s\\n' {1..100000}" } },
	{ name: "timeout with output", args: { command: "echo before; sleep 30", timeout: 1.5 }, withinSeconds: 10 },
	{ name: "timeout without output", args: { command: "sleep 30", timeout: 0.5 }, withinSeconds: 10 },
	{ name: "abort", args: { command: "echo start; sleep 30" }, abortOn: "start", withinSeconds: 10 },
	{ name: "aborted before", args: { command: "echo never" }, abortBefore: true },
	{ name: "zero timeout", args: { command: "echo x", timeout: 0 } },
	{ name: "negative timeout", args: { command: "echo x", timeout: -1 } },
	{ name: "timeout over the maximum", args: { command: "echo x", timeout: 3000000 } },
	{ name: "background process", args: { command: "(sleep 3 &) ; echo done" }, withinSeconds: 2.5 },
	{ name: "parent session hidden", args: { command: SESSION_ECHO } },
	{
		name: "session",
		args: { command: SESSION_ECHO },
		session: {
			sessionId: "s1",
			sessionFile: "/sessions/s1.jsonl",
			model: ["anthropic", "m1"],
			thinkingLevel: "high",
		},
	},
	{ name: "session without a file or model", args: { command: SESSION_ECHO }, session: { sessionId: "s2" } },
	{
		name: "session not exposed",
		args: { command: SESSION_ECHO },
		tool: "hidden session",
		session: { sessionId: "s3", model: ["openai", "m2"] },
	},
	{ name: "session cwd", args: { command: "cat inner.txt" }, session: { cwd: "<root>/sub", sessionId: "s4" } },
	{ name: "command prefix", args: { command: 'echo "$GREETING"' }, tool: "prefix" },
	{ name: "spawn hook", args: { command: 'echo "$HOOKED"' }, tool: "hook" },
	{ name: "missing working directory", args: { command: "echo x" }, tool: "missing cwd" },
];

function bashTool(root: string, call: BashCall): ShellDefinition {
	switch (call.tool) {
		case "prefix":
			return createBashToolDefinition(root, { commandPrefix: "GREETING=hi" }) as unknown as ShellDefinition;
		case "hook":
			return createBashToolDefinition(root, {
				spawnHook: (context) => ({
					...context,
					command: `echo hooked; ${context.command}`,
					env: { ...context.env, HOOKED: "1" },
				}),
			}) as unknown as ShellDefinition;
		case "missing cwd":
			return createBashToolDefinition(join(root, "missing")) as unknown as ShellDefinition;
		case "hidden session":
			return createBashToolDefinition(root, { exposeSessionEnvironment: false }) as unknown as ShellDefinition;
		default:
			return createBashToolDefinition(root) as unknown as ShellDefinition;
	}
}

const shellDeclaration = (definition: ShellDefinition) =>
	JSON.parse(
		JSON.stringify({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			constrainedSampling: definition.constrainedSampling,
		}),
	);

/** The variable a command must not inherit from the agent's own session. */
const PARENT_MODEL = "parent-model";

async function bashJson(): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "relay-shell-tree-"));
	const previousModel = process.env.RELAY_MODEL;
	process.env.RELAY_MODEL = PARENT_MODEL;
	try {
		writeFileSync(join(root, "file.txt"), "in the root\n");
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "inner.txt"), "in sub\n");
		const calls: unknown[] = [];
		for (const call of BASH_CALLS) {
			const tool = bashTool(root, call);
			const controller = new AbortController();
			if (call.abortBefore) controller.abort();
			const updates: { content: { text?: string }[] }[] = [];
			const onUpdate = (update: unknown) => {
				updates.push(JSON.parse(JSON.stringify(update)));
				const text = (update as { content: { text?: string }[] }).content[0]?.text ?? "";
				if (call.abortOn && text.includes(call.abortOn)) controller.abort();
			};
			const session = call.session;
			const ctx = session
				? {
						cwd: session.cwd?.replace("<root>", root),
						sessionManager: { getSessionId: () => session.sessionId, getSessionFile: () => session.sessionFile },
						model: session.model ? { provider: session.model[0], id: session.model[1] } : undefined,
						thinkingLevel: session.thinkingLevel,
					}
				: undefined;
			const outcome: Record<string, unknown> = {};
			try {
				outcome.result = JSON.parse(
					JSON.stringify(
						await tool.execute("call", call.args as never, controller.signal, onUpdate, ctx as never),
					),
				);
			} catch (error) {
				outcome.error = error instanceof Error ? error.message : String(error);
			}
			const result = outcome.result as
				| { details?: { fullOutputPath?: string }; structuredContent?: { wall_time_seconds?: number } }
				| undefined;
			const path = result?.details?.fullOutputPath;
			let file: unknown;
			if (path && existsSync(path)) {
				file = readFileSync(path, "utf8");
				rmSync(path, { force: true });
			}
			if (result?.structuredContent) result.structuredContent.wall_time_seconds = 0;
			calls.push(portable({ ...call, ...outcome, firstUpdate: updates[0], lastUpdate: updates.at(-1), file }, root));
		}
		return json({
			declaration: shellDeclaration(createBashToolDefinition(root) as unknown as ShellDefinition),
			powershellDeclaration: shellDeclaration(createPowerShellToolDefinition(root) as unknown as ShellDefinition),
			calls,
		});
	} finally {
		if (previousModel === undefined) delete process.env.RELAY_MODEL;
		else process.env.RELAY_MODEL = previousModel;
		rmSync(root, { recursive: true, force: true });
	}
}

export async function shellFiles(): Promise<Record<string, string>> {
	return { "output.json": await outputJson(), "bash.json": await bashJson() };
}
