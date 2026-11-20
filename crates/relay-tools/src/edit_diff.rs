//! How the edit tool finds and applies replacements (`edit-diff.ts`): every `oldText` matched
//! against the original, exactly or, failing that, after normalizing both sides (NFKC, trailing
//! whitespace, smart quotes, dashes, unusual spaces). A fuzzy match rewrites only the lines it
//! touches, so the other lines keep their original bytes.
//!
//! Offsets are byte offsets here and UTF-16 offsets in TypeScript; each is used only within its
//! own strings, so the results are the same.

use relay_ai::text::is_js_whitespace;
use unicode_normalization::UnicodeNormalization;

/// One replacement the model asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub old_text: String,
    pub new_text: String,
}

/// `\r\n` when the first line break is one, else `\n` (`detectLineEnding`).
pub fn detect_line_ending(content: &str) -> &'static str {
    match (content.find("\r\n"), content.find('\n')) {
        (Some(crlf), Some(lf)) if crlf < lf => "\r\n",
        _ => "\n",
    }
}

/// `\r\n` and lone `\r` as `\n` (`normalizeToLF`).
pub fn normalize_to_lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// `restoreLineEndings`.
pub fn restore_line_endings(text: &str, ending: &str) -> String {
    if ending == "\r\n" {
        text.replace('\n', "\r\n")
    } else {
        text.to_string()
    }
}

