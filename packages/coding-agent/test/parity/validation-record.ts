/**
 * Reference tool-argument validation (`validateToolArguments` in `packages/ai/src/utils/validation.ts`),
 * for the Rust port to match: TypeBox's `Value.Convert`, Relay's coercion, TypeBox's check, and
 * the error message the model receives.
 *
 * The schemas are the built-in tools' (TypeBox objects) and plain JSON schemas such as MCP
 * servers send. Each built-in case also runs on a plain JSON copy of its schema, so the reference
 * shows whether TypeBox's own schema objects validate differently from their JSON.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type JsonObject, validateToolArguments } from "@relay-harness/ai";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "../../src/core/tools/index.ts";

export const VALIDATION_FILE = fileURLToPath(new URL("../../../../crates/fixtures/validation.json", import.meta.url));

type Schema = Record<string, unknown>;

/** Plain JSON schemas, as MCP servers and extensions declare them. */
const PLAIN: Record<string, Schema> = {
	search: {
		type: "object",
		properties: {
			query: { type: "string", minLength: 1, maxLength: 20 },
			limit: { type: "integer", minimum: 1, maximum: 50 },
			exact: { type: "boolean" },
			tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
			mode: { type: "string", enum: ["fast", "deep"] },
			cursor: { type: ["string", "null"] },
			score: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
		},
		required: ["query"],
		additionalProperties: false,
	},
	union: {
		type: "object",
		properties: {
			value: { anyOf: [{ type: "number" }, { type: "string" }] },
			choice: { oneOf: [{ type: "string", const: "all" }, { type: "integer" }] },
			nothing: { type: "null" },
		},
		required: ["value"],
	},
	nested: {
		type: "object",
		properties: {
			target: {
				type: "object",
				properties: {
					url: { type: "string", pattern: "^https?://" },
					port: { type: "integer" },
				},
				required: ["url"],
				additionalProperties: { type: "string" },
			},
			points: { type: "array", items: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } },
			pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
		},
		required: ["target"],
	},
	referenced: {
		type: "object",
		$defs: { name: { type: "string", minLength: 2 } },
		properties: { first: { $ref: "#/$defs/name" }, last: { $ref: "#/$defs/name" } },
		required: ["first"],
	},
	constrained: {
		type: "object",
		properties: {
			count: { type: "number", multipleOf: 5 },
			letters: { type: "string", format: "email" },
			items: { type: "array", uniqueItems: true },
			config: { type: "object", minProperties: 1, maxProperties: 2 },
		},
	},
	loose: { type: "object" },
	formats: {
		type: "object",
		properties: Object.fromEntries(
			[
				"date-time",
				"date",
				"time",
				"duration",
				"uuid",
				"uri",
				"uri-reference",
				"ipv4",
				"ipv6",
				"hostname",
				"json-pointer",
				"regex",
				"unknown-format",
			].map((format) => [format, { type: "string", format }]),
		),
	},
};

