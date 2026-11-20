/**
 * Reference outputs of the file tools and their helpers, for the Rust port to match byte for
 * byte: the model reads them.
 *
 * - `tools/helpers.json`: `truncateHead`, `truncateTail`, `truncateMiddle`, `truncateLine`,
 *   `formatSize` and `detectSupportedImageMimeType` on fixed inputs.
 * - `tools/read.json`, `tools/ls.json`: each tool's declaration, the files of a fixture tree, and
 *   what each call returned or threw.
 * - `tools/edit.json`, `tools/write.json`: each tool's declaration, and for each call the files it
 *   starts from, what it returned or threw, and the files' bytes afterwards.
 * - `tools/diff.json`: jsdiff's `diffLines`, the edit tool's display diff and its unified patch on
 *   handcrafted and seeded random pairs of texts.
 * - `tools/grep.json`, `tools/find.json`: each tool's declaration, a search tree, and what each
 *   call returned or threw. ripgrep and fd search in parallel, so a call marked `sort` that can
 *   find several files is recorded with its lines sorted.
 *
 * The tree is written to a temporary directory; its path becomes `<root>` and the separators in
 * paths become `/`, so the files are the same on every platform.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffLines } from "diff";
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";
import { generateDiffString, generateUnifiedPatch } from "../../src/core/tools/edit-diff.ts";
import { createFindToolDefinition } from "../../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../../src/core/tools/ls.ts";
import { createReadToolDefinition } from "../../src/core/tools/read.ts";
import { formatSize, truncateHead, truncateLine, truncateMiddle, truncateTail } from "../../src/core/tools/truncate.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";
import { detectSupportedImageMimeType } from "../../src/utils/mime.ts";

export const TOOLS_DIR = fileURLToPath(new URL("../../../../crates/fixtures/tools/", import.meta.url));

/** A file of the fixture tree: text, or bytes in base64. A path ending in `/` is a directory. */
interface TreeEntry {
	path: string;
	text?: string;
	base64?: string;
}

const lines = (count: number, line: (index: number) => string) =>
	Array.from({ length: count }, (_, index) => line(index + 1)).join("\n");

function tree(): TreeEntry[] {
	const entries: TreeEntry[] = [
		{ path: "small.txt", text: "alpha\nbeta\ngamma\n" },
		{ path: "no-newline.txt", text: "one\ntwo" },
		{ path: "empty.txt", text: "" },
		{ path: "long.txt", text: `${lines(2500, (n) => `line ${n}`)}\n` },
		{ path: "wide.txt", text: `${lines(800, (n) => `${n} ${"w".repeat(96)}`)}\n` },
		{ path: "huge-line.txt", text: `${"h".repeat(60 * 1024)}\nafter\n` },
		{ path: "crlf.txt", text: "a\r\nb\r\n" },
		{ path: "unicode.txt", text: "héllo\n日本語\n🙂 smile\n" },
		{ path: "bom.txt", text: "﻿with bom\n" },
		{ path: "invalid.bin", base64: Buffer.from([0x66, 0x6f, 0xff, 0x6f, 0x0a, 0xc3, 0x28]).toString("base64") },
		{ path: "two words.txt", text: "spaced\n" },
		{ path: "Shot at 1.00 PM.txt", text: "screenshot\n" },
		{ path: "café.txt", text: "decomposed\n" },
		{ path: "it’s.txt", text: "curly\n" },
		{ path: "café’s.txt", text: "composed and curly\n" },
		{ path: "dir/" },
		{ path: "dir/b.txt", text: "" },
		{ path: "dir/A.md", text: "" },
		{ path: "dir/_hidden", text: "" },
		{ path: "dir/.dotfile", text: "" },
		{ path: "dir/sub/" },
		{ path: "dir/10.txt", text: "" },
		{ path: "dir/9.txt", text: "" },
		{ path: "dir/école.txt", text: "" },
		{ path: "dir/ecole.md", text: "" },
		{ path: "dir/eclair", text: "" },
		{ path: "dir/résumé", text: "" },
		{ path: "dir/resume", text: "" },
		{ path: "dir/z-file", text: "" },
		{ path: "dir/Zeta", text: "" },
		{ path: "dir/~tilde", text: "" },
		{ path: "dir/#hash", text: "" },
		{ path: "empty-dir/" },
		{ path: "big-dir/" },
		{ path: "wide-dir/" },
	];
	for (let index = 0; index < 520; index++)
		entries.push({ path: `big-dir/f${String(index).padStart(3, "0")}`, text: "" });
	for (let index = 0; index < 480; index++) {
		entries.push({ path: `wide-dir/${String(index).padStart(3, "0")}-${"n".repeat(110)}`, text: "" });
	}
	return entries;
}

