//! JavaScript regular expressions (`new RegExp(pattern, "u")`) on `fancy-regex`, which has the
//! lookarounds and backreferences JavaScript has. JavaScript's `\d` and `\w` are ASCII even with
//! the `u` flag, Rust's are Unicode, so they are spelled out as ASCII classes.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use fancy_regex::Regex;
use serde_json::{Map, Value};

/// A JavaScript pattern rewritten for Rust: `\d`, `\D`, `\w`, `\W` as ASCII classes.
fn translate(pattern: &str) -> String {
    let mut translated = String::with_capacity(pattern.len());
    let mut in_class = false;
    let mut characters = pattern.chars();
    while let Some(character) = characters.next() {
        match character {
            '\\' => match characters.next() {
                Some('d') => translated.push_str(if in_class { "0-9" } else { "[0-9]" }),
                Some('w') => translated.push_str(if in_class {
                    "A-Za-z0-9_"
                } else {
                    "[A-Za-z0-9_]"
                }),
                Some('D') if !in_class => translated.push_str("[^0-9]"),
                Some('W') if !in_class => translated.push_str("[^A-Za-z0-9_]"),
                Some(next) => {
                    translated.push('\\');
                    translated.push(next);
                }
                None => translated.push('\\'),
            },
            '[' if !in_class => {
                in_class = true;
                translated.push(character);
            }
            ']' if in_class => {
                in_class = false;
                translated.push(character);
            }
            _ => translated.push(character),
        }
    }
    translated
}

/// A compiled JavaScript pattern; `None` when it does not compile. Compiled once per pattern.
pub(crate) fn js_regex(pattern: &str) -> Option<Regex> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<Regex>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Mutex::default);
    if let Some(regex) = cache.lock().ok()?.get(pattern) {
        return regex.clone();
    }
    let regex = Regex::new(&translate(pattern)).ok();
    cache
        .lock()
        .ok()?
        .insert(pattern.to_string(), regex.clone());
    regex
}

/// `GetPropertiesPattern`: the schema's known property names (escaped, anchored) and pattern
/// properties as one alternation; `None` when there are none (`(?!)`, which matches nothing).
pub(crate) fn property_pattern(schema: &Map<String, Value>) -> Option<Regex> {
    let mut patterns: Vec<String> = Vec::new();
    if let Some(Value::Object(patterned)) = schema.get("patternProperties") {
        patterns.extend(patterned.keys().cloned());
    }
    if let Some(Value::Object(properties)) = schema.get("properties") {
        patterns.extend(
            properties
                .keys()
                .map(|key| format!("^{}$", fancy_regex::escape(key))),
        );
    }
    if patterns.is_empty() {
        return None;
    }
    js_regex(&format!("({})", patterns.join("|")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digits_and_words_are_ascii() {
        let digits = js_regex(r"^\d+$").unwrap();
        assert!(digits.is_match("123").unwrap());
        assert!(!digits.is_match("١٢٣").unwrap());
        let class = js_regex(r"^[\d.]+$").unwrap();
        assert!(class.is_match("1.5").unwrap());
        let words = js_regex(r"^\w+$").unwrap();
        assert!(!words.is_match("café").unwrap());
        assert!(js_regex(r"^(?=a)a\/b$").unwrap().is_match("a/b").unwrap());
        assert!(js_regex("(").is_none());
    }
}
