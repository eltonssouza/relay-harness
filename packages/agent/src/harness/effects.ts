/**
 * Tool effect classification shared by the harness pillars.
 *
 * The pillars reason about what a tool call does to the world, not about which model issued it:
 * alignment gates destructive and external effects, evidence checks that mutations are followed
 * by verification, and context engineering detects superseded reads. Classification is
 * deterministic and cheap.
 *
 * Shell commands are classified in two ways. Destructive and external effects match text, so a
 * command that only mentions an operation (`echo "git push"`) also matches: a false positive
 * costs one authorization prompt, a false negative could cost unrecoverable work. Verification is
 * the opposite: it is evidence, so it is recognized only by the program a command runs
 * (`npm run check`, `vitest`), never by words that appear in it (`ls build`, `echo test`).
 */

import type { AgentToolCall } from "../types.ts";
import { parseShell, programName, type ShellCommand } from "./shell.ts";

/**
 * What a tool call does.
 *
 * - `read`: observes state (files, search, listings).
 * - `write`: changes local working state in a reversible way (edit, write a file).
 * - `execute`: runs a command whose effect is not otherwise known.
 * - `verify`: runs a check whose outcome is evidence (tests, type check, build, lint).
 * - `destructive`: changes local state in a way that is hard to reverse (history rewrite, recursive delete).
 * - `external`: changes state outside the workspace or runs code on a developer's behalf elsewhere
 *   (push, publish, deploy, a file outside the workspace, a hook or credential file).
 */
export type ToolEffectKind = "read" | "write" | "execute" | "verify" | "destructive" | "external";

export interface ToolEffect {
	kind: ToolEffectKind;
	/** Workspace paths the call reads or writes, as given in the arguments. */
	paths: string[];
	/** Shell command, for shell tools. */
	command?: string;
	/** Why a `destructive` or `external` classification was made. */
	reason?: string;
	/**
	 * For `verify`: directories the check covers (`cd packages/a && npm test`). Absent when the
	 * check covers the whole workspace.
	 */
	scope?: string[];
}

/** Where the session runs, so paths can be judged against the workspace. */
export interface ClassifyContext {
	/** Workspace root. Without it, no path counts as outside the workspace. */
	cwd?: string;
	/** Home directory, for `~` paths. */
	home?: string;
}

/** Classifies one tool call. Return undefined to fall back to the default classification. */
export type ToolEffectClassifier = (toolCall: AgentToolCall) => ToolEffect | undefined;

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "search", "list", "cat", "view"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "multi_edit", "apply_patch", "patch", "notebook_edit"]);
const SHELL_TOOLS = new Set(["bash", "shell", "sh", "powershell", "pwsh", "exec", "terminal", "run"]);

interface CommandRule {
	pattern: RegExp;
	kind: "destructive" | "external";
	reason: string;
}

/** `git` with its global options (`-C dir`, `--no-pager`, `--git-dir=x`) before the subcommand. */
const GIT = String.raw`\bgit(?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?)*`;
const git = (rest: string) => new RegExp(`${GIT}\\s+${rest}`);

/**
 * Command patterns for effects that require authorization. Ordered: the first match wins, so
 * the force-push rule precedes the plain push rule.
 */
