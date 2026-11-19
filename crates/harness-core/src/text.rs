//! Text helpers shared by the pillars. Port of `packages/agent/src/harness/text.ts`.
//!
//! The lexicons use JavaScript regex features the `regex` crate lacks (lookbehind, lookahead,
//! backreferences), so they run on `fancy-regex`. JavaScript's `\b` and `\w` are ASCII even with
//! the `u` flag; [`ASCII_B`] and `[A-Za-z0-9_]` stand in for them.

use fancy_regex::Regex;

/// JavaScript's ASCII word boundary `\b`.
pub const ASCII_B: &str =
    r"(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))";

/// Word boundaries that also hold around accented letters.
const WORD_START: &str = r"(?<![\p{L}\p{N}_])";
const WORD_END: &str = r"(?![\p{L}\p{N}_])";

/// A compiled pattern whose matching never fails: a pattern that hits the backtracking limit does
/// not match, as a rule that cannot tell should not fire.
pub struct Pattern(Regex);

impl Pattern {
    pub fn new(source: &str) -> Self {
        Self(
            Regex::new(source)
                .unwrap_or_else(|error| panic!("invalid harness pattern {source:?}: {error}")),
        )
    }

    pub fn test(&self, text: &str) -> bool {
        self.0.is_match(text).unwrap_or(false)
    }

    pub fn regex(&self) -> &Regex {
        &self.0
    }
}

/// Case-insensitive Unicode pattern matching any of `words` as whole words. Entries may contain regex syntax.
pub fn words_pattern(words: &[&str]) -> Pattern {
    Pattern::new(&format!("(?i){}", words_source(words)))
}

/// The source of a whole-words alternation, to embed in a larger pattern.
pub fn words_source(words: &[&str]) -> String {
    format!("{WORD_START}(?:{}){WORD_END}", words.join("|"))
}

/// Case-insensitive pattern for `lead` words, optionally one more word that is not one of
/// `excluded`, then `verbs`: "do not use", "não altere", "never directly push".
pub fn phrase_pattern(lead: &[&str], verbs: &[&str], excluded: &[&str]) -> Pattern {
    let middle = if excluded.is_empty() {
        String::new()
    } else {
        format!("(?!(?:{}){WORD_END})", excluded.join("|"))
    };
    Pattern::new(&format!(
        r"(?i){WORD_START}(?:{})\s+(?:{middle}[\p{{L}}']+\s+)?(?:{}){WORD_END}",
        lead.join("|"),
        verbs.join("|")
    ))
}

/// Developer-authored prose of a message: drops fenced code and XML-like blocks such as expanded
/// skills (`<skill>`) or attached files (`<file>`), whose wording is not the developer's instruction.
pub fn developer_prose(text: &str) -> String {
    use std::sync::OnceLock;
    static FENCE: OnceLock<Pattern> = OnceLock::new();
    static BLOCK: OnceLock<Pattern> = OnceLock::new();
    let fence = FENCE.get_or_init(|| Pattern::new(r"```[\s\S]*?```"));
    let block = BLOCK.get_or_init(|| {
        Pattern::new(&format!(
            r"<([A-Za-z][A-Za-z0-9_-]*){ASCII_B}[^>]*>[\s\S]*?</\1>"
        ))
    });
    let without_fences = fence.regex().replace_all(text, " ");
    let without_blocks = block.regex().replace_all(&without_fences, " ");
    trim_js(&without_blocks).to_string()
}

/// JavaScript's `String.prototype.trim`: whitespace and line terminators at both ends.
pub fn trim_js(text: &str) -> &str {
    text.trim_matches(|char: char| char.is_whitespace() || char == '\u{feff}')
}

/// Length in UTF-16 code units, as JavaScript's `length`.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Truncate to `max` UTF-16 code units with an ellipsis, on one line.
pub fn clip(text: &str, max: usize) -> String {
    let single_line = trim_js(&text.split_whitespace().collect::<Vec<_>>().join(" ")).to_string();
    if js_length(&single_line) <= max {
        return single_line;
    }
    let units: Vec<u16> = single_line
        .encode_utf16()
        .take(max.saturating_sub(3))
        .collect();
    format!("{}...", String::from_utf16_lossy(&units))
}

/// Splits `text` where `separator` matches, like JavaScript's `split` with a regex (no captures).
pub fn split_by(text: &str, separator: &Pattern) -> Vec<String> {
    let mut parts = Vec::new();
    let mut last = 0;
    for found in separator.regex().find_iter(text).flatten() {
        if found.start() == found.end() {
            continue;
        }
        parts.push(text[last..found.start()].to_string());
        last = found.end();
    }
    parts.push(text[last..].to_string());
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_whole_words_around_accents() {
        let pattern = words_pattern(&["não altere"]);
        assert!(pattern.test("Não altere os testes"));
        assert!(!pattern.test("nãoaltere"));
    }

    #[test]
    fn drops_code_and_expanded_blocks() {
        assert_eq!(
            developer_prose("Fix it\n```\nrm -rf x\n```\n<skill name=\"a\">Always x</skill>"),
            "Fix it"
        );
    }

    #[test]
    fn clips_to_one_line() {
        assert_eq!(clip("a\n  b", 10), "a b");
        assert_eq!(clip("abcdefghij", 6), "abc...");
    }
}