function writeTree(root: string, entries: TreeEntry[]): void {
	for (const entry of entries) {
		const path = join(root, entry.path);
		if (entry.path.endsWith("/")) {
			mkdirSync(path, { recursive: true });
			continue;
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, entry.base64 !== undefined ? Buffer.from(entry.base64, "base64") : (entry.text ?? ""));
	}
}

/** `<root>` for the tree's directory, and `/` for the separators of the paths under it. */
function portable(value: unknown, root: string): unknown {
	if (typeof value === "string") {
		if (!value.includes(root)) return value;
		return value
			.split(root)
			.join("<root>")
			.replace(/<root>[^'\s\]]*/g, (path) => path.replaceAll("\\", "/"));
	}
	if (Array.isArray(value)) return value.map((item) => portable(item, root));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item, root)]));
	}
	return value;
}

type Definition = {
	name: string;
	description: string;
	parameters: unknown;
	constrainedSampling?: unknown;
	execute: (id: string, args: never, signal?: AbortSignal) => Promise<{ content: unknown; details: unknown }>;
};

async function runCalls(definition: Definition, calls: Record<string, unknown>[], root: string) {
	const results: unknown[] = [];
	for (const args of calls) {
		const resolved = JSON.parse(JSON.stringify(args).replaceAll("<root>", root.replaceAll("\\", "\\\\")));
		try {
			const result = await definition.execute("call", resolved as never);
			results.push({ args, result: portable(JSON.parse(JSON.stringify(result)), root) });
		} catch (error) {
			results.push({ args, error: portable(error instanceof Error ? error.message : String(error), root) });
		}
	}
	return results;
}

const declaration = (definition: Definition) =>
	JSON.parse(
		JSON.stringify({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			constrainedSampling: definition.constrainedSampling,
		}),
	);

const READ_CALLS: Record<string, unknown>[] = [
	{ path: "small.txt" },
	{ path: "small.txt", offset: 2 },
	{ path: "small.txt", offset: 2, limit: 1 },
	{ path: "small.txt", limit: 2 },
	{ path: "small.txt", offset: 4 },
	{ path: "small.txt", offset: 5 },
	{ path: "small.txt", offset: 10 },
	{ path: "small.txt", offset: 0 },
	{ path: "small.txt", offset: -3 },
	{ path: "small.txt", limit: -1 },
	{ path: "small.txt", limit: 0 },
	{ path: "small.txt", offset: 1.5 },
	{ path: "small.txt", offset: 2, limit: 0.5 },
	{ path: "no-newline.txt" },
	{ path: "empty.txt" },
	{ path: "long.txt" },
	{ path: "long.txt", offset: 2400 },
	{ path: "long.txt", offset: 10, limit: 5 },
	{ path: "wide.txt" },
	{ path: "wide.txt", offset: 700 },
	{ path: "huge-line.txt" },
	{ path: "huge-line.txt", offset: 2 },
	{ path: "crlf.txt" },
	{ path: "unicode.txt" },
	{ path: "bom.txt" },
	{ path: "invalid.bin" },
	{ path: "missing.txt" },
	{ path: "@small.txt" },
	{ path: "two words.txt" },
	{ path: "Shot at 1.00 PM.txt" },
	{ path: "café.txt" },
	{ path: "it's.txt" },
	{ path: "café's.txt" },
	{ path: "<root>/small.txt" },
	{ path: "dir/../small.txt" },
];

