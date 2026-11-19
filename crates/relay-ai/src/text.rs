//! String rules the TypeScript code gets from JavaScript, which Rust's standard library defines
//! differently.

/// Whitespace as `String.prototype.trim` removes it: ECMAScript WhiteSpace and LineTerminator.
/// Rust's `char::is_whitespace` differs at U+0085 (whitespace to Rust only) and U+FEFF (to
/// JavaScript only).
pub fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `text.trim()`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `text.trim().length === 0`.
pub fn is_blank(text: &str) -> bool {
    text.chars().all(is_js_whitespace)
}

/// Replace every UTF-16 code unit outside `[A-Za-z0-9_-]` with `_` and keep the first 64 code
/// units, as `id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)` does: a character outside the
/// Basic Multilingual Plane is two code units, so it becomes `__`.
pub fn normalize_tool_call_id(id: &str) -> String {
    let mut normalized = String::with_capacity(id.len());
    for character in id.chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            normalized.push(character);
        } else {
            for _ in 0..character.len_utf16() {
                normalized.push('_');
            }
        }
    }
    normalized.truncate(64);
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_like_javascript() {
        assert_eq!(js_trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
        assert!(is_blank(" \t\u{2028}"));
        assert!(!is_blank("\u{85}"));
    }

    #[test]
    fn normalizes_tool_call_ids_by_code_unit() {
        assert_eq!(
            normalize_tool_call_id("fc_123|abc+def==/🙈"),
            "fc_123_abc_def_____"
        );
        assert_eq!(normalize_tool_call_id(&"a".repeat(70)).len(), 64);
    }
}
