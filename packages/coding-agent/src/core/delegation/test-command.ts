type Shell = "bash" | "powershell";
interface Command {
	words: string[];
	after?: "and" | "sequence";
}

/** Recognize command boundaries, not shell text that merely mentions a runner. */
function commands(source: string, shell: Shell): Command[] | undefined {
	const result: Command[] = [];
	let words: string[] = [];
	let word = "";
	let started = false;
	let quote: string | undefined;
	const finishWord = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	const finishCommand = (after?: Command["after"]) => {
		finishWord();
		if (words.length) result.push({ words, after });
		words = [];
	};
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		const next = source[index + 1];
		const escapeCharacter = shell === "powershell" ? "`" : "\\";
		if (quote !== "'" && char === escapeCharacter) {
			if (next === undefined) return undefined;
			if (quote === '"' && shell === "bash" && !['"', "\\", "$", "`", "\n", "\r"].includes(next)) {
				word += char;
				continue;
			}
			index++;
			if (next === "\r" && source[index + 1] === "\n") index++;
			else if (next !== "\n" && next !== "\r") {
				word += next;
				started = true;
			}
			continue;
		}
		if (quote) {
			if (char === quote) {
				if (shell === "powershell" && next === quote) {
					word += quote;
					index++;
				} else quote = undefined;
			} else {
				if (shell === "bash" && quote === '"' && char === "`") return undefined;
				word += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (char === "#" && !started) {
			while (index + 1 < source.length && source[index + 1] !== "\n") index++;
		} else if (char === ";" || char === "\n" || char === "\r") finishCommand("sequence");
		else if (/\s/.test(char)) finishWord();
		else if (char === "&") {
			if (next === "&") {
				finishCommand("and");
				index++;
			} else if (next === ">") {
				finishWord();
				words.push("&>");
				index++;
			} else if (source[index - 1] === ">" || source[index - 1] === "<") {
				word += char;
				started = true;
			} else if (shell !== "powershell" || words.length || started) return undefined;
		} else if (char === "|" || "(){}".includes(char) || (shell === "bash" && char === "`")) return undefined;
		else if (char === ">" || char === "<") {
			if (char === "<" && next === "<") return undefined;
			finishWord();
			words.push(char);
		} else {
			word += char;
			started = true;
		}
	}
	if (quote) return undefined;
	finishCommand();
	return result;
}

function invocation(words: readonly string[], depth: number): boolean {
	let offset = 0;
	while (offset < words.length) {
		while (/^[A-Za-z_][\w]*=/.test(words[offset] ?? "")) offset++;
		const executable =
			(words[offset] ?? "")
				.replaceAll("\\", "/")
				.split("/")
				.at(-1)
				?.toLowerCase()
				.replace(/\.(?:exe|cmd)$/, "") ?? "";
		const args = words.slice(offset + 1);
		if (
			args.some((arg) =>
				[
					"--help",
					"-h",
					"--version",
					"-V",
					"--list",
					"-list",
					"--listTests",
					"--collectTests",
					"--clearCache",
					"--list-tests",
					"--collect-only",
					"--collectonly",
					"--co",
					"--showConfig",
					"--dry-run",
					"--dryRun",
					"--no-run",
					"--if-present",
				].includes(arg.split("=", 1)[0]),
			)
		)
			return false;
		if (["node", "npm", "npx", "vitest", "jest"].includes(executable) && args.includes("-v")) return false;
		if (executable === "env") {
			offset++;
			while (["-i", "--ignore-environment", "--"].includes(words[offset] ?? "")) offset++;
			continue;
		}
		if (executable === "npx" || ((executable === "npm" || executable === "pnpm") && args[0] === "exec")) {
			offset += executable === "npx" ? 1 : 2;
			while (["--", "--no-install", "--yes", "-y"].includes(words[offset] ?? "")) offset++;
			continue;
		}
		if (executable === "node") {
			if (args.some((arg) => /^(?:-e|--eval|-p|--print|--check|-c)(?:=|$)/.test(arg))) return false;
			let script = "";
			let scriptIndex = -1;
			for (let index = 0; index < args.length; index++) {
				const arg = args[index];
				if (arg === "--test") return true;
				if (
					["--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "-C"].includes(arg)
				) {
					index++;
					continue;
				}
				if (arg === "--" || !arg.startsWith("-")) {
					scriptIndex = arg === "--" ? index + 1 : index;
					script = (args[scriptIndex] ?? "").replaceAll("\\", "/");
					break;
				}
			}
			if (/(?:^|\/)vitest\/(?:vitest\.mjs|(?:dist\/)?cli\.[cm]?js)$/.test(script))
				return invocation(["vitest", ...args.slice(scriptIndex + 1)], depth);
			if (/(?:^|\/)jest\/bin\/jest\.js$/.test(script))
				return invocation(["jest", ...args.slice(scriptIndex + 1)], depth);
			return false;
		}
		if (/^(?:python(?:\d+(?:\.\d+)*)?|py)$/.test(executable)) return args[0] === "-m" && args[1] === "pytest";
		if (executable === "vitest") return !args.some((arg) => arg === "list" || arg === "init");
		if (executable === "pytest" || executable === "jest" || executable === "test.sh") return true;
		if (executable === "playwright" || executable === "cargo" || executable === "go" || executable === "dotnet")
			return args[0] === "test";
		if (executable === "npm") return args[0] === "test" || (args[0] === "run" && /^test\b/.test(args[1] ?? ""));
		if (executable === "bash" || executable === "sh" || executable === "powershell" || executable === "pwsh") {
			if (args[0]?.replaceAll("\\", "/").split("/").at(-1) === "test.sh") return true;
			const command = args.findIndex((arg) => ["-c", "-lc", "-command"].includes(arg.toLowerCase()));
			return (
				command !== -1 &&
				args[command + 1] !== undefined &&
				recognized(
					args[command + 1],
					executable === "powershell" || executable === "pwsh" ? "powershell" : "bash",
					depth + 1,
				)
			);
		}
		return false;
	}
	return false;
}

function recognized(source: string, shell: Shell, depth: number): boolean {
	if (depth > 4) return false;
	const parsed = commands(source, shell);
	if (!parsed?.length || parsed.at(-1)?.after === "and") return false;
	return invocation(parsed[parsed.length - 1].words, depth);
}

/** Recognize a final test invocation whose status is not masked by shell composition. */
export function isTestCommand(source: string, shell: Shell): boolean {
	return recognized(source, shell, 0);
}