const LS_CALLS: Record<string, unknown>[] = [
	{ path: "dir" },
	{ path: "dir", limit: 3 },
	{ path: "dir", limit: 0 },
	{ path: "dir", limit: 2.5 },
	{ path: "empty-dir" },
	{ path: "big-dir" },
	{ path: "big-dir", limit: 600 },
	{ path: "wide-dir" },
	{ path: "nope" },
	{ path: "small.txt" },
	{ path: "" },
	{ path: "<root>/dir/sub" },
	{ path: "@dir" },
];

export async function toolFiles(): Promise<Record<string, string>> {
	const entries = tree();
	const root = mkdtempSync(join(tmpdir(), "relay-tools-"));
	try {
		writeTree(root, entries);
		const read = createReadToolDefinition(root) as unknown as Definition;
		const ls = createLsToolDefinition(root) as unknown as Definition;
		const listing = {
			declaration: declaration(ls),
			calls: await runCalls(ls, LS_CALLS, root),
		};
		// The listing of the root holds every fixture file, so it is read as a call too.
		const rootListing = await runCalls(ls, [{}], root);
		return {
			"read.json": json({
				declaration: declaration(read),
				tree: entries,
				calls: await runCalls(read, READ_CALLS, root),
			}),
			"ls.json": json({ ...listing, calls: [...listing.calls, ...rootListing] }),
			"helpers.json": json(helpers()),
			"edit.json": json(await mutationCalls("edit", EDIT_CALLS)),
			"write.json": json(await mutationCalls("write", WRITE_CALLS)),
			"diff.json": json(diffs()),
			"grep.json": json(await searchCalls("grep", GREP_CALLS)),
			"find.json": json(await searchCalls("find", FIND_CALLS)),
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** A call of a tool that changes files: the files before, the raw arguments, the files to read after. */
interface MutationCall {
	name: string;
	files: TreeEntry[];
	args: Record<string, unknown>;
	/** Read back afterwards, besides the files the call starts from. */
	after?: string[];
}

const numbered = (count: number) => `${lines(count, (n) => `line ${n}`)}\n`;

const EDIT_CALLS: MutationCall[] = [
	{
		name: "replace",
		files: [{ path: "a.ts", text: "const a = 1;\nconst b = 2;\n" }],
		args: { path: "a.ts", edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }] },
	},
	{
		name: "two-edits",
		files: [{ path: "a.ts", text: "one\ntwo\nthree\nfour\n" }],
		args: {
			path: "a.ts",
			edits: [
				{ oldText: "four", newText: "FOUR" },
				{ oldText: "one", newText: "ONE" },
			],
		},
	},
	{
		name: "grow-and-shrink",
		files: [{ path: "a.ts", text: "start\nmiddle\nend\n" }],
		args: {
			path: "a.ts",
			edits: [
				{ oldText: "start\n", newText: "start\nadded 1\nadded 2\n" },
				{ oldText: "middle\nend\n", newText: "end\n" },
			],
		},
	},
	{
		name: "far-apart",
		files: [{ path: "big.txt", text: numbered(60) }],
		args: {
			path: "big.txt",
			edits: [
				{ oldText: "line 5\n", newText: "line five\n" },
				{ oldText: "line 50\n", newText: "line fifty\nline fifty-and-a-half\n" },
			],
		},
	},
	{
		name: "close-together",
		files: [{ path: "big.txt", text: numbered(30) }],
		args: {
			path: "big.txt",
			edits: [
				{ oldText: "line 10\n", newText: "line ten\n" },
				{ oldText: "line 16\n", newText: "line sixteen\n" },
			],
		},
	},
	{
		name: "no-final-newline",
		files: [{ path: "a.txt", text: "first\nlast" }],
		args: { path: "a.txt", edits: [{ oldText: "last", newText: "last\nappended" }] },
	},
	{
		name: "adds-final-newline",
		files: [{ path: "a.txt", text: "first\nlast" }],
		args: { path: "a.txt", edits: [{ oldText: "last", newText: "last\n" }] },
	},
	{
		name: "empties-file",
		files: [{ path: "a.txt", text: "only\n" }],
		args: { path: "a.txt", edits: [{ oldText: "only\n", newText: "" }] },
	},
	{
		name: "crlf",
		files: [{ path: "win.txt", text: "alpha\r\nbeta\r\ngamma\r\n" }],
		args: { path: "win.txt", edits: [{ oldText: "beta\ngamma", newText: "BETA\r\nGAMMA" }] },
	},
	{
		name: "bom",
		files: [{ path: "bom.txt", text: "﻿header\nbody\n" }],
		args: { path: "bom.txt", edits: [{ oldText: "header", newText: "HEADER" }] },
	},
	{
		name: "fuzzy-trailing-space",
		files: [{ path: "a.py", text: "def f():   \n    return 1\t\t\n\nx = 'keep'  \n" }],
		args: { path: "a.py", edits: [{ oldText: "def f():\n    return 1", newText: "def f():\n    return 2" }] },
	},
	{
		name: "fuzzy-quotes-and-dashes",
		files: [{ path: "a.md", text: "He said “hello” — then left.\nIt’s fine.\nUntouched ’line’.\n" }],
		args: {
			path: "a.md",
			edits: [{ oldText: 'He said "hello" - then left.\nIt\'s fine.', newText: "He said goodbye.\nIt is fine." }],
		},
	},
	{
		name: "fuzzy-nfkc-and-spaces",
		files: [{ path: "a.txt", text: "ﬁle name = 1\nother line\n" }],
		args: { path: "a.txt", edits: [{ oldText: "file name = 1", newText: "file name = 2" }] },
	},
	{
		name: "not-found",
		files: [{ path: "a.txt", text: "abc\n" }],
		args: { path: "a.txt", edits: [{ oldText: "xyz", newText: "q" }] },
	},
	{
		name: "not-found-of-two",
		files: [{ path: "a.txt", text: "abc\n" }],
		args: {
			path: "a.txt",
			edits: [
				{ oldText: "abc", newText: "q" },
				{ oldText: "xyz", newText: "q" },
			],
		},
	},
	{
		name: "duplicate",
		files: [{ path: "a.txt", text: "x\nx\nx\n" }],
		args: { path: "a.txt", edits: [{ oldText: "x", newText: "y" }] },
	},
	{
		name: "duplicate-of-two",
		files: [{ path: "a.txt", text: "x\nx\ny\n" }],
		args: {
			path: "a.txt",
			edits: [
				{ oldText: "y", newText: "z" },
				{ oldText: "x", newText: "w" },
			],
		},
	},
	{
		name: "empty-old-text",
		files: [{ path: "a.txt", text: "abc\n" }],
		args: { path: "a.txt", edits: [{ oldText: "", newText: "q" }] },
	},
	{
		name: "empty-old-text-of-two",
		files: [{ path: "a.txt", text: "abc\n" }],
		args: {
			path: "a.txt",
			edits: [
				{ oldText: "abc", newText: "q" },
				{ oldText: "", newText: "q" },
			],
		},
	},
	{
		name: "overlap",
		files: [{ path: "a.txt", text: "abcdef\n" }],
		args: {
			path: "a.txt",
			edits: [
				{ oldText: "abcd", newText: "1" },
				{ oldText: "cdef", newText: "2" },
			],
		},
	},
	{
		name: "no-change",
		files: [{ path: "a.txt", text: "same\n" }],
		args: { path: "a.txt", edits: [{ oldText: "same", newText: "same" }] },
	},
	{
		name: "no-change-of-two",
		files: [{ path: "a.txt", text: "a b\n" }],
		args: {
			path: "a.txt",
			edits: [
				{ oldText: "a", newText: "a" },
				{ oldText: "b", newText: "b" },
			],
		},
	},
	{
		name: "missing-file",
		files: [],
		args: { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] },
	},
	{
		name: "no-edits",
		files: [{ path: "a.txt", text: "abc\n" }],
		args: { path: "a.txt", edits: [] },
	},
	{
		name: "edits-as-json-string",
		files: [{ path: "a.txt", text: "abc\n" }],
		args: { path: "a.txt", edits: JSON.stringify([{ oldText: "abc", newText: "xyz" }]) },
	},
	{
		name: "edit-as-json-object-string",
		files: [{ path: "a.txt", text: "abc\n" }],
		args: { path: "a.txt", edits: JSON.stringify({ oldText: "abc", newText: "xyz" }) },
	},
	{
		name: "edit-as-object",
		files: [{ path: "a.txt", text: "abc\n" }],
		args: { path: "a.txt", edits: { oldText: "abc", newText: "xyz" } },
	},
	{
		name: "legacy-fields",
		files: [{ path: "a.txt", text: "abc\ndef\n" }],
		args: { path: "a.txt", oldText: "def", newText: "DEF", edits: [{ oldText: "abc", newText: "ABC" }] },
	},
	{
		name: "unicode",
		files: [{ path: "u.txt", text: "naïve café\n日本語のテキスト\n🙂 done\n" }],
		args: { path: "u.txt", edits: [{ oldText: "日本語", newText: "中文" }] },
	},
	{
		name: "nested-path",
		files: [{ path: "src/lib/mod.rs", text: "pub fn a() {}\n" }],
		args: { path: "src/lib/mod.rs", edits: [{ oldText: "a()", newText: "b()" }] },
	},
];

