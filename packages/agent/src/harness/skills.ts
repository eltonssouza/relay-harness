/**
 * Pillar 4: skills as a runtime control surface.
 *
 * Problem: with the same knowledge, a skill organized as a short router `SKILL.md` plus
 * on-demand references and scripts (progressive disclosure) changed how the agent worked:
 * resources used per run rose from 1.18 to 3.85, skill use spread across the trajectory
 * (20.7% -> 48.4% of runs), and resources that led to an action rose from 76.0% to 84.6%
 * (SkillJuror, 2026). The pass-rate gain (+4.1 points) depended on the task: it helped where
 * a resource converts into a checkable action, and hurt where many files add a "fanout tax" to
 * strict-format work. A harness that treats skills as plain documents cannot see any of this.
 *
 * Solution:
 * - `SkillUsageTracker` observes tool calls and records which skill resources were loaded, when
 *   in the run, and whether each load was followed by an action (Effective Resource Uptake).
 * - `auditSkill` checks a skill's structure against progressive disclosure: an entry file that
 *   routes to its resources with a reason to load each one, and no unreachable or missing files.
 */

import { isMutation, type ToolEffect } from "./effects.ts";

export interface SkillDescriptor {
	name: string;
	/** Directory that holds the skill's entry file and resources. */
	baseDir: string;
	/** Absolute path of the entry file (`SKILL.md`). */
	filePath: string;
}

export type SkillResourceKind = "entry" | "reference" | "script";

export interface SkillResourceEvent {
	skill: string;
	/** Resource path relative to the skill directory, with forward slashes. */
	resource: string;
	kind: SkillResourceKind;
	/** Index of the tool call in the run. */
	step: number;
	/** Whether the load was followed by an action within the uptake window. Set by `report()`. */
	effective?: boolean;
}

export interface SkillUsage {
	skill: string;
	events: number;
	/** Distinct resources used. */
	fanout: number;
	/** Share of events followed by an action. */
	effectiveUptake: number;
	/** Share of events in the first, middle, and last third of the run's tool calls. */
	phases: { early: number; middle: number; late: number };
	/** Resources loaded more than once. */
	revisits: number;
}

export interface SkillUsageReport {
	toolCalls: number;
	skills: SkillUsage[];
	events: SkillResourceEvent[];
}

export interface SkillUsageTrackerOptions {
	/** Skills to observe. Called on every tool call, so skill reloads are picked up. */
	skills: () => readonly SkillDescriptor[];
	/** Tool calls after a resource load in which an action counts as uptake. Default: 3. */
	uptakeWindow?: number;
}

const SCRIPT_PATH = /\.(?:sh|bash|ps1|py|js|mjs|cjs|ts|rb|pl)$/i;

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Normalized path relative to `baseDir`, or undefined when outside it. Case-insensitive, as on Windows and macOS. */
function relativeTo(baseDir: string, path: string): string | undefined {
	const base = normalizePath(baseDir).toLowerCase();
	const normalized = normalizePath(path);
	const lower = normalized.toLowerCase();
	if (lower === base) return "";
	return lower.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : undefined;
}

/** Observes how skills are used during agent runs. */
export class SkillUsageTracker {
	private readonly getSkills: () => readonly SkillDescriptor[];
	private readonly uptakeWindow: number;
	private events: SkillResourceEvent[] = [];
	/** Per tool call of the run: whether it was an action and whether it failed. */
	private steps: Array<{ action: boolean; ok: boolean }> = [];

	constructor(options: SkillUsageTrackerOptions) {
		this.getSkills = options.skills;
		this.uptakeWindow = options.uptakeWindow ?? 3;
	}

	/** Start a new run. */
	beginRun(): void {
		this.events = [];
		this.steps = [];
	}

	/** Record an executed tool call. */
	recordToolCall(effect: ToolEffect, isError: boolean): void {
		const step = this.steps.length;
		const loaded = this.match(effect);
		const action = isMutation(effect.kind) || effect.kind === "verify" || effect.kind === "execute";
		this.steps.push({ action: action && loaded.length === 0, ok: !isError });
		for (const { skill, resource } of loaded) {
			const entry = skill.filePath && relativeTo(skill.baseDir, skill.filePath) === resource;
			const kind: SkillResourceKind = entry
				? "entry"
				: SCRIPT_PATH.test(resource) && effect.kind !== "read"
					? "script"
					: "reference";
			this.events.push({ skill: skill.name, resource, kind, step });
		}
	}

	/** Usage of the current run. */
	report(): SkillUsageReport {
		const total = this.steps.length;
		for (const event of this.events) {
			if (event.kind === "script") {
				event.effective = this.steps[event.step]?.ok ?? false;
				continue;
			}
			const window = this.steps.slice(event.step + 1, event.step + 1 + this.uptakeWindow);
			event.effective = window.some((step) => step.action);
		}

		const bySkill = new Map<string, SkillResourceEvent[]>();
		for (const event of this.events) {
			const list = bySkill.get(event.skill) ?? [];
			list.push(event);
			bySkill.set(event.skill, list);
		}
		const skills = [...bySkill].map(([skill, events]): SkillUsage => {
			const resources = new Map<string, number>();
			for (const event of events) resources.set(event.resource, (resources.get(event.resource) ?? 0) + 1);
			const phase = (from: number, to: number) =>
				events.filter((event) => total > 0 && event.step / total >= from && event.step / total < to).length /
				events.length;
			return {
				skill,
				events: events.length,
				fanout: resources.size,
				effectiveUptake: events.filter((event) => event.effective).length / events.length,
				phases: {
					early: phase(0, 1 / 3),
					middle: phase(1 / 3, 2 / 3),
					late: phase(2 / 3, Number.POSITIVE_INFINITY),
				},
				revisits: [...resources.values()].filter((count) => count > 1).length,
			};
		});
		return { toolCalls: total, skills, events: this.events.map((event) => ({ ...event })) };
	}

	private match(effect: ToolEffect): Array<{ skill: SkillDescriptor; resource: string }> {
		const matches: Array<{ skill: SkillDescriptor; resource: string }> = [];
		for (const skill of this.getSkills()) {
			const candidates = [...effect.paths];
			if (effect.command) {
				const base = normalizePath(skill.baseDir).toLowerCase();
				for (const token of effect.command.split(/[\s"'`=]+/)) {
					if (normalizePath(token).toLowerCase().startsWith(base)) candidates.push(token);
				}
			}
			for (const candidate of candidates) {
				const resource = relativeTo(skill.baseDir, candidate);
				if (resource) matches.push({ skill, resource });
			}
		}
		return matches;
	}
}

// ============================================================================
// Structure audit
// ============================================================================

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
export function referencedResources(
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
