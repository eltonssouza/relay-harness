/**
 * Reference behavior of project trust (`src/core/trust-manager.ts`, `project-trust.ts`), for the
 * Rust port: `settings/trust.json` holds the trust store's answers and files over a tree of
 * project folders, the trust options offered for a folder, which folders hold resources that need
 * trust, and `resolveProjectTrusted` with scripted answers to the trust prompt. The options for the
 * file system's root are recorded with the root as `<fs-root>`.
 *
 * The temporary directory becomes `<root>`, with `/` after it. `HOME` is a folder of the tree
 * while recording, so the user's own `~/.agents/skills` is a known path.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { resolveProjectTrusted } from "../../src/core/project-trust.ts";
import {
	getProjectTrustOptions,
	getProjectTrustParentPath,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "../../src/core/trust-manager.ts";

/** `<root>` for the tree, `/` after it. */
function portable(value: unknown, root: string): unknown {
	if (typeof value === "string") {
		const escaped = JSON.stringify(root).slice(1, -1);
		return value
			.split(escaped)
			.join("<root>")
			.split(root)
			.join("<root>")
			.replace(/<root>[^"'\s)]*/g, (path) => path.replace(/\\\\/g, "/").replaceAll("\\", "/"));
	}
	if (Array.isArray(value)) return value.map((item) => portable(item, root));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item, root)]));
	}
	return value;
}

const outcome = (run: () => unknown) => {
	try {
		const value = run();
		return { result: value === undefined ? "<undefined>" : value };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// V8 words JSON syntax errors its own way; only the store's prefix is compared.
		const syntax = message.match(/^(Failed to read trust store .*?): /);
		return syntax ? { syntaxError: syntax[1] } : { error: message };
	}
};

/** Folders of the tree, relative to the root; a trailing `/` makes a folder, else a file. */
const TREE = [
	"home/.agents/skills/",
	"work/a/b/c/",
	"work/plain/",
	"work/settings/.relay/settings.json",
	"work/mcp/.relay/mcp.json",
	"work/skills/.relay/skills/",
	"work/system/.relay/SYSTEM.md",
	"work/append/.relay/APPEND_SYSTEM.md",
	"work/other/.relay/notes.md",
	"work/agents/.agents/skills/",
	"work/agents/deep/inside/",
	"home/project/",
];

interface StoreStep {
	op: "get" | "getEntry" | "set" | "setMany" | "file" | "writeFile" | "writeEntries";
	cwd?: string;
	decision?: boolean | null;
	updates?: { path: string; decision: boolean | null }[];
	content?: string;
	/** Decisions written as the file, keyed by folders of the tree. */
	entries?: Record<string, boolean | null>;
}

const STORE_SCRIPT: StoreStep[] = [
	{ op: "get", cwd: "work/a/b/c" },
	{ op: "file" },
	{ op: "set", cwd: "work/a", decision: true },
	{ op: "getEntry", cwd: "work/a/b/c" },
	{ op: "set", cwd: "work/a/b", decision: false },
	{ op: "getEntry", cwd: "work/a/b/c" },
	{ op: "get", cwd: "work/a/b/../b" },
	{ op: "get", cwd: "work/plain" },
	{
		op: "setMany",
		updates: [
			{ path: "work/plain", decision: true },
			{ path: "work/a/b", decision: null },
			{ path: "work", decision: false },
		],
	},
	{ op: "getEntry", cwd: "work/a/b/c" },
	{ op: "getEntry", cwd: "work/zz" },
	{ op: "file" },
	{ op: "writeFile", content: '{"/z": true, "/a": null}' },
	{ op: "set", cwd: "work/plain", decision: true },
	{ op: "file" },
	{ op: "writeEntries", entries: { "work/plain": null, work: true } },
	{ op: "getEntry", cwd: "work/plain" },
	{ op: "writeFile", content: "{ broken" },
	{ op: "get", cwd: "work/plain" },
	{ op: "writeFile", content: "[true]" },
	{ op: "get", cwd: "work/plain" },
	{ op: "writeFile", content: '{"/x": "yes"}' },
	{ op: "set", cwd: "work/plain", decision: true },
	{ op: "writeFile", content: "﻿{}" },
	{ op: "get", cwd: "work/plain" },
];

/** A scripted `resolveProjectTrusted`: the stored decision, settings and the prompt's answer. */
interface ResolveCase {
	name: string;
	cwd: string;
	trustOverride?: boolean;
	defaultProjectTrust?: "ask" | "always" | "never";
	stored?: Record<string, boolean>;
	hasUI?: boolean;
	/** The first label of the prompt starting with this. */
	answer?: string;
}

