/**
 * Skill structure audit: checks a skill against progressive disclosure, where `SKILL.md` is a
 * short router to resources the agent loads on demand. An entry file should route to its
 * resources with a reason to load each one, and no resource should be unreachable or missing.
 * The audit reads files; it does not observe a run.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Skill } from "./skills.ts";

export type SkillAuditCode =
	| "monolithic-entry"
	| "oversized-entry"
	| "description-too-long"
	| "unreferenced-resource"
	| "missing-resource"
	| "reference-without-trigger";

export interface SkillAuditFinding {
	code: SkillAuditCode;
	message: string;
	resource?: string;
}

export interface SkillAuditOptions {
	/** Entry size in lines above which a skill is flagged. Default: 300. */
	maxEntryLines?: number;
	/**
	 * Longest description in characters. Default: 300. The description is all the model reads
	 * before deciding to load a skill, and every description is paid for in every request.
	 */
	maxDescriptionChars?: number;
}

/** Words that tell the agent when or why to load a referenced resource. */
const TRIGGER =
	/(?<![\p{L}])(?:when|if|before|after|for|during|to|while|unless|quando|se|antes|depois|para|durante|caso|ao)(?![\p{L}])/iu;

/** The `description` value of an entry file's frontmatter, unquoted, or undefined. */
function frontmatterDescription(entry: string): string | undefined {
	const frontmatter = entry.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
	const value = frontmatter?.match(/^description:[ \t]*(.*)$/m)?.[1].trim();
	if (!value) return undefined;
	return value.replace(/^(["'])([\s\S]*)\1$/, "$2");
}

/** Directories that conventionally hold a skill's resources. */
const RESOURCE_DIRS = new Set(["references", "reference", "scripts", "assets", "templates", "examples"]);

/**
 * Relative resource paths an entry file references, from Markdown links and code spans.
 *
 * A code span is a resource only under a directory of the skill (`resourceDirs`) or a conventional
 * resource directory: `docs/report.pdf` in backticks names a file the skill tells the agent to
 * write, not one it ships.
 */
function referencedResources(
	entry: string,
	resourceDirs: ReadonlySet<string> = RESOURCE_DIRS,
): Array<{ path: string; line: string }> {
	const found: Array<{ path: string; line: string }> = [];
	const isRelative = (candidate: string) =>
		!/^[a-z]+:/i.test(candidate) && !candidate.startsWith("/") && !candidate.startsWith("#");
	const add = (candidate: string, line: string) => {
		const path = candidate.replace(/^\.\//, "");
		if (!found.some((item) => item.path === path)) found.push({ path, line });
	};
	for (const line of entry.split("\n")) {
		for (const match of line.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
			if (isRelative(match[1])) add(match[1], line);
		}
		for (const match of line.matchAll(/`([^`\s]+\/[^`\s]+\.[A-Za-z0-9]+)`/g)) {
			const directory = match[1].replace(/^\.\//, "").split("/")[0].toLowerCase();
			if (isRelative(match[1]) && resourceDirs.has(directory)) add(match[1], line);
		}
	}
	return found;
}

/**
 * Audit a skill's organization for progressive disclosure.
 *
 * @param entry Content of the entry file.
 * @param resources Other files in the skill directory, relative, with forward slashes.
 */
export function auditSkill(
	entry: string,
	resources: readonly string[],
	options: SkillAuditOptions = {},
): SkillAuditFinding[] {
	const findings: SkillAuditFinding[] = [];
	const maxEntryLines = options.maxEntryLines ?? 300;
	const lines = entry.split("\n").length;
	if (resources.length === 0 && lines > maxEntryLines) {
		findings.push({
			code: "monolithic-entry",
			message: `Entry file has ${lines} lines and no resources. Consider a short router entry with references and scripts loaded on demand; keep strict formats, thresholds, and numeric contracts in the entry.`,
		});
	} else if (lines > maxEntryLines) {
		findings.push({
			code: "oversized-entry",
			message: `Entry file has ${lines} lines although the skill has resources. Move detail the current step does not need into them and keep the entry a router of at most ${maxEntryLines} lines.`,
		});
	}

	const maxDescriptionChars = options.maxDescriptionChars ?? 300;
	const description = frontmatterDescription(entry);
	if (description && description.length > maxDescriptionChars) {
		findings.push({
			code: "description-too-long",
			message: `Description has ${description.length} characters (limit ${maxDescriptionChars}). State the situation that should trigger the skill, not its contents.`,
		});
	}

	const resourceDirs = new Set(RESOURCE_DIRS);
	for (const resource of resources) {
		if (resource.includes("/")) resourceDirs.add(resource.split("/")[0].toLowerCase());
	}
	const referenced = referencedResources(entry, resourceDirs);
	const available = new Set(resources.map((resource) => resource.toLowerCase()));
	for (const { path, line } of referenced) {
		if (!available.has(path.toLowerCase())) {
			findings.push({
				code: "missing-resource",
				resource: path,
				message: `Entry references ${path}, which does not exist.`,
			});
		} else if (!TRIGGER.test(line.replace(/\]\([^)]*\)|`[^`]*`/g, " "))) {
			findings.push({
				code: "reference-without-trigger",
				resource: path,
				message: `Entry references ${path} without saying when to load it. State the step or condition that needs it.`,
			});
		}
	}

	const referencedSet = new Set(referenced.map((item) => item.path.toLowerCase()));
	for (const resource of resources) {
		const lower = resource.toLowerCase();
		const coveredByDirectory = [...referencedSet].some((path) => lower.startsWith(`${path.replace(/\/$/, "")}/`));
		if (!referencedSet.has(lower) && !coveredByDirectory) {
			findings.push({
				code: "unreferenced-resource",
				resource,
				message: `${resource} is never referenced by the entry file, so the agent has no route to it.`,
			});
		}
	}
	return findings;
}

/** Files of a skill directory, relative with forward slashes. Bounded so a huge directory cannot stall the audit. */
function listSkillResources(skill: Skill, limit = 200): string[] {
	const files: string[] = [];
	const visit = (dir: string, depth: number) => {
		if (depth > 4 || files.length >= limit) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path, depth + 1);
			else if (path !== skill.filePath) files.push(relative(skill.baseDir, path).replace(/\\/g, "/"));
		}
	};
	visit(skill.baseDir, 0);
	return files;
}

/**
 * Progressive-disclosure findings for a skill. Only `SKILL.md` skills own their directory; a
 * loose Markdown skill shares a skills root with other skills, so it has no resources to audit.
 * Unreadable skills yield no findings.
 */
export function auditSkillOnDisk(skill: Skill): string[] {
	if (basename(skill.filePath) !== "SKILL.md") return [];
	try {
		const resources = listSkillResources(skill);
		return auditSkill(readFileSync(skill.filePath, "utf8"), resources).map((finding) => finding.message);
	} catch {
		return [];
	}
}

/** One line per finding, prefixed with the skill name, or a single line when every skill passes. */
export function describeSkillAudit(skills: readonly Skill[]): string[] {
	const lines = skills.flatMap((skill) => auditSkillOnDisk(skill).map((finding) => `${skill.name}: ${finding}`));
	return lines.length > 0 ? lines : [`${skills.length} skills audited, no findings`];
}
