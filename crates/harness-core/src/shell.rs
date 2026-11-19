//! A small shell lexer for classification, not a shell. It splits a command line into simple
//! commands and words, respecting quotes, escapes, `$(...)` and backticks, so rules can look at the
//! program a command runs instead of at words that merely appear in it (`ls build`, `echo test`).
//!
//! Port of `packages/agent/src/harness/shell.ts`. Offsets are byte offsets into the source.

/// One simple command of a command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommand {
    /// Words with quotes removed and redirections dropped.
    pub argv: Vec<String>,
    /// Files the command writes through `>`, `>>`, `>|` and `&>`, without `/dev/*` and file descriptors.
    pub outputs: Vec<String>,
    /// Offset of the command's first character in the source.
    pub start: usize,
    /// Offset just after the command's last word.
    pub end: usize,
    /// Operator that follows the command: `&&`, `||`, `;`, `|`, `&`, a newline, or empty at the end.
    pub next: String,
}

/// Leading words that start or continue a compound command and run nothing themselves.
const COMPOUND_WORDS: [&str; 12] = [
    "{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until",
];

/// Redirection operators, in the order the TypeScript regex tries them.
const REDIRECTION_OPERATORS: [&str; 9] = [">>", ">|", ">&", ">", "<<<", "<<-", "<<", "<&", "<"];

/// A redirection word such as `2>&1`, `>`, `>>`, `<`, `&>`, `<<EOF`: the operator and its target
/// (empty when the target is the next word).
fn redirection(text: &str) -> Option<(&'static str, &str)> {
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    let candidates = if text.starts_with('&') && digits == 0 {
        [0, 1]
    } else {
        [digits, digits]
    };
    for prefix in candidates {
        let rest = &text[prefix..];
        for operator in REDIRECTION_OPERATORS {
            if let Some(target) = rest.strip_prefix(operator) {
                // `.` does not match a newline in the TypeScript pattern `(.*)$`.
                if target.contains('\n') {
                    return None;
                }
                return Some((operator, target));
            }
        }
    }
    None
}

struct Lexer<'a> {
    source: &'a [u8],
    commands: Vec<ShellCommand>,
    argv: Vec<String>,
    outputs: Vec<String>,
    word: Vec<u8>,
    in_word: bool,
    /// Offset in `word` of the first quote or escape: an operator must come before it.
    first_quote: Option<usize>,
    command_start: usize,
    command_end: usize,
    redirect_operator: Option<&'static str>,
    heredocs: Vec<(String, bool)>,
    word_start: usize,
}

impl<'a> Lexer<'a> {
    fn open(&mut self, offset: usize) {
        if self.in_word {
            return;
        }
        self.in_word = true;
        self.word_start = offset;
    }

    fn redirect(&mut self, operator: &str, target: String) {
        if operator == "<<" || operator == "<<-" {
            self.heredocs.push((target.clone(), operator == "<<-"));
        }
        let writes = matches!(operator, ">" | ">>" | ">|" | ">&");
        let digits = target.trim_end_matches('-');
        let descriptor =
            digits.bytes().all(|byte| byte.is_ascii_digit()) && target.len() <= digits.len() + 1;
        if writes && !descriptor && !target.starts_with("/dev/") {
            self.outputs.push(target);
        }
    }

    fn finish_word(&mut self, end: usize) {
        if !self.in_word {
            return;
        }
        self.in_word = false;
        let text = String::from_utf8_lossy(&self.word).into_owned();
        let quote_at = self.first_quote;
        self.word.clear();
        self.first_quote = None;
        if let Some(operator) = self.redirect_operator.take() {
            self.redirect(operator, text);
            return;
        }
        if let Some((operator, target)) = redirection(&text) {
            let operator_end = text.len() - target.len();
            if quote_at.is_none_or(|quote| operator_end <= quote) {
                if target.is_empty() {
                    self.redirect_operator = Some(operator);
                } else {
                    let target = target.to_string();
                    self.redirect(operator, target);
                }
                return;
            }
        }
        if self.argv.is_empty() && COMPOUND_WORDS.contains(&text.as_str()) {
            return;
        }
        if self.argv.is_empty() {
            self.command_start = self.word_start;
        }
        self.argv.push(text);
        self.command_end = end;
    }