const RESOLVE_CASES: ResolveCase[] = [
	{ name: "override", cwd: "work/settings", trustOverride: false, hasUI: true },
	{ name: "no resources", cwd: "work/plain", defaultProjectTrust: "never" },
	{ name: "stored decision", cwd: "work/settings", stored: { "work/settings": false }, defaultProjectTrust: "always" },
	{ name: "stored on a parent", cwd: "work/settings", stored: { work: true } },
	{ name: "always", cwd: "work/settings", defaultProjectTrust: "always" },
	{ name: "never", cwd: "work/settings", defaultProjectTrust: "never" },
	{ name: "never with a UI", cwd: "work/settings", defaultProjectTrust: "never", hasUI: true, answer: "Trust" },
	{ name: "no UI", cwd: "work/settings" },
	{ name: "trust", cwd: "work/settings", hasUI: true, answer: "Trust" },
	{ name: "trust the parent", cwd: "work/settings", hasUI: true, answer: "Trust parent folder" },
	{ name: "session only", cwd: "work/settings", hasUI: true, answer: "Trust (this session only)" },
	{ name: "do not trust", cwd: "work/settings", hasUI: true, answer: "Do not trust" },
	{ name: "distrust for the session", cwd: "work/settings", hasUI: true, answer: "Do not trust (this session only)" },
	{ name: "dismissed", cwd: "work/settings", hasUI: true },
];

function makeTree(root: string): void {
	for (const path of TREE) {
		const full = join(root, path);
		if (path.endsWith("/")) mkdirSync(full, { recursive: true });
		else {
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, "");
		}
	}
}

export async function trustJson(): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "relay-trust-"));
	const savedHome = process.env.HOME;
	process.env.HOME = join(root, "home");
	try {
		makeTree(root);
		const at = (path: string) => join(root, path);
		const agentDir = at("agent");
		const store = new ProjectTrustStore(agentDir);
		const trustFile = join(agentDir, "trust.json");
		const steps = STORE_SCRIPT.map((step) => {
			switch (step.op) {
				case "get":
					return { step, ...outcome(() => store.get(at(step.cwd!))) };
				case "getEntry":
					return { step, ...outcome(() => store.getEntry(at(step.cwd!)) ?? null) };
				case "set":
					return { step, ...outcome(() => store.set(at(step.cwd!), step.decision!)) };
				case "setMany":
					return {
						step,
						...outcome(() =>
							store.setMany(step.updates!.map((update) => ({ ...update, path: at(update.path) }))),
						),
					};
				case "file":
					return { step, ...outcome(() => readFileSync(trustFile, "utf8")) };
				case "writeFile":
					writeFileSync(trustFile, step.content!);
					return { step, result: null };
				case "writeEntries": {
					const entries = Object.entries(step.entries!).map(([path, value]) => [at(path), value]);
					writeFileSync(trustFile, JSON.stringify(Object.fromEntries(entries)));
					return { step, result: null };
				}
				default:
					throw new Error(`unknown step ${step.op}`);
			}
		});
		const folders = ["work/a/b/c", "work/settings", "home/project"];
		const options = folders.map((folder) => ({
			folder,
			parent: getProjectTrustParentPath(at(folder)) ?? "<undefined>",
			options: getProjectTrustOptions(at(folder)),
			withSessionOnly: getProjectTrustOptions(at(folder), { includeSessionOnly: true }),
		}));
		// The file system's root has no parent; it becomes `<fs-root>`.
		const fsRoot = parse(root).root;
		const rootOptions = JSON.parse(
			JSON.stringify({
				parent: getProjectTrustParentPath(fsRoot) ?? "<undefined>",
				options: getProjectTrustOptions(fsRoot),
			}),
			(_key, value) => (value === fsRoot ? "<fs-root>" : value),
		);
		const resources = [
			"work/plain",
			"work/settings",
			"work/mcp",
			"work/skills",
			"work/system",
			"work/append",
			"work/other",
			"work/agents",
			"work/agents/deep/inside",
			"home",
			"home/project",
			"missing/folder",
		].map((folder) => ({ folder, result: hasTrustRequiringProjectResources(at(folder)) }));
		const resolved: unknown[] = [];
		for (const testCase of RESOLVE_CASES) {
			const caseAgentDir = at(`agents/${resolved.length}`);
			const caseStore = new ProjectTrustStore(caseAgentDir);
			for (const [path, decision] of Object.entries(testCase.stored ?? {})) caseStore.set(at(path), decision);
			const prompts: unknown[] = [];
			const trusted = await resolveProjectTrusted({
				cwd: at(testCase.cwd),
				trustStore: caseStore,
				trustOverride: testCase.trustOverride,
				defaultProjectTrust: testCase.defaultProjectTrust,
				projectTrustContext: {
					cwd: at(testCase.cwd),
					mode: "tui",
					hasUI: testCase.hasUI ?? false,
					ui: {
						select: async (title: string, labels: string[]) => {
							prompts.push({ title, labels });
							const answer = testCase.answer;
							return answer === undefined ? undefined : labels.find((label) => label.startsWith(answer));
						},
					} as never,
				},
			});
			const file = join(caseAgentDir, "trust.json");
			let stored: unknown = "<absent>";
			try {
				stored = readFileSync(file, "utf8");
			} catch {}
			resolved.push({ ...testCase, trusted, prompts, file: stored });
		}
		return `${JSON.stringify(portable({ tree: TREE, steps, options, rootOptions, resources, resolved }, root), null, "\t")}\n`;
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		rmSync(root, { recursive: true, force: true });
	}
}
