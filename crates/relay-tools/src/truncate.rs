//! Tool output limits (`truncate.ts`): two independent limits, lines and bytes, the first hit
//! wins. Head truncation keeps the start (file reads), tail truncation the end (command output),
//! middle truncation both ends. Complete lines only, except a tail whose last line alone is too
//! long.

use serde::Serialize;

pub const DEFAULT_MAX_LINES: u64 = 2000;
pub const DEFAULT_MAX_BYTES: u64 = 50 * 1024;
/// Characters per grep match line.
pub const GREP_MAX_LINE_LENGTH: usize = 500;

/// Which limit cut the content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TruncatedBy {
    Lines,
    Bytes,
}

/// A truncation and what it kept (`TruncationResult`), as the tools report it in `details`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncationResult {
    pub content: String,
    pub truncated: bool,
    pub truncated_by: Option<TruncatedBy>,
    pub total_lines: u64,
    pub total_bytes: u64,
    /// Complete lines kept.
    pub output_lines: u64,
    pub output_bytes: u64,
    /// The kept last line is only its end (tail truncation of one long line).
    pub last_line_partial: bool,
    /// The first line alone is over the byte limit (head truncation): nothing is kept.
    pub first_line_exceeds_limit: bool,
    pub max_lines: u64,
    pub max_bytes: u64,
}

/// The limits; `None` is the default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TruncationOptions {
    pub max_lines: Option<u64>,
    pub max_bytes: Option<u64>,
}

/// The lines a count sees: none for empty content, and no empty line after a final newline.
fn counted_lines(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if content.ends_with('\n') {
        lines.pop();
    }
    lines
}

/// `formatSize`: bytes, or KB and MB with one decimal, rounded as JavaScript's `toFixed` rounds
/// (an exact half rounds up).
pub fn format_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * 1024;
    let tenths = |unit: u64| (bytes * 10 + unit / 2) / unit;
    if bytes < KB {
        format!("{bytes}B")
    } else if bytes < MB {
        let tenths = tenths(KB);
        format!("{}.{}KB", tenths / 10, tenths % 10)
    } else {
        let tenths = tenths(MB);
        format!("{}.{}MB", tenths / 10, tenths % 10)
    }
}

