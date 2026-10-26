import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { heuristicAssessment } from "../src/extensions/laya/assessment.ts";
import { LIBRARY_CONTEXT_CHARS, libraryPath, selectLibraryGuides } from "../src/extensions/laya/library.ts";
import { LIBRARY_DIRECTORIES } from "../src/extensions/laya/questions.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "relay-library-"));
	roots.push(root);
	mkdirSync(join(root, "library"));
	const library = join(root, "library");
	const categories = [
		{
			id: LIBRARY_DIRECTORIES.databases,
			title: "Databases",
			files: [{ path: "sql.md", title: "SQL Performance and Indexing" }],
		},
		{
			id: LIBRARY_DIRECTORIES.security,
			title: "Security",
			files: [{ path: "security.md", title: "SQL Injection Security" }],
		},
	];
	writeFileSync(join(library, "LIBRARY_INDEX.json"), JSON.stringify({ categories }));
	writeFileSync(join(library, "sql.md"), `Database reference\n${"x".repeat(20_000)}`);
	writeFileSync(join(library, "security.md"), "Security reference");
	writeFileSync(join(root, "outside.md"), "private reference");
	return library;
}

const assessment = () => ({
	...heuristicAssessment("Explain SQL indexing"),
	source: "laya" as const,
	libraryCategory: "databases" as const,
	libraryConfidence: 0.95,
});

describe("library routing", () => {
	it("filters by category, includes references only above the calibrated threshold and bounds context", () => {
		const selection = selectLibraryGuides(fixture(), assessment(), "SQL indexing", 0.9)!;
		expect(selection.guides.map((guide) => guide.path)).toEqual(["sql.md"]);
		expect(selection.injected).toBe(true);
		expect(selection.content).toContain("Database reference");
		expect(selection.content).not.toContain("Security reference");
		expect(selection.content.length).toBeLessThanOrEqual(LIBRARY_CONTEXT_CHARS);
	});

	it("suggests without reading guide contents when confidence is low or calibration is absent", () => {
		const root = fixture();
		rmSync(join(root, "sql.md"));
		for (const threshold of [0.99, Number.NaN, -1, 2]) {
			const selection = selectLibraryGuides(root, assessment(), "SQL indexing", threshold)!;
			expect(selection.guides).toHaveLength(1);
			expect(selection.injected).toBe(false);
			expect(selection.content).toBe("");
		}
	});

	it("abstains for heuristic assessments", () => {
		const root = fixture();
		expect(selectLibraryGuides(root, heuristicAssessment("hello"), "hello", 0.9)).toBeUndefined();
		expect(selectLibraryGuides(root, assessment(), "unrelated topic", 0.9)?.guides).toEqual([]);
	});

	it("rejects references outside the configured root", () => {
		const root = fixture();
		expect(() => libraryPath(root, "../outside.md")).toThrow("outside its root");
	});
	it("ignores common title words and excludes other editions when the request names a version", () => {
		const root = fixture();
		expect(
			selectLibraryGuides(root, assessment(), "Explain the trade-off and show examples for me", 0.9)?.guides,
		).toEqual([]);
		writeFileSync(
			join(root, "LIBRARY_INDEX.json"),
			JSON.stringify({
				categories: [
					{
						id: LIBRARY_DIRECTORIES.frameworks,
						title: "Frameworks",
						files: [
							{ path: "angular17.md", title: "Angular 17 - Complete Professional Guide", stack: "angular" },
							{ path: "angular22.md", title: "Angular 22 - Complete Professional Guide", stack: "angular" },
						],
					},
				],
			}),
		);
		writeFileSync(join(root, "angular17.md"), "old edition");
		writeFileSync(join(root, "angular22.md"), "requested edition");
		const selection = selectLibraryGuides(
			root,
			{ ...assessment(), libraryCategory: "frameworks" },
			"Angular 22 signals",
			0.9,
		);
		expect(selection?.guides.map((guide) => guide.path)).toEqual(["angular22.md"]);
		expect(selection?.content).toContain("requested edition");
		expect(selection?.content).not.toContain("old edition");
	});
});
