//! Line diffs as jsdiff 8 (`diff` on npm) computes them, which the edit tool shows the model:
//! `diffLines` (Myers' algorithm with jsdiff's choices among equally short edits),
//! `createTwoFilesPatch` with file headers only, and the edit tool's numbered display diff
//! (`generateDiffString` in `edit-diff.ts`).
//!
//! Another diff implementation can pick other, equally short edits, so this follows jsdiff's
//! `base.js` step by step: which diagonal a path extends from, when a pruned path is dropped, how
//! components merge.

/// A run of lines that are common, added or removed (`ChangeObject`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub value: String,
    pub count: usize,
    pub added: bool,
    pub removed: bool,
}

/// Lines with their line breaks (`\n` or `\r\n`), as jsdiff's line tokenizer splits them.
fn tokenize(text: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        let end = if bytes[index] == b'\n' {
            Some(index + 1)
        } else if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
            Some(index + 2)
        } else {
            None
        };
        match end {
            Some(end) => {
                tokens.push(&text[start..end]);
                start = end;
                index = end;
            }
            None => index += 1,
        }
    }
    if start < text.len() {
        tokens.push(&text[start..]);
    }
    tokens.retain(|token| !token.is_empty());
    tokens
}

#[derive(Clone, Copy)]
struct Component {
    count: usize,
    added: bool,
    removed: bool,
    previous: Option<usize>,
}

#[derive(Clone, Copy)]
struct Path {
    old_pos: isize,
    last: Option<usize>,
}

struct Search<'a> {
    old: &'a [&'a str],
    new: &'a [&'a str],
    components: Vec<Component>,
}

impl Search<'_> {
    /// `addToPath`: one more added or removed token, merged into a last component of its kind.
    fn add_to_path(
        &mut self,
        path: Path,
        added: bool,
        removed: bool,
        old_increment: isize,
    ) -> Path {
        let last = path.last.map(|index| self.components[index]);
        let component = match last {
            Some(last) if last.added == added && last.removed == removed => Component {
                count: last.count + 1,
                added,
                removed,
                previous: last.previous,
            },
            _ => Component {
                count: 1,
                added,
                removed,
                previous: path.last,
            },
        };
        self.components.push(component);
        Path {
            old_pos: path.old_pos + old_increment,
            last: Some(self.components.len() - 1),
        }
    }

    /// `extractCommon`: follows the diagonal while the tokens match; returns the new position.
    fn extract_common(&mut self, path: &mut Path, diagonal: isize) -> isize {
        let (old_len, new_len) = (self.old.len() as isize, self.new.len() as isize);
        let mut old_pos = path.old_pos;
        let mut new_pos = old_pos - diagonal;
        let mut common = 0;
        while new_pos + 1 < new_len
            && old_pos + 1 < old_len
            && self.old[(old_pos + 1) as usize] == self.new[(new_pos + 1) as usize]
        {
            new_pos += 1;
            old_pos += 1;
            common += 1;
        }
        if common > 0 {
            self.components.push(Component {
                count: common,
                added: false,
                removed: false,
                previous: path.last,
            });
            path.last = Some(self.components.len() - 1);
        }
        path.old_pos = old_pos;
        new_pos
    }

    /// `buildValues`: the components in order, with their text.
    fn build_values(&self, last: Option<usize>) -> Vec<Change> {
        let mut order = Vec::new();
        let mut next = last;
        while let Some(index) = next {
            order.push(self.components[index]);
            next = self.components[index].previous;
        }
        order.reverse();
        let (mut new_pos, mut old_pos) = (0, 0);
        order
            .into_iter()
            .map(|component| {
                let value = if component.removed {
                    let value = self.old[old_pos..old_pos + component.count].concat();
                    old_pos += component.count;
                    value
                } else {
                    let value = self.new[new_pos..new_pos + component.count].concat();
                    new_pos += component.count;
                    if !component.added {
                        old_pos += component.count;
                    }
                    value
                };
                Change {
                    value,
                    count: component.count,
                    added: component.added,
                    removed: component.removed,
                }
            })
            .collect()
    }
}