const WRITE_CALLS: MutationCall[] = [
	{ name: "new-file", files: [], args: { path: "new.txt", content: "hello\n" }, after: ["new.txt"] },
	{
		name: "nested-dirs",
		files: [],
		args: { path: "deep/er/still/file.ts", content: "export {};\n" },
		after: ["deep/er/still/file.ts"],
	},
	{ name: "overwrite", files: [{ path: "a.txt", text: "old content\n" }], args: { path: "a.txt", content: "new" } },
	{ name: "empty", files: [], args: { path: "empty.txt", content: "" }, after: ["empty.txt"] },
	{
		name: "unicode",
		files: [],
		args: { path: "u.txt", content: "﻿naïve 🙂\r\n日本\n" },
		after: ["u.txt"],
	},
	{ name: "at-prefix", files: [], args: { path: "@at.txt", content: "x" }, after: ["at.txt"] },
];

async function mutationCalls(tool: "edit" | "write", calls: MutationCall[]) {
	const results: unknown[] = [];
	let toolDeclaration: unknown;
	for (const call of calls) {
		const root = mkdtempSync(join(tmpdir(), `relay-${tool}-`));
		try {
			for (const file of call.files) {
				mkdirSync(dirname(join(root, file.path)), { recursive: true });
				writeFileSync(join(root, file.path), file.text ?? "");
			}
			const definition = (tool === "edit"
				? createEditToolDefinition(root)
				: createWriteToolDefinition(root)) as unknown as Definition & {
				prepareArguments?: (args: unknown) => unknown;
			};
			toolDeclaration ??= declaration(definition);
			const args = JSON.parse(JSON.stringify(call.args));
			const prepared = definition.prepareArguments ? definition.prepareArguments(args) : args;
			let outcome: Record<string, unknown>;
			try {
				outcome = { result: JSON.parse(JSON.stringify(await definition.execute("call", prepared as never))) };
			} catch (error) {
				outcome = { error: error instanceof Error ? error.message : String(error) };
			}
			const paths = [...call.files.map((file) => file.path), ...(call.after ?? [])];
			const after = paths.map((path) => {
				const full = join(root, path);
				return existsSync(full) ? { path, base64: readFileSync(full).toString("base64") } : { path, missing: true };
			});
			results.push(portable({ ...call, ...outcome, after }, root));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
	return { declaration: toolDeclaration, calls: results };
}

/** Seeded random texts over a few lines, so the diff meets many equal-length choices. */
function randomTexts(count: number): [string, string][] {
	let seed = 20251119;
	const random = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const alphabet = ["a", "b", "c", "d", ""];
	const text = () => {
		const length = Math.floor(random() * 13);
		const body = Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("\n");
		return random() < 0.6 && length > 0 ? `${body}\n` : body;
	};
	return Array.from({ length: count }, () => [text(), text()] as [string, string]);
}

function diffs() {
	const handcrafted: [string, string][] = [
		["", ""],
		["", "new\n"],
		["old\n", ""],
		["same\n", "same\n"],
		["a\nb\nc\n", "a\nB\nc\n"],
		["a\nb\nc", "a\nb\nc\n"],
		["a\nb\nc\n", "a\nb\nc"],
		["a\r\nb\r\n", "a\r\nc\r\n"],
		["x\ny\n", "y\nx\n"],
		[numbered(40), numbered(40).replace("line 3\n", "line three\n").replace("line 37\n", "")],
		[numbered(20), numbered(20).replace("line 10\n", "line ten\nline ten again\n")],
		[numbered(12), `head\n${numbered(12)}tail\n`],
		// Seven unchanged lines after or before the only change: more than the context, less than twice it.
		["a\nb\nc\nd\ne\nf\ng\nh\n", "A\nb\nc\nd\ne\nf\ng\nh\n"],
		["a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nd\ne\nf\ng\nH\n"],
		// Exactly twice the context between two changes, then one line more and one less.
		[numbered(20), numbered(20).replace("line 3\n", "line three\n").replace("line 12\n", "line twelve\n")],
		[numbered(20), numbered(20).replace("line 3\n", "line three\n").replace("line 13\n", "line thirteen\n")],
		[numbered(20), numbered(20).replace("line 3\n", "line three\n").replace("line 11\n", "line eleven\n")],
	];
	return [...handcrafted, ...randomTexts(400)].map(([before, after]) => ({
		before,
		after,
		parts: diffLines(before, after).map(({ value, count, added, removed }) => ({ value, count, added, removed })),
		display: generateDiffString(before, after),
		patch: generateUnifiedPatch("f.txt", before, after),
	}));
}

function helpers() {
	const texts = [
		"",
		"one",
		"one\n",
		"a\nb\nc\nd\ne",
		"a\nb\nc\nd\ne\n",
		`${"x".repeat(20)}\nshort\n${"y".repeat(20)}`,
		"héllo wörld\n日本語テキスト\n🙂🙂🙂\n",
		`${"z".repeat(40)}`,
		"\n\n\n",
	];
	const limits = [
		{},
		{ maxLines: 2 },
		{ maxBytes: 10 },
		{ maxLines: 3, maxBytes: 12 },
		{ maxBytes: 7 },
		{ maxLines: 1, maxBytes: 1 },
	];
	const truncation = texts.flatMap((text) =>
		limits.map((options) => ({
			text,
			options,
			head: truncateHead(text, options),
			tail: truncateTail(text, options),
		})),
	);
	const middle = texts.flatMap((text) =>
		[4, 9, 16].map((maxBytes) => ({ text, maxBytes, result: truncateMiddle(text, maxBytes) })),
	);
	const line = [
		["short", 10],
		["exactly ten", 11],
		["this line is longer than the limit", 10],
		["日本語のテキストです", 5],
		["🙂🙂🙂🙂", 4],
	].map(([text, max]) => ({ text, max, result: truncateLine(text as string, max as number) }));
	const sizes = [
		0,
		1,
		1023,
		1024,
		1280,
		3328,
		256 * 1024 + 512,
		1536,
		51 * 1024,
		52429,
		2560,
		1048575,
		1048576,
		1572864,
		5 * 1024 * 1024 + 52429,
	];
	const formatted = sizes.map((bytes) => ({ bytes, text: formatSize(bytes) }));
	const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1];
	const apng = [...png.slice(0, 16), 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x61, 0x63, 0x54, 0x4c];
	const bmp = (dib: number, planes: number, bits: number) => {
		const bytes = new Array(40).fill(0);
		bytes[0] = 0x42;
		bytes[1] = 0x4d;
		bytes[2] = 200;
		bytes[10] = 54;
		bytes[14] = dib;
		if (dib === 12) {
			bytes[22] = planes;
			bytes[24] = bits;
		} else {
			bytes[26] = planes;
			bytes[28] = bits;
		}
		return bytes;
	};
	const images = [
		[0xff, 0xd8, 0xff, 0xe0],
		[0xff, 0xd8, 0xff, 0xf7],
		png,
		apng,
		[0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
		[0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
		[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
		bmp(40, 1, 24),
		bmp(12, 1, 8),
		bmp(40, 2, 24),
		bmp(40, 1, 7),
		bmp(64, 1, 32),
		[0x42, 0x4d, 1, 2, 3],
		[0x25, 0x50, 0x44, 0x46],
		[],
	].map((bytes) => ({ bytes, mimeType: detectSupportedImageMimeType(Uint8Array.from(bytes)) }));
	return { truncation, middle, line, sizes: formatted, images };
}

const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

export function readToolFile(name: string): string {
	return readFileSync(join(TOOLS_DIR, name), "utf8");
}

/** The tree grep and find search: several files, a hidden directory, a nested repository. */
function searchTree(): TreeEntry[] {
	return [
		{ path: "search/a.ts", text: "const alpha = 1;\nconst beta = 2;\n// TODO: fix alpha\n" },
		{ path: "search/b.ts", text: "export function alpha() {}\n" },
		{ path: "search/notes.md", text: "Alpha and ALPHA and alpha\nnothing here\n" },
		{ path: "search/long.txt", text: `short\n${"x".repeat(300)} needle ${"y".repeat(400)}\nend\n` },
		{ path: "search/many.txt", text: `${lines(300, (n) => `match ${n} ${"m".repeat(290)}`)}\n` },
		{ path: "search/crlf.txt", text: "one\r\nneedle\r\nthree\r\n" },
		{ path: "search/cr.txt", text: "x\ry needle\n" },
		{ path: "search/ctx.txt", text: `${lines(10, (n) => (n === 5 || n === 7 ? `hit ${n}` : `line ${n}`))}\n` },
		{ path: "search/sub/deep.ts", text: "alpha in deep\n" },
		{ path: "search/.hidden/secret.ts", text: "alpha hidden\n" },
		{ path: "search/repo/.git/" },
		{ path: "search/repo/.gitignore", text: "ignored.txt\n" },
		{ path: "search/repo/ignored.txt", text: "alpha ignored\n" },
		{ path: "search/repo/kept.txt", text: "alpha kept\n" },
		{ path: "search/three/one.txt", text: "" },
		{ path: "search/three/two.txt", text: "" },
		{ path: "search/three/three.txt", text: "" },
		// A parent .gitignore must not reach into a nested repository.
		{ path: "search/outer/.git/" },
		{ path: "search/outer/.gitignore", text: "*.log\n" },
		{ path: "search/outer/top.log", text: "" },
		{ path: "search/outer/inner/.git/" },
		{ path: "search/outer/inner/debug.log", text: "" },
	];
}

const GREP_CALLS: Record<string, unknown>[] = [
	{ pattern: "alpha", path: "search", sort: true },
	{ pattern: "alpha", path: "search/a.ts" },
	{ pattern: "ALPHA", path: "search/a.ts", ignoreCase: true },
	{ pattern: "ALPHA", path: "search/a.ts" },
	{ pattern: "a.p", path: "search/notes.md", literal: true },
	{ pattern: "al.ha", path: "search/notes.md" },
	{ pattern: "alpha", path: "search", glob: "*.ts", sort: true },
	{ pattern: "hit", path: "search/ctx.txt", context: 2 },
	{ pattern: "hit", path: "search/ctx.txt", context: 0 },
	{ pattern: "hit", path: "search/ctx.txt", context: 9 },
	{ pattern: "match", path: "search/many.txt", limit: 5 },
	{ pattern: "match", path: "search/many.txt", limit: 0 },
	{ pattern: "match", path: "search/many.txt", limit: 200 },
	{ pattern: "needle", path: "search/long.txt" },
	{ pattern: "needle", path: "search/long.txt", context: 1 },
	{ pattern: "needle", path: "search/crlf.txt" },
	{ pattern: "needle", path: "search/crlf.txt", context: 1 },
	{ pattern: "needle", path: "search/cr.txt" },
	{ pattern: "x", path: "search/missing" },
	{ pattern: "alpha", path: "search/repo", sort: true },
	{ pattern: "zzz", path: "search" },
	{ pattern: "alpha", path: "search/.hidden" },
];

const FIND_CALLS: Record<string, unknown>[] = [
	{ pattern: "*.ts", path: "search", sort: true },
	{ pattern: "*.md", path: "search", sort: true },
	{ pattern: "sub/*.ts", path: "search", sort: true },
	{ pattern: "**/*.ts", path: "search", sort: true },
	{ pattern: "*.nothing", path: "search" },
	{ pattern: "*", path: "search/sub", sort: true },
	{ pattern: "*", path: "search/three", limit: 3, sort: true },
	{ pattern: "*.txt", path: "search/repo", sort: true },
	{ pattern: "*.ts", path: "search/.hidden", sort: true },
	{ pattern: "*", path: "search/three", sort: true },
	{ pattern: "*.log", path: "search/outer", sort: true },
];

/** A result's text with its lines sorted, before any notice. */
function sortedResult(value: unknown): unknown {
	const result = value as { content?: { type: string; text: string }[] };
	if (!result.content) return value;
	const content = result.content.map((block) => {
		if (block.type !== "text") return block;
		const at = block.text.indexOf("\n\n[");
		const body = at === -1 ? block.text : block.text.slice(0, at);
		const notice = at === -1 ? "" : block.text.slice(at);
		return { ...block, text: body.split("\n").sort().join("\n") + notice };
	});
	return { ...result, content };
}

async function searchCalls(tool: "grep" | "find", calls: Record<string, unknown>[]) {
	const entries = searchTree();
	const root = mkdtempSync(join(tmpdir(), `relay-${tool}-`));
	try {
		writeTree(root, entries);
		const definition = (tool === "grep"
			? createGrepToolDefinition(root)
			: createFindToolDefinition(root)) as unknown as Definition;
		const results: unknown[] = [];
		for (const call of calls) {
			const { sort, ...args } = call;
			try {
				const result = JSON.parse(JSON.stringify(await definition.execute("call", args as never)));
				results.push({ args: call, result: portable(sort ? sortedResult(result) : result, root) });
			} catch (error) {
				results.push({ args: call, error: portable(error instanceof Error ? error.message : String(error), root) });
			}
		}
		return { declaration: declaration(definition), tree: entries, calls: results };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
