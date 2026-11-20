//! What the tools inherit from JavaScript and Node: `localeCompare`'s order, `Array.slice`'s
//! indices, and the wording of Node's file system errors.

use std::cmp::Ordering;
use std::io;

use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/// Lowercased ASCII in the order ICU's root collation gives it, which is what `localeCompare`
/// does for every locale the tools run in: spaces and punctuation, then symbols, digits and
/// letters. Measured with Node: comparing character by character with this rank matches
/// `localeCompare` on every pair of lowercased ASCII names.
const ASCII_ORDER: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

fn primary(character: char) -> u32 {
    match ASCII_ORDER.find(character) {
        Some(rank) => rank as u32,
        None => 0x100 + character as u32,
    }
}

/// The primary weights (characters without their accents) and the accent on each.
fn collation_key(text: &str) -> (Vec<u32>, Vec<u32>) {
    let mut primaries = Vec::new();
    let mut accents = Vec::new();
    for character in text.nfd() {
        if is_combining_mark(character) && !accents.is_empty() {
            let last = accents.len() - 1;
            accents[last] = accents[last] * 0x1_0000 + character as u32;
        } else {
            primaries.push(primary(character));
            accents.push(0);
        }
    }
    (primaries, accents)
}

/// `a.localeCompare(b)` for the names the tools sort: exact for ASCII; other letters compare by
/// their base letter, then their accents, as ICU does for Latin text.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let (a_primary, a_accents) = collation_key(a);
    let (b_primary, b_accents) = collation_key(b);
    a_primary
        .cmp(&b_primary)
        .then_with(|| a_accents.cmp(&b_accents))
        .then_with(|| a.cmp(b))
}

/// An `Array.slice` index: truncated toward zero, counted from the end when negative, within the
/// length.
pub fn slice_index(value: f64, len: usize) -> usize {
    let value = if value.is_nan() { 0.0 } else { value.trunc() };
    let len = len as f64;
    let index = if value < 0.0 {
        (len + value).max(0.0)
    } else {
        value.min(len)
    };
    index as usize
}

/// `items.slice(start, end)`.
pub fn slice<T>(items: &[T], start: f64, end: Option<f64>) -> &[T] {
    let start = slice_index(start, items.len());
    let end = end.map_or(items.len(), |end| slice_index(end, items.len()));
    if start >= end {
        &[]
    } else {
        &items[start..end]
    }
}

/// A number as JavaScript writes it in a template string.
pub fn number(value: f64) -> String {
    relay_ai::text::js_number_to_string(value)
}

/// A file system error as Node words it: `ENOENT: no such file or directory, access '/x'`.
pub fn fs_error(error: &io::Error, syscall: &str, path: &str) -> String {
    let (code, description) = match error.kind() {
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        _ => return format!("{error}, {syscall} '{path}'"),
    };
    format!("{code}: {description}, {syscall} '{path}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_and_slices_as_javascript_does() {
        let mut names = vec![
            "zeta", "10.txt", "9.txt", "_x", ".d", "école", "ecole", "eclair",
        ];
        names.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            names,
            ["_x", ".d", "10.txt", "9.txt", "eclair", "ecole", "école", "zeta"]
        );
        let items = [1, 2, 3, 4];
        assert_eq!(slice(&items, 0.0, Some(-1.0)), &[1, 2, 3]);
        assert_eq!(slice(&items, 1.5, None), &[2, 3, 4]);
        assert!(slice(&items, 3.0, Some(1.0)).is_empty());
    }
}