fn diff_tokens(old: &[&str], new: &[&str]) -> Vec<Change> {
    let (old_len, new_len) = (old.len() as isize, new.len() as isize);
    let mut search = Search {
        old,
        new,
        components: Vec::new(),
    };
    let max_edit_length = new_len + old_len;
    // Diagonal `d` lives at `d + offset`.
    let offset = max_edit_length + 1;
    let mut best: Vec<Option<Path>> = vec![None; (2 * offset + 1) as usize];
    let slot = |diagonal: isize| (diagonal + offset) as usize;

    let mut first = Path {
        old_pos: -1,
        last: None,
    };
    let new_pos = search.extract_common(&mut first, 0);
    if first.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
        return search.build_values(first.last);
    }
    best[slot(0)] = Some(first);

    let mut min_diagonal = isize::MIN;
    let mut max_diagonal = isize::MAX;
    let mut edit_length = 1;
    while edit_length <= max_edit_length {
        let mut diagonal = min_diagonal.max(-edit_length);
        while diagonal <= max_diagonal.min(edit_length) {
            let remove_path = best[slot(diagonal - 1)].take();
            let add_path = best[slot(diagonal + 1)];
            let can_add = add_path.is_some_and(|path| {
                let new_pos = path.old_pos - diagonal;
                0 <= new_pos && new_pos < new_len
            });
            let can_remove = remove_path.is_some_and(|path| path.old_pos + 1 < old_len);
            if !can_add && !can_remove {
                best[slot(diagonal)] = None;
                diagonal += 2;
                continue;
            }
            // Extend the path that got farthest in the old text, preferring an insertion.
            let insert = !can_remove
                || (can_add
                    && remove_path.map(|path| path.old_pos) < add_path.map(|path| path.old_pos));
            let mut base = if insert {
                let add = add_path.expect("an insertion extends the next diagonal's path");
                search.add_to_path(add, true, false, 0)
            } else {
                let remove = remove_path.expect("a removal extends the previous diagonal's path");
                search.add_to_path(remove, false, true, 1)
            };
            let new_pos = search.extract_common(&mut base, diagonal);
            if base.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
                return search.build_values(base.last);
            }
            best[slot(diagonal)] = Some(base);
            if base.old_pos + 1 >= old_len {
                max_diagonal = max_diagonal.min(diagonal - 1);
            }
            if new_pos + 1 >= new_len {
                min_diagonal = min_diagonal.max(diagonal + 1);
            }
            diagonal += 2;
        }
        edit_length += 1;
    }
    unreachable!("an edit script of at most the combined length exists")
}

/// `diffLines(old, new)`.
pub fn diff_lines(old: &str, new: &str) -> Vec<Change> {
    diff_tokens(&tokenize(old), &tokenize(new))
}

/// Lines with their trailing `\n`, the last without one when the text has none (`splitLines`).
fn split_lines(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text.split('\n').map(|line| format!("{line}\n")).collect();
    if text.ends_with('\n') {
        lines.pop();
    } else if let Some(last) = lines.last_mut() {
        last.pop();
    }
    lines
}

struct Hunk {
    old_start: usize,
    old_lines: usize,
    new_start: usize,
    new_lines: usize,
    lines: Vec<String>,
}

/// `structuredPatch`'s hunks, with `context` lines around each change.
fn hunks(old: &str, new: &str, context: usize) -> Vec<Hunk> {
    let mut changes = diff_lines(old, new);
    changes.push(Change {
        value: String::new(),
        count: 0,
        added: false,
        removed: false,
    });
    let lines: Vec<Vec<String>> = changes
        .iter()
        .map(|change| {
            if change.value.is_empty() {
                Vec::new()
            } else {
                split_lines(&change.value)
            }
        })
        .collect();
    let with_space = |lines: &[String]| {
        lines
            .iter()
            .map(|line| format!(" {line}"))
            .collect::<Vec<_>>()
    };
    let mut hunks = Vec::new();
    let (mut old_range_start, mut new_range_start) = (0usize, 0usize);
    let mut range: Vec<String> = Vec::new();
    let (mut old_line, mut new_line) = (1usize, 1usize);
    for (index, change) in changes.iter().enumerate() {
        let current = &lines[index];
        if change.added || change.removed {
            if old_range_start == 0 {
                old_range_start = old_line;
                new_range_start = new_line;
                if index > 0 {
                    let previous = &lines[index - 1];
                    range = if context > 0 {
                        with_space(&previous[previous.len().saturating_sub(context)..])
                    } else {
                        Vec::new()
                    };
                    old_range_start -= range.len();
                    new_range_start -= range.len();
                }
            }
            let sign = if change.added { '+' } else { '-' };
            range.extend(current.iter().map(|line| format!("{sign}{line}")));
            if change.added {
                new_line += current.len();
            } else {
                old_line += current.len();
            }
        } else {
            if old_range_start != 0 {
                if current.len() <= context * 2 && index + 2 < changes.len() {
                    range.extend(with_space(current));
                } else {
                    let context_size = current.len().min(context);
                    range.extend(with_space(&current[..context_size]));
                    hunks.push(Hunk {
                        old_start: old_range_start,
                        old_lines: old_line - old_range_start + context_size,
                        new_start: new_range_start,
                        new_lines: new_line - new_range_start + context_size,
                        lines: std::mem::take(&mut range),
                    });
                    old_range_start = 0;
                    new_range_start = 0;
                }
            }
            old_line += current.len();
            new_line += current.len();
        }
    }
    for hunk in &mut hunks {
        let mut index = 0;
        while index < hunk.lines.len() {
            if hunk.lines[index].ends_with('\n') {
                hunk.lines[index].pop();
            } else {
                hunk.lines
                    .insert(index + 1, "\\ No newline at end of file".into());
                index += 1;
            }
            index += 1;
        }
    }
    hunks
}

