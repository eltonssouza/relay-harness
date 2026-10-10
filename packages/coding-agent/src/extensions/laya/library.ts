import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TaskAssessment } from "./assessment.ts";
import { LIBRARY_DIRECTORIES, type LibraryCategoryId } from "./questions.ts";

export interface LibraryGuide {
	path: string;
	title: string;
	stack?: string;
}

export interface LibraryIndex {
	categories: Array<{ id: string; title: string; files: LibraryGuide[] }>;
}

export interface LibrarySelection {
	category: LibraryCategoryId;
	guides: LibraryGuide[];
	content: string;
	injected: boolean;
}

/** Bounds context growth even when a guide is a complete book. */
export const LIBRARY_CONTEXT_CHARS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Rejects traversal and symlinks outside the configured library, including for the index. */
export function libraryPath(root: string, path: string): string {
	const base = realpathSync(root);
	const target = realpathSync(resolve(base, path));
	const rel = relative(base, target);
	if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
		throw new Error(`Library path is outside its root: ${path}`);
	}
	return target;
}

export function readLibraryIndex(root: string): LibraryIndex {
	const value: unknown = JSON.parse(readFileSync(libraryPath(root, "LIBRARY_INDEX.json"), "utf8"));
	if (!isRecord(value) || !Array.isArray(value.categories)) {
		throw new Error("Invalid library index: categories must be an array");
	}
	const categories: unknown[] = value.categories;
	for (const category of categories) {
		if (
			!isRecord(category) ||
			typeof category.id !== "string" ||
			typeof category.title !== "string" ||
			!Array.isArray(category.files)
		) {
			throw new Error("Invalid library category");
		}
		const files: unknown[] = category.files;
		for (const file of files) {
			if (
				!isRecord(file) ||
				typeof file.path !== "string" ||
				typeof file.title !== "string" ||
				(file.stack !== undefined && typeof file.stack !== "string")
			) {
				throw new Error("Invalid library guide");
			}
		}
	}
	return { categories: categories as LibraryIndex["categories"] };
}

/** Category is learned; guide ranking inside it stays lexical in phase one. */
export function selectLibraryGuides(
	root: string,
	assessment: TaskAssessment,
	request: string,
	minConfidence: number,
): LibrarySelection | undefined {
	const category = assessment.libraryCategory;
	if (!category) return undefined;
	const index = readLibraryIndex(root);
	const candidates = index.categories.find((item) => item.id === LIBRARY_DIRECTORIES[category])?.files ?? [];
	const words = new Set(request.toLowerCase().match(/[\p{L}\p{N}+#.]+/gu) ?? []);
	for (const [alias, term] of Object.entries({
		postgres: "sql",
		postgresql: "sql",
		mysql: "sql",
		index: "indexing",
		indexes: "indexing",
		indices: "indexing",
		transações: "transactions",
		k8s: "kubernetes",
	})) {
		if (words.has(alias)) words.add(term);
	}
	const guides = candidates
		.map((guide) => ({
			guide,
			versionMatched: (guide.title.toLowerCase().match(/\b\d+(?:\.\d+)*\b/g) ?? []).some((version) =>
				words.has(version),
			),
			score:
				(guide.title.toLowerCase().match(/[\p{L}\p{N}+#.]+/gu) ?? []).filter(
					(word) =>
						words.has(word) &&
						word.length > 2 &&
						![
							"complete",
							"professional",
							"guide",
							"guia",
							"completo",
							"book",
							"the",
							"and",
							"for",
							"with",
							"para",
							"com",
							"dos",
							"das",
						].includes(word),
				).length + (guide.stack && words.has(guide.stack.toLowerCase()) ? 3 : 0),
		}))
		.filter((item) => item.score > 0)
		.filter(
			(item, _position, ranked) =>
				!item.guide.stack ||
				item.versionMatched ||
				!ranked.some((other) => other.guide.stack === item.guide.stack && other.versionMatched),
		)
		.sort(
			(a, b) =>
				Number(b.versionMatched) - Number(a.versionMatched) ||
				b.score - a.score ||
				a.guide.path.localeCompare(b.guide.path),
		)
		.slice(0, 2)
		.map((item) => item.guide);
	const injected =
		assessment.source === "laya" &&
		Number.isFinite(assessment.libraryConfidence) &&
		Number.isFinite(minConfidence) &&
		minConfidence >= 0 &&
		minConfidence <= 1 &&
		assessment.libraryConfidence >= minConfidence &&
		guides.length > 0;
	const parts: string[] = [];
	if (injected) {
		let remaining = LIBRARY_CONTEXT_CHARS;
		for (const guide of guides) {
			const text = readFileSync(libraryPath(root, guide.path), "utf8");
			const excerpt = text.slice(0, Math.max(0, remaining - guide.title.length - 100));
			if (!excerpt) break;
			const part = `Reference: ${guide.title}\n${excerpt}${excerpt.length < text.length ? "\n[Excerpt truncated; load the guide for the rest.]" : ""}`;
			parts.push(part);
			remaining -= part.length + 2;
		}
	}
	return { category, guides, injected, content: parts.join("\n\n") };
}
