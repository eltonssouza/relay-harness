/**
 * Agent catalogs in the Claude Code plugin format, and the pinned general-agents install.
 *
 * A catalog is a folder with `.claude-plugin/marketplace.json`, whose `plugins` name package
 * folders; each package keeps its definitions in `agents/*.md`. Installed catalogs live in
 * `<agent-dir>/agent-catalogs/<name>/`, written by `relay agents install`.
 *
 * general-agents is installed from a commit pinned here, not from a branch: what the agents read
 * and run is the reviewed revision. Its tests, icons and GitHub Copilot copies are left out.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { type AgentCatalog, type DefinitionSource, loadAgentCatalog } from "./definitions.ts";

export interface CatalogPin {
	name: string;
	repository: string;
	commit: string;
}

/** The general-agents revision Relay installs. Update it together with a review of the diff. */
export const GENERAL_AGENTS: CatalogPin = {
	name: "general-agents",
	repository: "https://github.com/eltonssouza/general-agents.git",
	commit: "fdf6282b73f4ff8112f0e6bd69df6c0ee7c2f72f",
};

/** Written into an installed catalog: where it came from. */
export interface InstallRecord {
	repository: string;
	/** The installed commit; absent for a copy without git history. */
	commit?: string;
	installedAt: string;
}

export const INSTALL_RECORD = ".relay-install.json";

export function catalogsDirectory(agentDir: string): string {
	return join(agentDir, "agent-catalogs");
}

interface Marketplace {
	plugins?: Array<{ name?: unknown; source?: unknown }>;
}

/** Definition sources of a catalog folder: one per package with an `agents/` folder inside the catalog. */
export function marketplaceSources(root: string): DefinitionSource[] {
	const file = join(root, ".claude-plugin", "marketplace.json");
	if (!existsSync(file)) return [];
	const marketplace = JSON.parse(readFileSync(file, "utf8")) as Marketplace;
	const sources: DefinitionSource[] = [];
	for (const plugin of marketplace.plugins ?? []) {
		if (typeof plugin.source !== "string") continue;
		const packageRoot = resolve(root, plugin.source);
		// A source outside the catalog is not part of what was installed.
		const inside = relative(root, packageRoot);
		if (inside.startsWith("..") || inside === "") continue;
		sources.push({ directory: join(packageRoot, "agents"), packageRoot, collectionRoot: root });
	}
	return sources;
}

/** Definition sources of every installed catalog, in name order. */
export function installedCatalogSources(agentDir: string): DefinitionSource[] {
	const directory = catalogsDirectory(agentDir);
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.sort()
		.flatMap((name) => marketplaceSources(join(directory, name)));
}

export function readInstallRecord(root: string): InstallRecord | undefined {
	const file = join(root, INSTALL_RECORD);
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as InstallRecord) : undefined;
}

/** Runs git and returns its trimmed output; throws when git fails. */
export type GitRunner = (args: string[], cwd: string) => string;

const runGit: GitRunner = (args, cwd) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Files an installed catalog leaves out: git data, test suites, icons and GitHub Copilot copies. */
function keep(source: string, path: string): boolean {
	const parts = relative(source, path).split(sep);
	if (parts.some((part) => part === ".git" || part === "tests" || part === ".github")) return false;
	return !(basename(path) === "icon.png" && parts.at(-2) === ".claude-plugin");
}

export interface InstallOptions {
	agentDir: string;
	/** A local copy to install instead of fetching, for offline machines. */
	from?: string;
	pin?: CatalogPin;
	git?: GitRunner;
}

export interface InstallResult {
	directory: string;
	commit?: string;
	catalog: AgentCatalog;
}

/**
 * Install a catalog at its pinned commit, replacing an earlier install. A local copy with git
 * history must be at the pinned commit; one without history is installed as it is.
 */
export function installCatalog(options: InstallOptions): InstallResult {
	const pin = options.pin ?? GENERAL_AGENTS;
	const git = options.git ?? runGit;
	const catalogs = catalogsDirectory(options.agentDir);
	mkdirSync(catalogs, { recursive: true });
	const staging = join(catalogs, `.staging-${pin.name}-${process.pid}-${Date.now()}`);
	const destination = join(catalogs, pin.name);
	try {
		let source: string;
		let commit: string | undefined;
		if (options.from) {
			source = resolve(options.from);
			if (!existsSync(join(source, ".claude-plugin", "marketplace.json"))) {
				throw new Error(`${source} is not an agent catalog: .claude-plugin/marketplace.json is missing`);
			}
			if (existsSync(join(source, ".git"))) {
				commit = git(["rev-parse", "HEAD"], source);
				if (commit !== pin.commit) {
					throw new Error(
						`${source} is at ${commit}, but Relay installs ${pin.name} at ${pin.commit}. Run \`git -C "${source}" checkout ${pin.commit}\` first.`,
					);
				}
			}
		} else {
			source = join(staging, "checkout");
			mkdirSync(source, { recursive: true });
			git(["init", "--quiet"], source);
			git(["fetch", "--quiet", "--depth", "1", pin.repository, pin.commit], source);
			git(["checkout", "--quiet", "FETCH_HEAD"], source);
			commit = git(["rev-parse", "HEAD"], source);
			if (commit !== pin.commit) throw new Error(`fetched ${commit} instead of the pinned ${pin.commit}`);
		}
		const tree = join(staging, "tree");
		cpSync(source, tree, { recursive: true, filter: (path) => keep(source, path) });
		const record: InstallRecord = {
			repository: options.from ? source : pin.repository,
			...(commit ? { commit } : {}),
			installedAt: new Date().toISOString(),
		};
		writeFileSync(join(tree, INSTALL_RECORD), `${JSON.stringify(record, null, "\t")}\n`);
		const catalog = loadAgentCatalog(marketplaceSources(tree));
		if (catalog.agents.length === 0) throw new Error(`${source} has no agent definitions`);
		rmSync(destination, { recursive: true, force: true, maxRetries: 5 });
		mkdirSync(dirname(destination), { recursive: true });
		renameSync(tree, destination);
		return { directory: destination, commit, catalog: loadAgentCatalog(marketplaceSources(destination)) };
	} finally {
		rmSync(staging, { recursive: true, force: true, maxRetries: 5 });
	}
}

/** Whether a Python 3 interpreter is on PATH; general-agents' skill scripts need one. */
export function hasPython(): boolean {
	for (const command of ["python3", "python"]) {
		try {
			if (
				execFileSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).includes(
					"Python 3",
				)
			) {
				return true;
			}
		} catch {
			// Not on PATH, or not runnable.
		}
	}
	return false;
}
