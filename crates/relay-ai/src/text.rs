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

/// `Number.parseFloat(text)`: the longest decimal number at the start, after leading
/// whitespace (`5 seconds` is 5, `2023-11-14` is 2023), `Infinity` with an optional sign, or NaN.
pub fn js_parse_float(text: &str) -> f64 {
    let text = text.trim_start_matches(is_js_whitespace);
    let bytes = text.as_bytes();
    let mut end = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end = 1;
    }
    if text[end..].starts_with("Infinity") {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count()
    };
    let integer = digits(end);
    end += integer;
    let mut fraction = 0;
    if bytes.get(end) == Some(&b'.') {
        fraction = digits(end + 1);
        if integer > 0 || fraction > 0 {
            end += 1 + fraction;
        }
    }
    if integer == 0 && fraction == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        let exponent = digits(end + 1 + sign);
        if exponent > 0 {
            end += 1 + sign + exponent;
        }
    }
    text[..end].parse().unwrap_or(f64::NAN)
}

/// `Number(text)` (StringToNumber): the whole string, trimmed, as a decimal, `Infinity`, or a
/// `0x`/`0o`/`0b` integer; empty is 0, anything else NaN.
pub fn js_string_to_number(text: &str) -> f64 {
    let text = js_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let radix = match text.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &text[2..];
        if digits.is_empty() || !digits.chars().all(|digit| digit.is_digit(radix)) {
            return f64::NAN;
        }
        return digits.chars().fold(0.0, |total, digit| {
            total * f64::from(radix) + f64::from(digit.to_digit(radix).unwrap_or(0))
        });
    }
    let (negative, unsigned) = match text.as_bytes()[0] {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    if unsigned == "Infinity" {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let bytes = unsigned.as_bytes();
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count()
    };
    let integer = digits(0);
    let mut end = integer;
    let mut fraction = 0;
    if bytes.get(end) == Some(&b'.') {
        fraction = digits(end + 1);
        end += 1 + fraction;
    }
    if integer == 0 && fraction == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        let exponent = digits(end + 1 + sign);
        if exponent == 0 {
            return f64::NAN;
        }
        end += 1 + sign + exponent;
    }
    if end != bytes.len() {
        return f64::NAN;
    }
    let value: f64 = unsigned.parse().unwrap_or(f64::NAN);
    if negative {
        -value
    } else {
        value
    }
}

/// `String(number)` (Number::toString): the shortest digits that read back as the number, with an
/// exponent from 1e21 up and below 1e-6.
pub fn js_number_to_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".into();
    }
    if number == 0.0 {
        return "0".into();
    }
    if number.is_infinite() {
        return if number < 0.0 {
            "-Infinity"
        } else {
            "Infinity"
        }
        .into();
    }
    if number < 0.0 {
        return format!("-{}", js_number_to_string(-number));
    }
    // `{:e}` writes the shortest round-trip digits: d.ddde±x.
    let scientific = format!("{number:e}");
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let k = digits.len() as i64;
    let n = exponent.parse::<i64>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let sign = if n - 1 < 0 { "-" } else { "+" };
        let exponent = (n - 1).abs();
        if k == 1 {
            format!("{digits}e{sign}{exponent}")
        } else {
            format!("{}.{}e{sign}{exponent}", &digits[..1], &digits[1..])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_numbers_as_javascript_does() {
        for (text, expected) in [
            ("", 0.0),
            (" 12 ", 12.0),
            ("1e3", 1000.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("-0x10", f64::NAN),
            ("0x10", 16.0),
            ("0b101", 5.0),
            ("-Infinity", f64::NEG_INFINITY),
            ("1e", f64::NAN),
            ("12px", f64::NAN),
            ("inf", f64::NAN),
        ] {
            let value = js_string_to_number(text);
            assert!(
                value == expected || (value.is_nan() && expected.is_nan()),
                "{text:?} -> {value}"
            );
        }
        for (number, expected) in [
            (1.0, "1"),
            (1.5, "1.5"),
            (-2.25, "-2.25"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.1 + 0.2, "0.30000000000000004"),
            (2.5e25, "2.5e+25"),
        ] {
            assert_eq!(js_number_to_string(number), expected);
        }
    }

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