    fn finish_command(&mut self, next: &str) {
        if !self.argv.is_empty() {
            self.commands.push(ShellCommand {
                argv: std::mem::take(&mut self.argv),
                outputs: std::mem::take(&mut self.outputs),
                start: self.command_start,
                end: self.command_end,
                next: next.to_string(),
            });
        } else if !next.is_empty() {
            if let Some(last) = self.commands.last_mut() {
                if last.next.is_empty() {
                    last.next = next.to_string();
                }
            }
        }
        self.argv.clear();
        self.outputs.clear();
        self.redirect_operator = None;
    }

    /// Skips the bodies of the heredocs opened on the line that just ended; returns the last offset consumed.
    fn skip_heredocs(&mut self, line_end: usize) -> usize {
        let text = self.source;
        let mut position = line_end;
        for (delimiter, indented) in std::mem::take(&mut self.heredocs) {
            let mut start = position + 1;
            while start <= text.len() {
                let newline = text[start..]
                    .iter()
                    .position(|&byte| byte == b'\n')
                    .map(|offset| start + offset);
                let stop = newline.unwrap_or(text.len());
                let raw = String::from_utf8_lossy(&text[start..stop]);
                let line = raw.strip_suffix('\r').unwrap_or(&raw);
                position = stop;
                let compared = if indented {
                    line.trim_start_matches('\t')
                } else {
                    line
                };
                if compared == delimiter || newline.is_none() {
                    break;
                }
                start = stop + 1;
            }
        }
        position
    }
}

/// Splits a command line into simple commands. Port of `parseShell`.
pub fn parse_shell(source: &str) -> Vec<ShellCommand> {
    let bytes = source.as_bytes();
    let mut lexer = Lexer {
        source: bytes,
        commands: Vec::new(),
        argv: Vec::new(),
        outputs: Vec::new(),
        word: Vec::new(),
        in_word: false,
        first_quote: None,
        command_start: 0,
        command_end: 0,
        redirect_operator: None,
        heredocs: Vec::new(),
        word_start: 0,
    };
    let mut substitution_depth = 0usize;
    let mut in_backticks = false;
    let mut index = 0usize;
    while index < bytes.len() {
        let char = bytes[index];
        if char == b'\\' {
            if bytes.get(index + 1) == Some(&b'\n') {
                index += 2;
                continue;
            }
            lexer.open(index);
            if lexer.first_quote.is_none() {
                lexer.first_quote = Some(lexer.word.len());
            }
            if let Some(&escaped) = bytes.get(index + 1) {
                lexer.word.push(escaped);
            }
            index += 2;
            continue;
        }
        if char == b'\'' {
            lexer.open(index);
            if lexer.first_quote.is_none() {
                lexer.first_quote = Some(lexer.word.len());
            }
            let close = bytes[index + 1..]
                .iter()
                .position(|&byte| byte == b'\'')
                .map(|offset| index + 1 + offset);
            let stop = close.unwrap_or(bytes.len());
            lexer.word.extend_from_slice(&bytes[index + 1..stop]);
            index = stop + 1;
            continue;
        }
        if char == b'"' {
            lexer.open(index);
            if lexer.first_quote.is_none() {
                lexer.first_quote = Some(lexer.word.len());
            }
            index += 1;
            while index < bytes.len() && bytes[index] != b'"' {
                if bytes[index] == b'\\' && index + 1 < bytes.len() {
                    index += 1;
                }
                lexer.word.push(bytes[index]);
                index += 1;
            }
            index += 1;
            continue;
        }
        if char == b'`' {
            in_backticks = !in_backticks;
            lexer.open(index);
            lexer.word.push(char);
            index += 1;
            continue;
        }
        if char == b'$' && bytes.get(index + 1) == Some(&b'(') {
            substitution_depth += 1;
            lexer.open(index);
            lexer.word.extend_from_slice(b"$(");
            index += 2;
            continue;
        }
        if substitution_depth > 0 || in_backticks {
            if char == b')' && substitution_depth > 0 {
                substitution_depth -= 1;
            }
            lexer.open(index);
            lexer.word.push(char);
            index += 1;
            continue;
        }
        if char == b'#' && !lexer.in_word {
            let newline = bytes[index..]
                .iter()
                .position(|&byte| byte == b'\n')
                .map(|offset| index + offset);
            index = newline.unwrap_or(bytes.len());
            continue;
        }
        match char {
            b' ' | b'\t' | b'\r' => {
                lexer.finish_word(index);
                index += 1;
            }
            b'\n' => {
                lexer.finish_word(index);
                lexer.finish_command("\n");
                index = lexer.skip_heredocs(index) + 1;
            }
            b';' => {
                lexer.finish_word(index);
                lexer.finish_command(";");
                index += 1;
            }
            b'(' | b')' => {
                lexer.finish_word(index);
                lexer.finish_command("");
                index += 1;
            }
            b'|' => {
                lexer.finish_word(index);
                if bytes.get(index + 1) == Some(&b'|') {
                    lexer.finish_command("||");
                    index += 2;
                } else {
                    lexer.finish_command("|");
                    index += 1;
                }
            }
            b'&' => {
                // `2>&1`, `>&2` and `&>file` are redirections, not control operators.
                let previous = if index > 0 { bytes[index - 1] } else { 0 };
                if previous == b'>' || previous == b'<' || bytes.get(index + 1) == Some(&b'>') {
                    lexer.open(index);
                    lexer.word.push(char);
                    index += 1;
                    continue;
                }
                lexer.finish_word(index);
                if bytes.get(index + 1) == Some(&b'&') {
                    lexer.finish_command("&&");
                    index += 2;
                } else {
                    lexer.finish_command("&");
                    index += 1;
                }
            }
            _ => {
                lexer.open(index);
                lexer.word.push(char);
                index += 1;
            }
        }
    }
    lexer.finish_word(bytes.len());
    lexer.finish_command("");
    lexer.commands
}

