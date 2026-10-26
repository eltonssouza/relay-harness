/**
 * A small shell lexer for classification, not a shell. It splits a command line into simple
 * commands and words, respecting quotes, escapes, `$(...)` and backticks, so rules can look at the
 * program a command runs instead of at words that merely appear in it (`ls build`, `echo test`).
 */

export interface ShellCommand {
	/** Words with quotes removed and redirections dropped. */
	argv: string[];
	/** Files the command writes through `>`, `>>`, `>|` and `&>`, without `/dev/*` and file descriptors. */
	outputs: string[];
	/** Offset of the command's first character in the source. */
	start: number;
	/** Offset just after the command's last word. */
	end: number;
	/** Operator that follows the command: `&&`, `||`, `;`, `|`, `&`, a newline, or empty at the end. */
	next: string;
}

/** Leading words that start or continue a compound command and run nothing themselves. */
const COMPOUND_WORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);

/**
 * A redirection word such as `2>&1`, `>`, `>>`, `<`, `&>`, `<<EOF`. A bare operator takes the next
 * word as its target. The operator must be unquoted (`grep ">=" f` has no redirection).
 */
const REDIRECTION = /^(?:\d*|&)(>>|>\||>&|>|<<<|<<-|<<|<&|<)(.*)$/;

export function parseShell(source: string): ShellCommand[] {
	const commands: ShellCommand[] = [];
	let argv: string[] = [];
	let outputs: string[] = [];
	let word = "";
	let inWord = false;
	/** Offset in `word` of the first quote or escape, or -1: an operator must come before it. */
	let firstQuote = -1;
	let commandStart = -1;
	let commandEnd = 0;
	let redirectOperator: string | undefined;
	const heredocs: Array<{ delimiter: string; indented: boolean }> = [];
	/** Skips the bodies of the heredocs opened on the line that just ended; returns the last offset consumed. */
	const skipHeredocs = (text: string, lineEnd: number): number => {
		let position = lineEnd;
		for (const { delimiter, indented } of heredocs.splice(0)) {
			for (let start = position + 1; start <= text.length; ) {
				const newline = text.indexOf("\n", start);
				const stop = newline === -1 ? text.length : newline;
				const line = text.slice(start, stop).replace(/\r$/, "");
				position = stop;
				if ((indented ? line.replace(/^\t+/, "") : line) === delimiter || newline === -1) break;
				start = newline + 1;
			}
		}
		return position;
	};
	let substitutionDepth = 0;
	let inBackticks = false;
	let wordStart = 0;
	const open = (offset: number) => {
		if (inWord) return;
		inWord = true;
		wordStart = offset;
	};

	const redirect = (operator: string, target: string) => {
		if (operator === "<<" || operator === "<<-") heredocs.push({ delimiter: target, indented: operator === "<<-" });
		const writes = operator === ">" || operator === ">>" || operator === ">|" || operator === ">&";
		const descriptor = /^\d*-?$/.test(target);
		if (writes && !descriptor && !target.startsWith("/dev/")) outputs.push(target);
	};

	const finishWord = (end: number) => {
		if (!inWord) return;
		inWord = false;
		const text = word;
		const quoteAt = firstQuote;
		word = "";
		firstQuote = -1;
		if (redirectOperator !== undefined) {
			redirect(redirectOperator, text);
			redirectOperator = undefined;
			return;
		}
		const redirection = REDIRECTION.exec(text);
		if (redirection && (quoteAt === -1 || text.length - redirection[2].length <= quoteAt)) {
			if (redirection[2] === "") redirectOperator = redirection[1];
			else redirect(redirection[1], redirection[2]);
			return;
		}
		if (argv.length === 0 && COMPOUND_WORDS.has(text)) return;
		if (argv.length === 0) commandStart = wordStart;
		argv.push(text);
		commandEnd = end;
	};
	const finishCommand = (next: string) => {
		if (argv.length > 0) commands.push({ argv, outputs, start: commandStart, end: commandEnd, next });
		else if (commands.length > 0 && next !== "") commands[commands.length - 1].next ||= next;
		argv = [];
		outputs = [];
		redirectOperator = undefined;
	};

	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "\\") {
			if (source[index + 1] === "\n") {
				index++;
				continue;
			}
			open(index);
			if (firstQuote === -1) firstQuote = word.length;
			word += source[index + 1] ?? "";
			index++;
			continue;
		}
		if (char === "'") {
			open(index);
			if (firstQuote === -1) firstQuote = word.length;
			const close = source.indexOf("'", index + 1);
			const stop = close === -1 ? source.length : close;
			word += source.slice(index + 1, stop);
			index = stop;
			continue;
		}
		if (char === '"') {
			open(index);
			if (firstQuote === -1) firstQuote = word.length;
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
			index = skipHeredocs(source, index);
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