fn untruncated(
    content: &str,
    total_lines: u64,
    total_bytes: u64,
    max_lines: u64,
    max_bytes: u64,
) -> TruncationResult {
    TruncationResult {
        content: content.to_string(),
        truncated: false,
        truncated_by: None,
        total_lines,
        total_bytes,
        output_lines: total_lines,
        output_bytes: total_bytes,
        last_line_partial: false,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

/// Keeps the first lines that fit (`truncateHead`). A first line over the byte limit keeps
/// nothing.
pub fn truncate_head(content: &str, options: TruncationOptions) -> TruncationResult {
    let max_lines = options.max_lines.unwrap_or(DEFAULT_MAX_LINES);
    let max_bytes = options.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    let total_bytes = content.len() as u64;
    let lines = counted_lines(content);
    let total_lines = lines.len() as u64;
    if total_lines <= max_lines && total_bytes <= max_bytes {
        return untruncated(content, total_lines, total_bytes, max_lines, max_bytes);
    }
    if lines[0].len() as u64 > max_bytes {
        return TruncationResult {
            content: String::new(),
            truncated: true,
            truncated_by: Some(TruncatedBy::Bytes),
            total_lines,
            total_bytes,
            output_lines: 0,
            output_bytes: 0,
            last_line_partial: false,
            first_line_exceeds_limit: true,
            max_lines,
            max_bytes,
        };
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut bytes = 0;
    let mut truncated_by = TruncatedBy::Lines;
    for (index, line) in lines.iter().enumerate() {
        if index as u64 >= max_lines {
            break;
        }
        let line_bytes = line.len() as u64 + u64::from(index > 0);
        if bytes + line_bytes > max_bytes {
            truncated_by = TruncatedBy::Bytes;
            break;
        }
        kept.push(line);
        bytes += line_bytes;
    }
    if kept.len() as u64 >= max_lines && bytes <= max_bytes {
        truncated_by = TruncatedBy::Lines;
    }
    let output = kept.join("\n");
    TruncationResult {
        output_bytes: output.len() as u64,
        content: output,
        truncated: true,
        truncated_by: Some(truncated_by),
        total_lines,
        total_bytes,
        output_lines: kept.len() as u64,
        last_line_partial: false,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

/// The end of `text` within `max_bytes`, starting at a character boundary.
fn tail_bytes(text: &str, max_bytes: u64) -> &str {
    let bytes = text.as_bytes();
    if bytes.len() as u64 <= max_bytes {
        return text;
    }
    let mut start = bytes.len() - max_bytes as usize;
    while start < bytes.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// Keeps the last lines that fit (`truncateTail`). When the last line alone is too long, its
/// end is kept.
pub fn truncate_tail(content: &str, options: TruncationOptions) -> TruncationResult {
    let max_lines = options.max_lines.unwrap_or(DEFAULT_MAX_LINES);
    let max_bytes = options.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    let total_bytes = content.len() as u64;
    let lines = counted_lines(content);
    let total_lines = lines.len() as u64;
    if total_lines <= max_lines && total_bytes <= max_bytes {
        return untruncated(content, total_lines, total_bytes, max_lines, max_bytes);
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut bytes = 0;
    let mut truncated_by = TruncatedBy::Lines;
    let mut last_line_partial = false;
    for line in lines.iter().rev() {
        if kept.len() as u64 >= max_lines {
            break;
        }
        let line_bytes = line.len() as u64 + u64::from(!kept.is_empty());
        if bytes + line_bytes > max_bytes {
            truncated_by = TruncatedBy::Bytes;
            if kept.is_empty() {
                let end = tail_bytes(line, max_bytes);
                kept.push(end);
                bytes = end.len() as u64;
                last_line_partial = true;
            }
            break;
        }
        kept.push(line);
        bytes += line_bytes;
    }
    if kept.len() as u64 >= max_lines && bytes <= max_bytes {
        truncated_by = TruncatedBy::Lines;
    }
    kept.reverse();
    let output = kept.join("\n");
    TruncationResult {
        output_bytes: output.len() as u64,
        content: output,
        truncated: true,
        truncated_by: Some(truncated_by),
        total_lines,
        total_bytes,
        output_lines: kept.len() as u64,
        last_line_partial,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

/// A line cut to `max_chars` UTF-16 units with a `... [truncated]` suffix (`truncateLine`), for
/// grep matches. JavaScript can cut a surrogate pair in half; here the cut moves back to the
/// character's start, since a Rust string cannot hold half a character.
pub fn truncate_line(line: &str, max_chars: usize) -> (String, bool) {
    let units: usize = line.chars().map(char::len_utf16).sum();
    if units <= max_chars {
        return (line.to_string(), false);
    }
    let mut taken = 0;
    let mut end = 0;
    for (index, character) in line.char_indices() {
        if taken + character.len_utf16() > max_chars {
            break;
        }
        taken += character.len_utf16();
        end = index + character.len_utf8();
    }
    (format!("{}... [truncated]", &line[..end]), true)
}

/// The start and end of a content too long for `max_bytes`, half each (`truncateMiddle`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiddleTruncationResult {
    /// With a `…N chars truncated…` marker between the two ends.
    pub content: String,
    pub truncated: bool,
    /// Characters left out.
    pub removed_chars: u64,
    pub total_bytes: u64,
    pub total_lines: u64,
}

/// Keeps both ends of `content`, cutting at character boundaries (`truncateMiddle`).
pub fn truncate_middle(content: &str, max_bytes: u64) -> MiddleTruncationResult {
    let total_bytes = content.len() as u64;
    let total_lines = counted_lines(content).len() as u64;
    if total_bytes <= max_bytes {
        return MiddleTruncationResult {
            content: content.to_string(),
            truncated: false,
            removed_chars: 0,
            total_bytes,
            total_lines,
        };
    }
    let mut head_end = (max_bytes / 2) as usize;
    while head_end > 0 && !content.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut tail_start = content.len() - (max_bytes - max_bytes / 2) as usize;
    while tail_start < content.len() && !content.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    let removed_chars = content[head_end..tail_start].chars().count() as u64;
    MiddleTruncationResult {
        content: format!(
            "{}…{removed_chars} chars truncated…{}",
            &content[..head_end],
            &content[tail_start..]
        ),
        truncated: true,
        removed_chars,
        total_bytes,
        total_lines,
    }
}