/// Program name of a word: the last path segment without a script or executable extension.
pub fn program_name(word: &str) -> String {
    let normalized = word.replace('\\', "/");
    let base = normalized.rsplit('/').next().unwrap_or(&normalized);
    let lower = base.to_ascii_lowercase();
    for extension in [".exe", ".cmd", ".bat", ".ps1"] {
        if lower.ends_with(extension) {
            return base[..base.len() - extension.len()].to_string();
        }
    }
    base.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(source: &str) -> Vec<Vec<String>> {
        parse_shell(source)
            .into_iter()
            .map(|command| command.argv)
            .collect()
    }

    #[test]
    fn splits_simple_commands_and_operators() {
        let commands = parse_shell("cd a && npm test | tee log.txt; echo done &");
        let nexts: Vec<&str> = commands
            .iter()
            .map(|command| command.next.as_str())
            .collect();
        assert_eq!(nexts, ["&&", "|", ";", "&"]);
        assert_eq!(
            argv("cd a && npm test"),
            [vec!["cd", "a"], vec!["npm", "test"]]
        );
    }

    #[test]
    fn respects_quotes_and_records_redirections() {
        assert_eq!(
            argv(r#"grep ">=" "a b.txt""#),
            [vec!["grep", ">=", "a b.txt"]]
        );
        let commands = parse_shell("npm test > out.log 2>&1");
        assert_eq!(commands[0].argv, ["npm", "test"]);
        assert_eq!(commands[0].outputs, ["out.log"]);
        assert_eq!(
            parse_shell("cmd > /dev/null 2>&1")[0].outputs,
            Vec::<String>::new()
        );
    }

    #[test]
    fn skips_heredoc_bodies() {
        let commands = parse_shell("cat > a.md <<'EOF'\nnpm test\nrm -rf x\nEOF\nls");
        let programs: Vec<&str> = commands
            .iter()
            .map(|command| command.argv[0].as_str())
            .collect();
        assert_eq!(programs, ["cat", "ls"]);
        assert_eq!(commands[0].outputs, ["a.md"]);
    }

    #[test]
    fn names_programs_without_paths_or_extensions() {
        assert_eq!(program_name("./node_modules/.bin/vitest"), "vitest");
        assert_eq!(program_name("C:\\tools\\npm.cmd"), "npm");
    }
}
