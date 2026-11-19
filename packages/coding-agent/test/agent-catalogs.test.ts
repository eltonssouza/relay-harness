import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentsCommand } from "../src/cli/agents-command.ts";
import {
	INSTALL_RECORD,
	type InstallRecord,
	installCatalog,
	installedCatalogSources,
	marketplaceSources,
} from "../src/extensions/subagents/catalogs.ts";
import { agentPrompt, loadAgentCatalog } from "../src/extensions/subagents/definitions.ts";

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

const definition = (name: string, body: string) =>
	`---\nname: ${name}\ndescription: ${name} agent\ntools: Read, Grep, Glob, Bash\nmodel: sonnet\n---\n${body}\n`;

/** A catalog of two agents in the general-agents layout, with files an install leaves out. */
function createCatalog(root: string): void {
	write(
		join(root, ".claude-plugin", "marketplace.json"),
		JSON.stringify({
			name: "mini",
			plugins: [
				{ name: "alpha", source: "./01_group/_agents/alpha" },
				{ name: "beta", source: "./02_group/_agents/beta" },
				{ name: "outside", source: "../outside" },
			],
		}),
	);
	const alpha = join(root, "01_group", "_agents", "alpha");
	write(join(alpha, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "alpha", version: "1.0.0" }));
	write(join(alpha, ".claude-plugin", "icon.png"), "png");
	write(join(alpha, "agents", "alpha.md"), definition("alpha", "You are alpha."));
	write(join(alpha, ".github", "agents", "alpha.agent.md"), "copilot copy");
	write(join(alpha, "tests", "test_alpha.py"), "assert True");
	write(join(alpha, "scripts", "lookup.py"), "print('ok')");
	const beta = join(root, "02_group", "_agents", "beta");
	write(join(beta, "agents", "beta.md"), definition("beta", "Run <PKG>/scripts/route.py; agents live under <ROOT>."));
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitAll(root: string): string {
	git(["init", "--quiet"], root);
	git(["add", "."], root);
	git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "catalog"], root);
	return git(["rev-parse", "HEAD"], root);
}

describe("agent catalogs", () => {
	const directories: string[] = [];
	const temp = () => {
		const directory = mkdtempSync(join(tmpdir(), "relay-catalog-"));
		directories.push(directory);
		return directory;
	};
	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
	});

	it("installs a local copy without tests, icons and Copilot copies, and fills the placeholders", () => {
		const source = temp();
		const agentDir = temp();
		createCatalog(source);

		const result = installCatalog({ agentDir, from: source });

		expect(result.catalog.agents.map((agent) => agent.name)).toEqual(["alpha", "beta"]);
		const alpha = join(result.directory, "01_group", "_agents", "alpha");
		expect(existsSync(join(alpha, "scripts", "lookup.py"))).toBe(true);
		expect(existsSync(join(alpha, "tests"))).toBe(false);
		expect(existsSync(join(alpha, ".github"))).toBe(false);
		expect(existsSync(join(alpha, ".claude-plugin", "icon.png"))).toBe(false);
		expect(existsSync(join(alpha, ".claude-plugin", "plugin.json"))).toBe(true);
		const record = JSON.parse(readFileSync(join(result.directory, INSTALL_RECORD), "utf8")) as InstallRecord;
		expect(record.commit).toBeUndefined();
		const beta = result.catalog.agents.find((agent) => agent.name === "beta");
		expect(beta && agentPrompt(beta)).toBe(
			`Run ${join(result.directory, "02_group", "_agents", "beta")}/scripts/route.py; agents live under ${result.directory}.`,
		);
		// The plugin whose source points outside the catalog is not loaded.
		expect(marketplaceSources(result.directory)).toHaveLength(2);
	});

	it("refuses a git checkout that is not at the pinned commit", () => {
		const source = temp();
		createCatalog(source);
		commitAll(source);

		expect(() =>
			installCatalog({
				agentDir: temp(),
				from: source,
				pin: { name: "mini", repository: source, commit: "0".repeat(40) },
			}),
		).toThrow(`but Relay installs mini at ${"0".repeat(40)}`);
	});

	it("fetches the pinned commit and replaces an earlier install", () => {
		const repository = temp();
		const agentDir = temp();
		createCatalog(repository);
		const commit = commitAll(repository);
		const pin = { name: "mini", repository, commit };

		const first = installCatalog({ agentDir, pin });
		writeFileSync(join(first.directory, "stale.txt"), "left over");
		const second = installCatalog({ agentDir, pin });

		expect(second.commit).toBe(commit);
		expect(existsSync(join(second.directory, "stale.txt"))).toBe(false);
		expect(existsSync(join(second.directory, ".git"))).toBe(false);
		expect(installedCatalogSources(agentDir).map((source) => source.packageRoot)).toEqual([
			join(agentDir, "agent-catalogs", "mini", "01_group", "_agents", "alpha"),
			join(agentDir, "agent-catalogs", "mini", "02_group", "_agents", "beta"),
		]);
	});

	it("lets a user definition replace a catalog definition of the same name", () => {
		const source = temp();
		const agentDir = temp();
		createCatalog(source);
		const installed = installCatalog({ agentDir, from: source });
		write(join(agentDir, "agents", "alpha.md"), definition("alpha", "Your own alpha."));

		const catalog = loadAgentCatalog([
			{ directory: join(agentDir, "agents") },
			...marketplaceSources(installed.directory),
		]);

		expect(catalog.agents.find((agent) => agent.name === "alpha")?.prompt).toBe("Your own alpha.");
	});

	it("installs and lists through relay agents", async () => {
		const source = temp();
		const agentDir = temp();
		createCatalog(source);
		const lines: string[] = [];
		const errors: string[] = [];
		const options = {
			agentDir,
			cwd: temp(),
			log: (line: string) => lines.push(line),
			error: (line: string) => errors.push(line),
		};

		// Help never installs.
		expect(await runAgentsCommand(["install", "--help"], options)).toBe(0);
		expect(lines[0]).toMatch(/^Usage:/);
		expect(await runAgentsCommand(["install", "--from"], options)).toBe(1);
		expect(errors).toEqual(["--from needs a path"]);
		// The command installs the catalog pinned in Relay, so the copy is named general-agents.
		expect(await runAgentsCommand(["install", "--from", source], options)).toBe(0);
		expect(lines.some((line) => line.startsWith("Installed 2 agents into "))).toBe(true);
	});
});