/// `normalizeForFuzzyMatch`.
pub fn normalize_for_fuzzy_match(text: &str) -> String {
    let composed: String = text.nfkc().collect();
    let trimmed = composed
        .split('\n')
        .map(|line| line.trim_end_matches(is_js_whitespace))
        .collect::<Vec<_>>()
        .join("\n");
    trimmed
        .chars()
        .map(|character| match character {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

/// A match: where it starts and how long it is, in the content it was found in.
struct Found {
    index: usize,
    length: usize,
    fuzzy: bool,
}

/// `fuzzyFindText`: the exact text, else the normalized text in the normalized content.
fn fuzzy_find(content: &str, old_text: &str) -> Option<Found> {
    if let Some(index) = content.find(old_text) {
        return Some(Found {
            index,
            length: old_text.len(),
            fuzzy: false,
        });
    }
    let fuzzy_content = normalize_for_fuzzy_match(content);
    let fuzzy_old = normalize_for_fuzzy_match(old_text);
    fuzzy_content.find(&fuzzy_old).map(|index| Found {
        index,
        length: fuzzy_old.len(),
        fuzzy: true,
    })
}

fn count_occurrences(content: &str, old_text: &str) -> usize {
    normalize_for_fuzzy_match(content)
        .matches(&normalize_for_fuzzy_match(old_text))
        .count()
}

#[derive(Debug, Clone)]
struct Replacement {
    edit_index: usize,
    index: usize,
    length: usize,
    new_text: String,
}

/// Lines with their `\n` (`splitLinesWithEndings`).
fn lines_with_endings(content: &str) -> Vec<&str> {
    content.split_inclusive('\n').collect()
}

/// Each line's span, by offset.
fn line_spans(content: &str) -> Vec<(usize, usize)> {
    let mut offset = 0;
    lines_with_endings(content)
        .into_iter()
        .map(|line| {
            let span = (offset, offset + line.len());
            offset = span.1;
            span
        })
        .collect()
}

/// The lines a replacement touches (`getReplacementLineRange`): `[start, end)`.
fn replacement_lines(
    lines: &[(usize, usize)],
    replacement: &Replacement,
) -> Result<(usize, usize), String> {
    let outside = || "Replacement range is outside the base content.".to_string();
    let start = replacement.index;
    let end = replacement.index + replacement.length;
    let first = lines
        .iter()
        .position(|&(line_start, line_end)| start >= line_start && start < line_end)
        .ok_or_else(outside)?;
    let mut last = first;
    while last < lines.len() && lines[last].1 < end {
        last += 1;
    }
    if last >= lines.len() {
        return Err(outside());
    }
    Ok((first, last + 1))
}

/// `applyReplacements`: from the last to the first, so earlier offsets stay valid.
fn apply_replacements(content: &str, replacements: &[Replacement], offset: usize) -> String {
    let mut result = content.to_string();
    for replacement in replacements.iter().rev() {
        let index = replacement.index - offset;
        result.replace_range(index..index + replacement.length, &replacement.new_text);
    }
    result
}

/// `applyReplacementsPreservingUnchangedLines`: the lines the replacements touch are rewritten
/// from the normalized base; every other line is copied from the original.
fn apply_preserving_unchanged_lines(
    original: &str,
    base: &str,
    replacements: &[Replacement],
) -> Result<String, String> {
    let original_lines = lines_with_endings(original);
    let base_lines = line_spans(base);
    if original_lines.len() != base_lines.len() {
        return Err(
            "Cannot preserve unchanged lines because the base content has a different line count."
                .into(),
        );
    }
    let mut sorted = replacements.to_vec();
    sorted.sort_by_key(|replacement| replacement.index);
    let mut groups: Vec<(usize, usize, Vec<Replacement>)> = Vec::new();
    for replacement in sorted {
        let (start, end) = replacement_lines(&base_lines, &replacement)?;
        match groups.last_mut() {
            Some(group) if start < group.1 => {
                group.1 = group.1.max(end);
                group.2.push(replacement);
            }
            _ => groups.push((start, end, vec![replacement])),
        }
    }
    let mut result = String::new();
    let mut next_line = 0;
    for (start, end, group) in &groups {
        result.push_str(&original_lines[next_line..*start].concat());
        let from = base_lines[*start].0;
        let to = base_lines[end - 1].1;
        result.push_str(&apply_replacements(&base[from..to], group, from));
        next_line = *end;
    }
    result.push_str(&original_lines[next_line..].concat());
    Ok(result)
}

/// The content the edits apply to, and the content after them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedEdits {
    pub base: String,
    pub new: String,
}

/// `applyEditsToNormalizedContent`: the edits on LF-normalized content, or the error the model
/// receives.
pub fn apply_edits(normalized: &str, edits: &[Edit], path: &str) -> Result<AppliedEdits, String> {
    let total = edits.len();
    let edits: Vec<Edit> = edits
        .iter()
        .map(|edit| Edit {
            old_text: normalize_to_lf(&edit.old_text),
            new_text: normalize_to_lf(&edit.new_text),
        })
        .collect();
    for (index, edit) in edits.iter().enumerate() {
        if edit.old_text.is_empty() {
            return Err(if total == 1 {
                format!("oldText must not be empty in {path}.")
            } else {
                format!("edits[{index}].oldText must not be empty in {path}.")
            });
        }
    }
    let fuzzy = edits
        .iter()
        .any(|edit| fuzzy_find(normalized, &edit.old_text).is_some_and(|found| found.fuzzy));
    let replacement_base = if fuzzy {
        normalize_for_fuzzy_match(normalized)
    } else {
        normalized.to_string()
    };

    let mut replacements = Vec::new();
    for (index, edit) in edits.iter().enumerate() {
        let Some(found) = fuzzy_find(&replacement_base, &edit.old_text) else {
            return Err(if total == 1 {
                format!("Could not find the exact text in {path}. The old text must match exactly including all whitespace and newlines.")
            } else {
                format!("Could not find edits[{index}] in {path}. The oldText must match exactly including all whitespace and newlines.")
            });
        };
        let occurrences = count_occurrences(&replacement_base, &edit.old_text);
        if occurrences > 1 {
            return Err(if total == 1 {
                format!("Found {occurrences} occurrences of the text in {path}. The text must be unique. Please provide more context to make it unique.")
            } else {
                format!("Found {occurrences} occurrences of edits[{index}] in {path}. Each oldText must be unique. Please provide more context to make it unique.")
            });
        }
        replacements.push(Replacement {
            edit_index: index,
            index: found.index,
            length: found.length,
            new_text: edit.new_text.clone(),
        });
    }
    replacements.sort_by_key(|replacement| replacement.index);
    for pair in replacements.windows(2) {
        if pair[0].index + pair[0].length > pair[1].index {
            return Err(format!(
                "edits[{}] and edits[{}] overlap in {path}. Merge them into one edit or target disjoint regions.",
                pair[0].edit_index, pair[1].edit_index
            ));
        }
    }
    let new = if fuzzy {
        apply_preserving_unchanged_lines(normalized, &replacement_base, &replacements)?
    } else {
        apply_replacements(&replacement_base, &replacements, 0)
    };
    if new == normalized {
        return Err(if total == 1 {
            format!("No changes made to {path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.")
        } else {
            format!("No changes made to {path}. The replacements produced identical content.")
        });
    }
    Ok(AppliedEdits {
        base: normalized.to_string(),
        new,
    })
}
