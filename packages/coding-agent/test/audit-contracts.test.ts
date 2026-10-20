import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAuditResourcesPath } from "../src/config.ts";
import { loadResources, parseOutput } from "../src/core/audit/contracts.ts";

describe("versioned audit protocol", () => {
	it("validates all upstream examples and local refs with JSON Schema 2020-12", () => {
		const resources = loadResources();
		for (const [schema, example] of [
			["finding", "finding.validated"],
			["agent-result", "agent-result"],
			["audit-run", "audit-run"],
		])
			resources.validate(
				schema,
				JSON.parse(readFileSync(join(getAuditResourcesPath(), "examples", `${example}.example.json`), "utf8")),
			);
		expect(Object.keys(resources.routing.routing)).toHaveLength(20);
		expect(new Set(Object.values(resources.routing.routing).map((r) => r.primary)).size).toBe(6);
	});
	it("rejects truncated JSON, arbitrary prose, mismatches and schema-invalid confirmations", () => {
		expect(() => parseOutput("```json\n{}\n```", 200)).toThrow();
		expect(() => parseOutput('{"x":', 200)).toThrow();
		expect(() => parseOutput("{}", 1)).toThrow();
		expect(() => parseOutput(`${"[".repeat(30)}0${"]".repeat(30)}`, 1000)).toThrow(/complexity/);
		const resources = loadResources();
		const value = JSON.parse(
			readFileSync(join(getAuditResourcesPath(), "examples/finding.validated.example.json"), "utf8"),
		);
		value.status = "CONFIRMADO";
		delete value.validation;
		expect(() => resources.validate("finding", value)).toThrow();
	});
});
