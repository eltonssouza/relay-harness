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

/// `text.replace(/[^a-zA-Z0-9_-]/g, "_")`: every UTF-16 code unit outside the set becomes `_`, so
/// a character outside the Basic Multilingual Plane becomes `__`. The result is ASCII.
pub fn replace_non_id_characters(text: &str) -> String {
    let mut replaced = String::with_capacity(text.len());
    for character in text.chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            replaced.push(character);
        } else {
            for _ in 0..character.len_utf16() {
                replaced.push('_');
            }
        }
    }
    replaced
}

/// Anthropic's tool call id rule: the id characters, at most 64.
pub fn normalize_tool_call_id(id: &str) -> String {
    let mut normalized = replace_non_id_characters(id);
    normalized.truncate(64);
    normalized
}

/// `text.length`: the length in UTF-16 code units.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `shortHash` from `packages/ai/src/utils/hash.ts`: a fast hash of the UTF-16 code units,
/// written as two base-36 numbers.
pub fn short_hash(text: &str) -> String {
    let mut h1: u32 = 0xdead_beef;
    let mut h2: u32 = 0x41c6_ce57;
    for unit in text.encode_utf16() {
        let unit = u32::from(unit);
        h1 = (h1 ^ unit).wrapping_mul(2_654_435_761);
        h2 = (h2 ^ unit).wrapping_mul(1_597_334_677);
    }
    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2_246_822_507)
        ^ (h2 ^ (h2 >> 13)).wrapping_mul(3_266_489_909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2_246_822_507)
        ^ (h1 ^ (h1 >> 13)).wrapping_mul(3_266_489_909);
    format!("{}{}", base36(h2), base36(h1))
}

fn base36(mut value: u32) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
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