const COMMAND_RULES: CommandRule[] = [
	{
		pattern: git(String.raw`push\b[^\n;&|]*(?:\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)`),
		kind: "destructive",
		reason: "force push rewrites remote history",
	},
	{
		pattern: git(String.raw`reset\s+[^\n;&|]*--hard\b`),
		kind: "destructive",
		reason: "git reset --hard discards uncommitted work",
	},
	{
		pattern: git(String.raw`clean\s+[^\n;&|]*-[a-zA-Z]*f`),
		kind: "destructive",
		reason: "git clean -f deletes untracked files",
	},
	{
		pattern: git(String.raw`checkout\s+(?:--\s+)?\.(?:\s|$)`),
		kind: "destructive",
		reason: "git checkout . discards uncommitted changes",
	},
	{
		pattern: git(String.raw`restore\s+(?:[^\n;&|]*\s)?\.(?:\s|$)`),
		kind: "destructive",
		reason: "git restore . discards uncommitted changes",
	},
	{
		pattern: git(String.raw`stash\s+(?:drop|clear)\b`),
		kind: "destructive",
		reason: "git stash drop/clear deletes stashed work",
	},
	{
		pattern: git(String.raw`branch\s+[^\n;&|]*-D\b`),
		kind: "destructive",
		reason: "git branch -D deletes an unmerged branch",
	},
	{ pattern: git(String.raw`(?:filter-branch|filter-repo)\b`), kind: "destructive", reason: "history rewrite" },
	{
		pattern: git(String.raw`rebase\b(?!\s+--(?:continue|abort|skip|quit)\b)`),
		kind: "destructive",
		reason: "rebase rewrites history",
	},
	{ pattern: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, kind: "destructive", reason: "recursive delete" },
	{ pattern: /\brm\s+(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b/, kind: "destructive", reason: "forced delete" },
	{ pattern: /\b(?:unlink|shred)\s/, kind: "destructive", reason: "irreversible delete" },
	{ pattern: /\bRemove-Item\b[^\n;|]*-Recurse\b/i, kind: "destructive", reason: "recursive delete" },
	{ pattern: /\b(?:rmdir|rd)\s+\/s\b/i, kind: "destructive", reason: "recursive delete" },
	{ pattern: /\bdel\s+[^\n;&|]*\/s\b/i, kind: "destructive", reason: "recursive delete" },
	{ pattern: /\bfind\b[^\n;&|]*\s-delete\b/, kind: "destructive", reason: "find -delete" },
	{
		pattern: /\bfind\b[^\n]*-exec(?:dir)?\s+(?:rm|unlink|shred)\b/,
		kind: "destructive",
		reason: "find -exec deletes what it finds",
	},
	{ pattern: /\bxargs\b[^\n;&|]*\b(?:rm|unlink|shred)\b/, kind: "destructive", reason: "xargs deletes its input" },
	{
		pattern: /\b(?:chmod|chown|chgrp)\s+(?:-\S+\s+)*-[a-zA-Z]*R/,
		kind: "destructive",
		reason: "recursive permission or ownership change",
	},
	{ pattern: /\b(?:mkfs|shred|dd\s+if=)/, kind: "destructive", reason: "low-level disk write" },
	{
		pattern: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
		kind: "destructive",
		reason: "destructive SQL",
	},
	{ pattern: /\bDELETE\s+FROM\s+\S+\s*(?:;|$|")/i, kind: "destructive", reason: "DELETE without WHERE" },
	{
		pattern: /\beval\s+["']?(?:\$\(|`)|\bbase64\s+(?:-d|--decode)\b[^\n]*\|\s*(?:ba|z|da)?sh\b/,
		kind: "destructive",
		reason: "runs a command built at runtime",
	},
	{
		pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/,
		kind: "external",
		reason: "runs downloaded code",
	},
	{ pattern: git(String.raw`push\b`), kind: "external", reason: "git push changes the remote" },
	{ pattern: /\b(?:npm|pnpm|yarn|bun)\s+publish\b/, kind: "external", reason: "package publish" },
	{
		pattern: /\b(?:cargo|twine|gem|dotnet\s+nuget)\s+(?:publish|upload|push)\b/,
		kind: "external",
		reason: "package publish",
	},
	{
		pattern:
			/\bgh\s+(?:pr\s+(?:create|merge|close|comment|review)|issue\s+(?:create|close|comment)|release\s+create|repo\s+(?:create|delete))\b/,
		kind: "external",
		reason: "GitHub write operation",
	},
	{
		pattern:
			/\b(?:kubectl\s+(?:apply|delete|scale|rollout)|helm\s+(?:install|upgrade|uninstall)|terraform\s+(?:apply|destroy)|pulumi\s+(?:up|destroy))\b/,
		kind: "external",
		reason: "infrastructure change",
	},
	{ pattern: /\bdocker\s+push\b/, kind: "external", reason: "image push" },
	{ pattern: /\b(?:vercel|netlify|fly|firebase)\s+deploy\b|\bvercel\s+--prod\b/, kind: "external", reason: "deploy" },
	{
		pattern:
			/\bcurl\b[^\n;&|]*?(?:\s-[a-zA-Z]*[dFT]\b|\s--(?:data(?:-[\w]+)?|form(?:-string)?|upload-file|json)\b|\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--request[= ]\s*(?:POST|PUT|PATCH|DELETE)\b)/,
		kind: "external",
		reason: "remote write request",
	},
	{
		pattern:
			/\bwget\b[^\n;&|]*(?:--post-(?:data|file)|--body-(?:data|file)|--method[= ]\s*(?:POST|PUT|PATCH|DELETE)\b)/,
		kind: "external",
		reason: "remote write request",
	},
	{
		pattern:
			/(?:>>?|\btee\b(?:\s+-a)?)\s*["']?(?:~|\$HOME|\/root|\/home\/[^/\s]+)\/(?:\.ssh\/|\.bashrc|\.zshrc|\.profile|\.bash_profile|\.npmrc|\.gitconfig|\.relay\/)|(?:>>?|\btee\b(?:\s+-a)?)\s*["']?\/etc\//,
		kind: "external",
		reason: "writes a shell, credential or system configuration file",
	},
	{
		pattern:
			/(?:^|[\s;&|(])(?:\.\/|\S*\/)?[\w.-]*(?:deploy|rollout|publish)[\w.-]*\.(?:sh|bash|ps1|py|js|mjs|ts)\b(?![^\n;&|]*--dry-run)/,
		kind: "external",
		reason: "runs a script named like a deployment",
	},
];

/** Interpreters that run code given on the command line. */
const INLINE_INTERPRETERS = new Set([
	"python",
	"python3",
	"py",
	"node",
	"nodejs",
	"deno",
	"bun",
	"ruby",
	"perl",
	"php",
]);
const INLINE_FLAGS = new Set(["-c", "-e", "-p", "--eval", "--print", "-r", "-E"]);

/** What inline code does that needs authorization, by API rather than by program name. */
const INLINE_CODE_RULES: Array<{ pattern: RegExp; kind: "destructive" | "external"; reason: string }> = [
	{
		pattern:
			/\b(?:rmtree|rmSync|rmdirSync|unlinkSync|unlink|os\.remove|os\.rmdir|os\.removedirs|fs\.rm|fs\.promises\.rm|rimraf|File\.delete|FileUtils\.rm|Dir\.rmdir|truncate)\b/,
		kind: "destructive",
		reason: "inline code deletes files",
	},
	{
		pattern:
			/\b(?:requests\.(?:post|put|patch|delete)|urlopen|axios\.(?:post|put|patch|delete)|http\.request|https\.request|smtplib|Net::HTTP\.post|curl_exec|socket\.connect)\b|fetch\([^)]*method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)/,
		kind: "external",
		reason: "inline code sends data to a remote host",
	},
];

/** Basenames of scripts that are checks. */
const CHECK_SCRIPTS = new Set(["test", "ci", "check", "verify", "lint", "build", "validate"]);

/** Test runners: any invocation is a check. */
const TEST_RUNNERS = new Set([
	"vitest",
	"jest",
	"mocha",
	"ava",
	"tap",
	"pytest",
	"py.test",
	"tox",
	"nox",
	"rspec",
	"phpunit",
	"ctest",
	"bats",
	"flake8",
	"pylint",
	"mypy",
	"pyright",
	"eslint",
	"stylelint",
	"oxlint",
	"golangci-lint",
	"shellcheck",
	"tsc",
	"ruff",
]);

/** Programs whose check is selected by a subcommand. */
const SUBCOMMAND_CHECKS: Record<string, readonly string[]> = {
	go: ["test", "vet", "build"],
	cargo: ["test", "check", "build", "clippy", "nextest", "fmt"],
	dotnet: ["test", "build"],
	swift: ["test", "build"],
	deno: ["test", "check", "lint"],
	bun: ["test"],
	biome: ["check", "lint", "ci"],
	mvn: ["test", "verify", "package", "compile", "check"],
	mvnw: ["test", "verify", "package", "compile", "check"],
	gradle: ["test", "check", "build", "assemble"],
	gradlew: ["test", "check", "build", "assemble"],
	playwright: ["test"],
	cypress: ["run"],
	make: ["test", "tests", "check", "lint", "build", "verify", "ci", "all"],
	gmake: ["test", "tests", "check", "lint", "build", "verify", "ci", "all"],
};

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Words in a package script name that mark it as a check; they may be joined by `:`, `-` or `_`. */
const CHECK_SCRIPT_WORDS = new Set([
	"test",
	"tests",
	"check",
	"lint",
	"typecheck",
	"build",
	"verify",
	"ci",
	"validate",
	"e2e",
	"spec",
	"compile",
	"tsc",
]);
/** Words that mark a script as something other than a finished check. */
const NON_CHECK_SCRIPT_WORDS = new Set([
	"watch",
	"dev",
	"start",
	"serve",
	"publish",
	"release",
	"install",
	"clean",
	"fix",
]);

/** Wrappers that run the next program unchanged. */
const WRAPPERS = new Set([
	"env",
	"time",
	"command",
	"nohup",
	"sudo",
	"exec",
	"npx",
	"pnpx",
	"bunx",
	"cross-env",
	"corepack",
]);

/** Words that look like a runner but carry only environment or flags. */
function stripWrappers(argv: readonly string[]): string[] {
	let words = [...argv];
	for (let guard = 0; guard < 6 && words.length > 0; guard++) {
		const first = words[0];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
			words = words.slice(1);
			continue;
		}
		const name = programName(first);
		if (WRAPPERS.has(name)) {
			words = words.slice(1);
			while (words.length > 0 && words[0].startsWith("-")) words = words.slice(1);
			continue;
		}
		if ((name === "pnpm" || name === "yarn" || name === "bun") && (words[1] === "exec" || words[1] === "dlx")) {
			words = words.slice(2);
			continue;
		}
		if (name === "npm" && words[1] === "exec") {
			words = words.slice(2);
			while (words.length > 0 && words[0].startsWith("-")) words = words.slice(1);
			continue;
		}
		break;
	}
	return words;
}

function isCheckScript(script: string): boolean {
	const parts = script
		.toLowerCase()
		.split(/[:\-_.]/)
		.filter(Boolean);
	return parts.some((part) => CHECK_SCRIPT_WORDS.has(part)) && !parts.some((part) => NON_CHECK_SCRIPT_WORDS.has(part));
}

/** Whether one simple command runs a recognized check. */
function isCheckCommand(argv: readonly string[]): boolean {
	const words = stripWrappers(argv);
	if (words.length === 0) return false;
	const name = programName(words[0]);
	const args = words.slice(1);
	const firstPlain = args.find((arg) => !arg.startsWith("-"));

	if (name === "tsc")
		return !args.some(
			(arg) => arg === "--init" || arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v",
		);
	if (name === "ruff")
		return (
			firstPlain === undefined || firstPlain === "check" || (firstPlain === "format" && args.includes("--check"))
		);
	if (name === "prettier")
		return args.some((arg) => arg === "--check" || arg === "-c" || arg === "--list-different" || arg === "-l");
	if (TEST_RUNNERS.has(name)) return true;
	if ((name === "python" || name === "python3" || name === "py") && args[0] === "-m") {
		return ["pytest", "unittest", "mypy", "ruff", "pyright", "flake8", "tox", "nox"].includes(args[1] ?? "");
	}
	if (name === "node") return args.includes("--test");
	if (PACKAGE_MANAGERS.has(name)) {
		// `npm test`, `npm run check`, `pnpm -w run lint`, `yarn test`, `bun run build:all`
		const plain: string[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (arg === "--") break;
			if (arg.startsWith("-")) {
				if (/^(?:-w|-F|-C|--workspace|--filter|--prefix|--cwd|--dir)$/.test(arg)) index++;
				continue;
			}
			plain.push(arg);
		}
		const [first, second] = plain;
		if (first === "test" || first === "t" || first === "tst") return true;
		if (first === "run" || first === "run-script") return second !== undefined && isCheckScript(second);
		if (name === "bun" && first === "test") return true;
		if (
			name !== "npm" &&
			first !== undefined &&
			!["install", "add", "remove", "publish", "exec", "dlx"].includes(first)
		) {
			return isCheckScript(first);
		}
		return false;
	}
	const subcommands = SUBCOMMAND_CHECKS[name];
	if (subcommands) {
		if (name === "make" || name === "gmake") {
			const targets = args.filter((arg) => !arg.startsWith("-") && !arg.includes("="));
			return targets.length === 0 || targets.every((target) => subcommands.includes(target));
		}
		if (name === "gradle" || name === "gradlew")
			return args.some((arg) => subcommands.includes(arg.split(":").pop() ?? arg));
		return firstPlain !== undefined && subcommands.includes(firstPlain);
	}
	if (name === "bash" || name === "sh" || name === "zsh") {
		const script = args.find((arg) => !arg.startsWith("-"));
		return script !== undefined && CHECK_SCRIPTS.has(programName(script).replace(/\.(?:sh|bash)$/, ""));
	}
	return CHECK_SCRIPTS.has(name.replace(/\.(?:sh|bash)$/, "")) && /\.(?:sh|bash)$/.test(words[0]);
}

/** Directories a check covers, from `cd`, `--prefix`, `-C`, `--workspace <path>` and `-p <tsconfig>`. */
function checkScope(commands: readonly ShellCommand[], index: number): string[] | undefined {
	const normalize = (value: string): string | undefined => {
		let path = value.replace(/\\/g, "/").replace(/\/+$/, "");
		if (path === "" || path === "." || path === ".." || path.startsWith("../") || path.startsWith("~"))
			return undefined;
		path = path.replace(/^\.\//, "");
		return path.includes("/") || path.startsWith("/") ? path : undefined;
	};
	const scope: string[] = [];
	let base = "";
	for (let position = 0; position <= index; position++) {
		const argv = commands[position].argv;
		if (position < index && (programName(argv[0]) === "cd" || programName(argv[0]) === "pushd") && argv[1]) {
			const target = argv[1].replace(/\\/g, "/");
			if (target.startsWith("/")) base = target.replace(/\/+$/, "");
			else if (target === ".." || target.startsWith("../") || target.startsWith("~")) return undefined;
			else base = [base, target.replace(/^\.\//, "").replace(/\/+$/, "")].filter(Boolean).join("/");
		}
	}
	if (base) scope.push(base);
	const args = commands[index].argv;
	for (let position = 0; position < args.length - 1; position++) {
		const flag = args[position];
		const value = args[position + 1];
		if (/^(?:--prefix|--cwd|-C|--dir|--root|-w|--workspace|-F|--filter|--manifest-path)$/.test(flag)) {
			const path = flag === "--manifest-path" ? value.replace(/\/[^/]*$/, "") : value;
			const normalized = normalize(path);
			if (normalized) scope.push(base && !normalized.startsWith("/") ? `${base}/${normalized}` : normalized);
		} else if (/^(?:-p|--project)$/.test(flag) && value.includes("/")) {
			const normalized = normalize(value.replace(/\/[^/]*$/, ""));
			if (normalized) scope.push(base && !normalized.startsWith("/") ? `${base}/${normalized}` : normalized);
		}
	}
	return scope.length > 0 ? [...new Set(scope)] : undefined;
}

/**
 * Whether what follows a check in a command line replaces the check's exit code with another
 * command's: a pipe (`npm test | tail`, unless `pipefail` is set), `||` (`npm test || true`), or
 * a later command (`npm test; echo done`). All of them exit 0 when the check fails. `&&` keeps
 * the failure, so `npm test && echo ok` is still evidence.
 */
export function masksExitCode(command: string, checkEnd = 0): boolean {
	const rest = command.slice(checkEnd);
	if (/\|\||;|\n/.test(rest)) return true;
	return /\|/.test(rest) && !/\bpipefail\b/.test(command);
}

interface LocatedCheck {
	/** Offset just after the last check in the command. */
	end: number;
	scope?: string[];
}

/** The last check in `command`, by the program it runs, or undefined when it runs none. */
function lastCheck(command: string, verifyCommands: readonly string[]): LocatedCheck | undefined {
	const commands = parseShell(command);
	if (verifyCommands.length === 0) {
		for (let index = commands.length - 1; index >= 0; index--) {
			if (isCheckCommand(commands[index].argv))
				return { end: commands[index].end, scope: checkScope(commands, index) };
		}
		return undefined;
	}
	let end = -1;
	let matchStart = -1;
	for (const declared of verifyCommands) {
		// Tokens match literally; any run of whitespace between them matches any other.
		const tokens = declared.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;
		const pattern = new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
		for (const match of command.matchAll(pattern)) {
			if (match.index + match[0].length > end) {
				end = match.index + match[0].length;
				matchStart = match.index;
			}
		}
	}
	if (end < 0) return undefined;
	const index = commands.findIndex((item) => item.start <= matchStart && matchStart < item.end);
	return { end, scope: index >= 0 ? checkScope(commands, index) : undefined };
}

/** Inline interpreter code (`python -c`, `node -e`) that needs authorization, if any. */
function inlineCodeEffect(
	commands: readonly ShellCommand[],
): { kind: "destructive" | "external"; reason: string } | undefined {
	for (const { argv } of commands) {
		const words = stripWrappers(argv);
		if (words.length === 0 || !INLINE_INTERPRETERS.has(programName(words[0]))) continue;
		for (let index = 1; index < words.length - 1; index++) {
			if (!INLINE_FLAGS.has(words[index])) continue;
			const code = words[index + 1];
			const rule = INLINE_CODE_RULES.find((candidate) => candidate.pattern.test(code));
			if (rule) return { kind: rule.kind, reason: rule.reason };
		}
	}
	return undefined;
}

/**
 * Classify a shell command. With `verifyCommands`, only those commands count as verification;
 * otherwise commands that run a known test runner, type checker, linter or build do. A check
 * whose exit code is masked is not verification.
 */
export function classifyCommand(command: string, verifyCommands: readonly string[] = []): Omit<ToolEffect, "paths"> {
	for (const rule of COMMAND_RULES) {
		if (rule.pattern.test(command)) return { kind: rule.kind, command, reason: rule.reason };
	}
	const inline = inlineCodeEffect(parseShell(command));
	if (inline) return { kind: inline.kind, command, reason: inline.reason };
	const check = lastCheck(command, verifyCommands);
	if (check && !masksExitCode(command, check.end)) {
		return { kind: "verify", command, ...(check.scope ? { scope: check.scope } : {}) };
	}
	return { kind: "execute", command };
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** Collapses `.` and `..` and separators without touching the file system. */
export function normalizePath(path: string): string {
	const absolute = /^(?:\/|[A-Za-z]:\/)/.test(path.replace(/\\/g, "/"));
	const drive = /^[A-Za-z]:\//.exec(path.replace(/\\/g, "/"))?.[0] ?? (absolute ? "/" : "");
	const rest = path.replace(/\\/g, "/").slice(drive.length);
	const parts: string[] = [];
	for (const part of rest.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
			else if (!absolute) parts.push("..");
		} else parts.push(part);
	}
	return `${drive}${parts.join("/")}`;
}

/** Files that run code or hold credentials: writing them changes what runs on the developer's machine. */
const SENSITIVE_PATHS = [
	/(?:^|\/)\.git\/(?:hooks\/|config$)/,
	/(?:^|\/)\.husky\//,
	/(?:^|\/)\.relay\/(?:settings\.json|mcp\.json|extensions\/|agent\/)/,
	/(?:^|\/)\.ssh\//,
	/(?:^|\/)\.(?:bashrc|zshrc|profile|bash_profile|zprofile|npmrc|gitconfig)$/,
	/(?:^|\/)\.config\/(?:git|fish)\//,
];

const TEMP_ROOTS = ["/tmp/", "/var/tmp/", "/private/tmp/", "/private/var/folders/"];

/** Why writing `path` needs authorization, or undefined when it is an ordinary workspace file. */
export function riskyWritePath(path: string, context: ClassifyContext = {}): string | undefined {
	let resolved = path.replace(/\\/g, "/");
	if (context.home && (resolved === "~" || resolved.startsWith("~/"))) {
		resolved = `${context.home.replace(/\\/g, "/").replace(/\/+$/, "")}${resolved.slice(1)}`;
	}
	const cwd = context.cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
	const absolute = /^(?:\/|[A-Za-z]:\/)/.test(resolved);
	const full = normalizePath(absolute || !cwd ? resolved : `${cwd}/${resolved}`);
	if (SENSITIVE_PATHS.some((pattern) => pattern.test(full)))
		return "writes a file that runs code or holds credentials";
	if (cwd && /^(?:\/|[A-Za-z]:\/)/.test(full)) {
		const root = normalizePath(cwd);
		const inside = full === root || full.startsWith(`${root}/`);
		const temporary = TEMP_ROOTS.some((temp) => full.startsWith(temp));
		if (!inside && !temporary) return "writes outside the workspace";
	}
	return undefined;
}

/**
 * Default classification by tool name and arguments. Unknown tools are `execute`.
 * `verifyCommands` are the project's declared checks; see {@link classifyCommand}.
 */
export function classifyToolCall(
	toolCall: AgentToolCall,
	custom?: ToolEffectClassifier,
	verifyCommands: readonly string[] = [],
	context: ClassifyContext = {},
): ToolEffect {
	const customEffect = custom?.(toolCall);
	if (customEffect) return customEffect;

	const name = toolCall.name.toLowerCase();
	const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
	const path = stringArg(args, "path", "file_path", "filePath", "file", "notebook_path");
	const paths = path ? [path] : [];

	if (SHELL_TOOLS.has(name)) {
		const command = stringArg(args, "command", "cmd", "script") ?? "";
		return { ...classifyCommand(command, verifyCommands), paths };
	}
	if (WRITE_TOOLS.has(name)) {
		for (const target of paths) {
			const reason = riskyWritePath(target, context);
			if (reason) return { kind: "external", paths, reason };
		}
		return { kind: "write", paths };
	}
	if (READ_TOOLS.has(name)) return { kind: "read", paths };
	return { kind: "execute", paths };
}

/** Whether an effect changes state. */
export function isMutation(kind: ToolEffectKind): boolean {
	return kind === "write" || kind === "destructive" || kind === "external";
}

/** Whether an effect needs explicit authorization before it runs. */
export function requiresAuthorization(kind: ToolEffectKind): boolean {
	return kind === "destructive" || kind === "external";
}
