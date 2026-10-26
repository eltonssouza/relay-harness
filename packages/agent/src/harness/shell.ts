/**
 * A small shell lexer for classification, not a shell. It splits a command line into simple
 * commands and words, respecting quotes, escapes, `$(...)` and backticks, so rules can look at the
 * program a command runs instead of at words that merely appear in it (`ls build`, `echo test`).
 */

export interface ShellCommand {
	/** Words with quotes removed and redirections dropped. */
	argv: string[];
	/** Offset of the command's first character in the source. */
	start: number;
	/** Offset just after the command's last word. */
	end: number;
	/** Operator that follows the command: `&&`, `||`, `;`, `|`, `&`, a newline, or empty at the end. */
	next: string;
}

/** Leading words that start or continue a compound command and run nothing themselves. */
const COMPOUND_WORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);

/** A redirection word such as `2>&1`, `>`, `>>`, `<`, `&>`. A bare operator takes the next word as its target. */
const REDIRECTION = /^(?:\d*|&)(?:>>?|<<?<?|>&)(.*)$/;

export function parseShell(source: string): ShellCommand[] {
	const commands: ShellCommand[] = [];
	let argv: string[] = [];
	let word = "";
	let inWord = false;
	let commandStart = -1;
	let commandEnd = 0;
	let skipTarget = false;
	let substitutionDepth = 0;
	let inBackticks = false;
	let wordStart = 0;
	const open = (offset: number) => {
		if (inWord) return;
		inWord = true;
		wordStart = offset;
	};

	const finishWord = (end: number) => {
		if (!inWord) return;
		inWord = false;
		const text = word;
		word = "";
		if (skipTarget) {
			skipTarget = false;
			return;
		}
		const redirection = REDIRECTION.exec(text);
		if (redirection) {
			if (redirection[1] === "") skipTarget = true;
			return;
		}
		if (argv.length === 0 && COMPOUND_WORDS.has(text)) return;
		if (argv.length === 0) commandStart = wordStart;
		argv.push(text);
		commandEnd = end;
	};
	const finishCommand = (next: string) => {
		if (argv.length > 0) commands.push({ argv, start: commandStart, end: commandEnd, next });
		else if (commands.length > 0 && next !== "") commands[commands.length - 1].next ||= next;
		argv = [];
		skipTarget = false;
	};

	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "\\") {
			if (source[index + 1] === "\n") {
				index++;
				continue;
			}
			open(index);
			word += source[index + 1] ?? "";
			index++;
			continue;
		}
		if (char === "'") {
			open(index);
			const close = source.indexOf("'", index + 1);
			const stop = close === -1 ? source.length : close;
			word += source.slice(index + 1, stop);
			index = stop;
			continue;
		}
		if (char === '"') {
			open(index);
			index++;
			while (index < source.length && source[index] !== '"') {
				if (source[index] === "\\" && index + 1 < source.length) index++;
				word += source[index];
				index++;
			}
			continue;
		}
		if (char === "`") {
			inBackticks = !inBackticks;
			open(index);
			word += char;
			continue;
		}
		if (char === "$" && source[index + 1] === "(") {
			substitutionDepth++;
			open(index);
			word += "$(";
			index++;
			continue;
		}
		if (substitutionDepth > 0 || inBackticks) {
			if (char === ")" && substitutionDepth > 0) substitutionDepth--;
			open(index);
			word += char;
			continue;
		}
		if (char === "#" && !inWord) {
			const newline = source.indexOf("\n", index);
			index = newline === -1 ? source.length : newline - 1;
			continue;
		}
		if (char === " " || char === "\t" || char === "\r") {
			finishWord(index);
			continue;
		}
		if (char === "\n") {
			finishWord(index);
			finishCommand("\n");
			continue;
		}
		if (char === ";") {
			finishWord(index);
			finishCommand(";");
			continue;
		}
		if (char === "(" || char === ")") {
			finishWord(index);
			finishCommand("");
			continue;
		}
		if (char === "|") {
			finishWord(index);
			if (source[index + 1] === "|") {
				finishCommand("||");
				index++;
			} else {
				finishCommand("|");
			}
			continue;
		}
		if (char === "&") {
			// `2>&1`, `>&2` and `&>file` are redirections, not control operators.
			const previous = source[index - 1];
			if (previous === ">" || previous === "<" || source[index + 1] === ">") {
				open(index);
				word += char;
				continue;
			}
			finishWord(index);
			if (source[index + 1] === "&") {
				finishCommand("&&");
				index++;
			} else {
				finishCommand("&");
			}
			continue;
		}
		open(index);
		word += char;
	}
	finishWord(source.length);
	finishCommand("");
	return commands;
}

/** Program name of a word: the last path segment without a script or executable extension. */
export function programName(word: string): string {
	const base = word.replace(/\\/g, "/").split("/").pop() ?? word;
	return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
}
