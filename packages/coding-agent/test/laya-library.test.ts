import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getEngineeringResourcesPath } from "../src/config.ts";
import { heuristicAssessment } from "../src/extensions/laya/assessment.ts";
import {
	LIBRARY_CONTEXT_CHARS,
	type LibraryIndex,
	libraryPath,
	selectLibraryGuides,
} from "../src/extensions/laya/library.ts";
import { generateLibraryDataset } from "../src/extensions/laya/library-data.ts";
import { LAYA_QUESTIONS, LIBRARY_CATEGORY_IDS, LIBRARY_DIRECTORIES } from "../src/extensions/laya/questions.ts";
import { libraryTrainingRows, passesGate, readRows, type Score } from "../src/extensions/laya/training.ts";

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
	it("keeps the six public acceptance boundary examples out of training", () => {
		const cases = readRows(join(getEngineeringResourcesPath(), "laya", "boundary-cases.jsonl"));
		const trained = new Set(
			libraryTrainingRows()
				.filter((row) => row.split === "train")
				.map((row) => row.state.request),
		);
		expect(cases).toHaveLength(6);
		expect(new Set(cases.map((row) => row.expected.library_category)).size).toBe(6);
		for (const row of cases) {
			expect(row.source).toBe("acceptance-boundary");
			expect(row.boundary).toBe(true);
			expect(trained.has(row.state.request)).toBe(false);
		}
	});
	it("ships concrete bilingual training requests for every guide, with independent boundary training", () => {
		const rows = libraryTrainingRows();
		const guides = new Set(rows.map((row) => row.guide).filter((guide) => guide !== undefined));
		expect(guides.size).toBe(136);
		for (const guide of guides) {
			const examples = rows.filter((row) => row.guide === guide);
			expect(examples.length).toBeGreaterThanOrEqual(6);
			expect(examples.every((row) => row.split === "train" && row.label_source === "index-agent-scenario")).toBe(
				true,
			);
			expect(examples.filter((row) => row.language === "pt").length / examples.length).toBeCloseTo(1 / 3);
		}
		for (const category of LIBRARY_CATEGORY_IDS)
			expect(
				rows.filter((row) => row.split === "train" && row.boundary && row.expected.library_category === category),
			).toHaveLength(5);
		const short = rows.filter((row) => row.label_source === "agent-short-scenario");
		expect(short).toHaveLength(200);
		expect(short.every((row) => row.split === "train" && row.guide === undefined)).toBe(true);
		expect(short.filter((row) => row.language === "pt")).toHaveLength(60);
		for (const category of LIBRARY_CATEGORY_IDS)
			expect(short.filter((row) => row.expected.library_category === category)).toHaveLength(20);
		const rails = rows.find((row) => row.guide?.includes("Ruby on Rails") && row.language === "en");
		expect(rails?.state.request).toContain("active record callbacks");
	});
	it("keeps thirty bilingual daily-use cases separate from every training and calibration request", () => {
		const cases = readRows(join(getEngineeringResourcesPath(), "laya", "runtime-cases.jsonl"));
		const trained = new Set(libraryTrainingRows().map((row) => row.state.request.trim().toLowerCase()));
		expect(cases).toHaveLength(30);
		expect(new Set(cases.map((row) => row.state.request)).size).toBe(30);
		for (const category of LIBRARY_CATEGORY_IDS)
			expect(cases.filter((row) => row.expected.library_category === category)).toHaveLength(3);
		expect(cases.filter((row) => row.language === "pt")).toHaveLength(10);
		for (const row of cases) {
			expect(row.source).toBe("synthetic-runtime");
			expect(trained.has(row.state.request.trim().toLowerCase())).toBe(false);
		}
	});
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

	it("abstains for heuristic assessments and never injects memory labels as model confidence", () => {
		const root = fixture();
		expect(selectLibraryGuides(root, heuristicAssessment("hello"), "hello", 0.9)).toBeUndefined();
		expect(selectLibraryGuides(root, { ...assessment(), source: "memory" }, "SQL", 0.9)?.injected).toBe(false);
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

	it("creates balanced bilingual data with explicit held-out splits and no duplicate requests", () => {
		const subjects = {
			languages: "TypeScript",
			algorithms: "Algorithm Design and Analysis",
			architecture: "Domain-Driven Design",
			engineering: "Test-Driven Development",
			databases: "SQL Performance and Indexing",
			web_frontend: "RESTful API Design",
			devops: "Git Version Control",
			security: "SSH and Tunnels",
			automation: "n8n",
			frameworks: "React 19",
		};
		const index: LibraryIndex = {
			categories: LIBRARY_CATEGORY_IDS.map((id) => ({
				id: LIBRARY_DIRECTORIES[id],
				title: id,
				files: [{ title: `${subjects[id]} - Complete Professional Guide`, path: `${id}/guide.md` }],
			})),
		};
		const rows = generateLibraryDataset(index);
		expect(rows.length).toBeGreaterThanOrEqual(400);
		expect(new Set(rows.map((row) => row.state.request)).size).toBe(rows.length);
		for (const category of LIBRARY_CATEGORY_IDS) {
			const selected = rows.filter((row) => row.expected.library_category === category);
			expect(selected.length).toBeGreaterThanOrEqual(40);
			for (const split of ["train", "val", "test"]) {
				for (const language of ["en", "pt"])
					expect(selected.some((row) => row.split === split && row.language === language)).toBe(true);
			}
			const training = selected.filter((row) => row.split === "train");
			const portugueseShare = training.filter((row) => row.language === "pt").length / training.length;
			expect(portugueseShare).toBeGreaterThanOrEqual(0.3);
			expect(portugueseShare).toBeLessThanOrEqual(0.35);
			expect(training.some((row) => /a small service|um.*a production application/.test(row.state.request))).toBe(
				false,
			);
		}
		expect(rows.find((row) => row.state.request.startsWith("Design the REST API"))?.expected.library_category).toBe(
			"web_frontend",
		);
	});
});

