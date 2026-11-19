/**
 * Reference results of the JSON helpers adapters use on provider output, for the Rust port:
 * `parseStreamingJson` on every prefix of tool arguments as they stream, and `parseJsonWithRepair`
 * on malformed event data. NaN and Infinity, which `partial-json` can return, are written as
 * null, as `JSON.stringify` writes them in a request.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonWithRepair, parseStreamingJson } from "../../src/utils/json-parse.ts";

export const JSON_DIR = fileURLToPath(new URL("../../../../crates/fixtures/json/", import.meta.url));

/** Documents streamed one code point at a time. */
const STREAMED = [
	'{"path": "src/a.ts", "offset": 10, "limit": -2.5e3}',
	'{"command":"echo \\"hi\\" && ls\\n","timeout":null,"background":false,"force":true}',
	'{ "edits": [ { "oldText": "a\\tb", "newText": "caf\\u00e9 🙈" }, {"oldText":"","newText":"x"} ], "nested": {"deep": [1, [2, {"three": 3}]]} }',
	'{"text": "line one\nline two", "path": "C:\\Users\\dev"}',
	'["a", 1, true, null, {"k": "v"}]',
	'"just a string"',
	"  42  ",
	'{"special": NaN, "big": Infinity, "neg": -Infinity}',
];

/** Single values parsed with repair; `error: true` when the TypeScript side throws. */
const REPAIRED = [
	'{"a": 1}',
	'{"text": "raw\nnewline\ttab"}',
	'{"path": "C:\\Users\\dev\\x"}',
	'{"bad": "\\q"}',
	'{"unicode": "\\u00e9 \\uZZZZ"}',
	'{"trailing": "\\',
	'{"a": 1,}',
	"[1, 2",
];

function jsonValue(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value) ?? "null");
}

export function jsonFixture(): unknown {
	const streamed = STREAMED.map((document) => {
		const points = Array.from(document);
		const prefixes = points.map((_, index) => points.slice(0, index + 1).join(""));
		return {
			document,
			results: [
				{ input: "", output: parseStreamingJson("") },
				...prefixes.map((input) => ({ input, output: jsonValue(parseStreamingJson(input)) })),
			],
		};
	});
	const repaired = REPAIRED.map((input) => {
		try {
			return { input, output: jsonValue(parseJsonWithRepair(input)) };
		} catch {
			return { input, error: true };
		}
	});
	return { streamed, repaired };
}

export function jsonFixtureText(): string {
	return `${JSON.stringify(jsonFixture(), null, "\t")}\n`;
}

export function readJsonFixture(): string {
	return readFileSync(join(JSON_DIR, "parse.json"), "utf8");
}