const ARGS: Record<string, unknown[]> = {
	read: [
		{ path: "a.ts" },
		{ path: "a.ts", offset: 10, limit: 5 },
		{ path: "a.ts", offset: "10", limit: "5" },
		{ path: "a.ts", offset: "ten" },
		{ path: "a.ts", offset: null, limit: null },
		{ path: 42 },
		{ path: true, offset: true },
		{ offset: 1 },
		{},
		{ path: "a.ts", extra: "kept" },
		{ path: null },
		{ path: "a.ts", offset: " 12 " },
		{ path: "a.ts", offset: "" },
		{ path: ["a.ts"] },
	],
	write: [{ path: "a", content: "x" }, { path: "a" }, { path: "a", content: 5 }, { content: "x" }],
	edit: [
		{ path: "a", edits: [{ oldText: "x", newText: "y" }] },
		{ path: "a", edits: [] },
		{ path: "a", edits: [{ oldText: "x" }] },
		{ path: "a", edits: [{ oldText: 1, newText: 2 }] },
		{ path: "a", edits: { oldText: "x", newText: "y" } },
		{ path: "a", edits: "[]" },
		{ path: "a", edits: [{ oldText: "x", newText: "y" }, { newText: "z" }, "bad"] },
		{ edits: [{ oldText: null, newText: "y" }] },
	],
	bash: [{ command: "ls" }, { command: "ls", timeout: "30" }, { command: "ls", timeout: 0 }, { command: ["ls"] }, {}],
	grep: [{ pattern: "x" }, { pattern: "x", ignoreCase: "true", context: "2", limit: 3.5 }, { pattern: 1 }],
	find: [{ pattern: "*.ts" }, { pattern: "*.ts", limit: "x" }, {}],
	ls: [{}, { path: "." }, { path: 1, limit: "4" }],
	search: [
		{ query: "rust" },
		{ query: "" },
		{ query: "a".repeat(25) },
		{ query: "rust", limit: "7" },
		{ query: "rust", limit: 7.5 },
		{ query: "rust", limit: 0 },
		{ query: "rust", limit: 51 },
		{ query: "rust", exact: "false" },
		{ query: "rust", exact: 1 },
		{ query: "rust", exact: "yes" },
		{ query: "rust", tags: [] },
		{ query: "rust", tags: ["a", "b", "c", "d"] },
		{ query: "rust", tags: [1, true] },
		{ query: "rust", mode: "slow" },
		{ query: "rust", cursor: null },
		{ query: "rust", cursor: 5 },
		{ query: "rust", score: 0 },
		{ query: "rust", score: 1 },
		{ query: "rust", score: "0.5" },
		{ query: "rust", unknown: 1 },
		{ query: 5, limit: "x", exact: "maybe", tags: "a", unknown: true },
		{ query: "rust", cursor: {} },
		{ query: "e\u0301".repeat(20) },
		{ query: "e\u0301".repeat(21) },
		{ query: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}" },
		{ query: "\u{1F1E7}\u{1F1F7}".repeat(11) },
		{ query: "\u{1F600}".repeat(11) },
		{ query: "abc\uFE0F".repeat(6) },
		{},
	],
	union: [
		{ value: 1 },
		{ value: "x" },
		{ value: true },
		{ value: null },
		{ value: [1] },
		{ value: 1, choice: "all" },
		{ value: 1, choice: "some" },
		{ value: 1, choice: 2 },
		{ value: 1, choice: "2" },
		{ value: 1, nothing: "" },
		{ value: 1, nothing: 0 },
		{ value: 1, nothing: "x" },
	],
	nested: [
		{ target: { url: "https://a.b" } },
		{ target: { url: "ftp://a.b" } },
		{ target: { url: "https://a.b", port: "8080", label: "x" } },
		{ target: { url: "https://a.b", extra: 5 } },
		{ target: { port: 1 } },
		{ target: "https://a.b" },
		{ target: { url: "https://a.b" }, points: [{ x: 1 }, { x: "2" }, {}] },
		{ target: { url: "https://a.b" }, pair: ["a", "2"] },
		{ target: { url: "https://a.b" }, pair: [1, 2, 3] },
	],
	referenced: [{ first: "Ada" }, { first: "A" }, { first: "Ada", last: 7 }, { last: "Lovelace" }, { first: "é" }],
	constrained: [
		{ count: 10 },
		{ count: 7 },
		{ letters: "a@b.co" },
		{ letters: "not-an-email" },
		{ items: [1, 2, 1] },
		{ items: [{ a: 1 }, { a: 1 }] },
		{ config: {} },
		{ config: { a: 1, b: 2, c: 3 } },
	],
	loose: [{}, { anything: [1, { two: null }] }, []],
	formats: [
		{
			"date-time": "2024-02-29T23:59:60Z",
			date: "2024-02-29",
			time: "12:30:00+01:00",
			duration: "P1Y2M3DT4H5M6S",
			uuid: "123e4567-e89b-12d3-a456-426614174000",
			uri: "https://example.com/a?b=c#d",
			"uri-reference": "../a/b",
			ipv4: "192.168.0.1",
			ipv6: "2001:db8::1",
			hostname: "example.com",
			"json-pointer": "/a/b~1c",
			regex: "^a+$",
			"unknown-format": "anything",
		},
		{
			"date-time": "2023-02-29T10:00:00Z",
			date: "2024-13-01",
			time: "12:30:00",
			duration: "P",
			uuid: "not-a-uuid",
			uri: "no scheme",
			ipv4: "256.1.1.1",
			ipv6: "1:2:3",
			hostname: "-bad-.com",
			"json-pointer": "a/b",
			regex: "(",
		},
		{ "date-time": "2024-01-01T23:59:60+00:00", time: "23:59:60Z" },
		{ "date-time": "2024-01-01t10:00:00.123z", time: "10:00:60Z" },
	],
};

interface ValidationCase {
	name: string;
	schema: Schema;
	/** The schema object is TypeBox's own (a built-in tool), not plain JSON. */
	typebox: boolean;
	args: unknown;
	result?: unknown;
	error?: string;
}

function validate(name: string, schema: object, args: unknown): { result?: unknown; error?: string } {
	try {
		const result = validateToolArguments({ name, description: "", parameters: schema } as never, {
			type: "toolCall",
			id: "call_1",
			name,
			arguments: args as JsonObject,
		});
		return { result: JSON.parse(JSON.stringify(result ?? null)) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export function validationCases(): ValidationCase[] {
	const cwd = process.cwd();
	const builtins: Record<string, object> = Object.fromEntries(
		[
			createReadToolDefinition(cwd),
			createWriteToolDefinition(cwd),
			createEditToolDefinition(cwd),
			createBashToolDefinition(cwd),
			createGrepToolDefinition(cwd),
			createFindToolDefinition(cwd),
			createLsToolDefinition(cwd),
		].map((tool) => [tool.name, tool.parameters as object]),
	);
	const cases: ValidationCase[] = [];
	for (const [name, argsList] of Object.entries(ARGS)) {
		const typeboxSchema = builtins[name];
		const plain = typeboxSchema ? (JSON.parse(JSON.stringify(typeboxSchema)) as Schema) : PLAIN[name]!;
		argsList.forEach((args, index) => {
			const variants: [boolean, object][] = typeboxSchema
				? [
						[true, typeboxSchema],
						[false, plain],
					]
				: [[false, plain]];
			for (const [typebox, schema] of variants) {
				cases.push({
					name: `${name}-${index}${typebox ? "-typebox" : ""}`,
					schema: plain,
					typebox,
					args,
					...validate(name, schema, structuredClone(args)),
				});
			}
		});
	}
	return cases;
}

export function validationJson(): string {
	return `${JSON.stringify({ cases: validationCases() }, null, "\t")}\n`;
}

export function readValidation(): string {
	return readFileSync(VALIDATION_FILE, "utf8");
}