function scores(): { candidate: Score; current: Score } {
	const per_question = Object.fromEntries(Object.keys(LAYA_QUESTIONS).map((id) => [id, { n: 100, correct: 95 }]));
	return {
		candidate: {
			n: 1900,
			correct: 1805,
			per_question: structuredClone(per_question),
			library: {
				accuracy: 0.95,
				ece: 0.05,
				portuguese: { n: 20, correct: 18 },
				boundary: { n: 10, correct: 9 },
				acceptance_boundary: { n: 6, correct: 6 },
			},
		},
		current: { n: 1900, correct: 1805, per_question: structuredClone(per_question) },
	};
}

describe("library activation gate", () => {
	it("prevents a gain on the new category from hiding regression on an old decision", () => {
		const test = scores();
		expect(passesGate(test)).toBe(true);
		test.candidate.per_question.task_type.correct--;
		test.candidate.per_question.library_category.correct = 100;
		expect(passesGate(test)).toBe(false);
	});

	it("requires measured category, Portuguese and boundary acceptance with unchanged evaluation coverage", () => {
		for (const change of [
			(test: ReturnType<typeof scores>) => {
				test.candidate.per_question.library_category.correct = 89;
			},
			(test: ReturnType<typeof scores>) => {
				test.candidate.library!.portuguese.correct = 16;
			},
			(test: ReturnType<typeof scores>) => {
				test.candidate.library!.acceptance_boundary!.correct = 5;
			},
			(test: ReturnType<typeof scores>) => {
				delete test.candidate.library!.acceptance_boundary;
			},
			(test: ReturnType<typeof scores>) => {
				test.candidate.library!.acceptance_boundary!.n = 5;
			},
			(test: ReturnType<typeof scores>) => {
				test.candidate.per_question.agent.n = 99;
			},
			(test: ReturnType<typeof scores>) => {
				delete test.candidate.per_question.agent;
			},
		]) {
			const test = scores();
			change(test);
			expect(passesGate(test)).toBe(false);
		}
	});
});
