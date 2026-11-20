/**
 * Reference outputs of the file tools and their helpers, for the Rust port to match byte for
 * byte: the model reads them.
 *
 * - `tools/helpers.json`: `truncateHead`, `truncateTail`, `truncateMiddle`, `truncateLine`,
 *   `formatSize` and `detectSupportedImageMimeType` on fixed inputs.
 * - `tools/read.json`, `tools/ls.json`: each tool's declaration, the files of a fixture tree, and
 *   what each call returned or threw.
 *
 * The tree is written to a temporary directory; its path becomes `<root>` and the separators in
 * paths become `/`, so the files are the same on every platform.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLsToolDefinition } from "../../src/core/tools/ls.ts";
import { createReadToolDefinition } from "../../src/core/tools/read.ts";
import { formatSize, truncateHead, truncateLine, truncateMiddle, truncateTail } from "../../src/core/tools/truncate.ts";
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
		if (entry.path.endsWith("/")) mkdirSync(path, { recursive: true });
		else writeFileSync(path, entry.base64 !== undefined ? Buffer.from(entry.base64, "base64") : (entry.text ?? ""));
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
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