/// `createTwoFilesPatch(name, name, old, new, undefined, undefined, { context, headerOptions:
/// FILE_HEADERS_ONLY })`.
pub fn unified_patch(path: &str, old: &str, new: &str, context: usize) -> String {
    let mut lines = vec![format!("--- {path}"), format!("+++ {path}")];
    for hunk in hunks(old, new, context) {
        let old_start = if hunk.old_lines == 0 {
            hunk.old_start - 1
        } else {
            hunk.old_start
        };
        let new_start = if hunk.new_lines == 0 {
            hunk.new_start - 1
        } else {
            hunk.new_start
        };
        lines.push(format!(
            "@@ -{old_start},{} +{new_start},{} @@",
            hunk.old_lines, hunk.new_lines
        ));
        lines.extend(hunk.lines);
    }
    format!("{}\n", lines.join("\n"))
}

/// A context line, numbered by the old file, moving both files on.
fn context_line(
    output: &mut Vec<String>,
    lines: (&mut usize, &mut usize),
    width: usize,
    line: &str,
) {
    output.push(format!(" {:>width$} {line}", lines.0));
    *lines.0 += 1;
    *lines.1 += 1;
}

/// The edit tool's display diff (`generateDiffString`): changed lines with their numbers, up to
/// `context` lines of context around them, `...` for what is skipped; and the first changed line
/// in the new file.
pub fn display_diff(old: &str, new: &str, context: usize) -> (String, Option<usize>) {
    let changes = diff_lines(old, new);
    let width = old
        .split('\n')
        .count()
        .max(new.split('\n').count())
        .to_string()
        .len();
    let numbered = |sign: char, number: usize, line: &str| format!("{sign}{number:>width$} {line}");
    let skipped = format!(" {} ...", " ".repeat(width));
    let mut output: Vec<String> = Vec::new();
    let (mut old_line, mut new_line) = (1usize, 1usize);
    let mut last_was_change = false;
    let mut first_changed = None;
    for (index, change) in changes.iter().enumerate() {
        let mut lines: Vec<&str> = change.value.split('\n').collect();
        if lines.last() == Some(&"") {
            lines.pop();
        }
        if change.added || change.removed {
            first_changed.get_or_insert(new_line);
            for line in lines {
                if change.added {
                    output.push(numbered('+', new_line, line));
                    new_line += 1;
                } else {
                    output.push(numbered('-', old_line, line));
                    old_line += 1;
                }
            }
            last_was_change = true;
            continue;
        }
        let next_is_change = changes
            .get(index + 1)
            .is_some_and(|next| next.added || next.removed);
        if last_was_change && next_is_change {
            if lines.len() <= context * 2 {
                for line in &lines {
                    context_line(&mut output, (&mut old_line, &mut new_line), width, line);
                }
            } else {
                for line in &lines[..context] {
                    context_line(&mut output, (&mut old_line, &mut new_line), width, line);
                }
                output.push(skipped.clone());
                let skip = lines.len() - 2 * context;
                old_line += skip;
                new_line += skip;
                for line in &lines[lines.len() - context..] {
                    context_line(&mut output, (&mut old_line, &mut new_line), width, line);
                }
            }
        } else if last_was_change {
            let shown = lines.len().min(context);
            for line in &lines[..shown] {
                context_line(&mut output, (&mut old_line, &mut new_line), width, line);
            }
            let skip = lines.len() - shown;
            if skip > 0 {
                output.push(skipped.clone());
                old_line += skip;
                new_line += skip;
            }
        } else if next_is_change {
            let skip = lines.len().saturating_sub(context);
            if skip > 0 {
                output.push(skipped.clone());
                old_line += skip;
                new_line += skip;
            }
            for line in &lines[skip..] {
                context_line(&mut output, (&mut old_line, &mut new_line), width, line);
            }
        } else {
            old_line += lines.len();
            new_line += lines.len();
        }
        last_was_change = false;
    }
    (output.join("\n"), first_changed)
}
