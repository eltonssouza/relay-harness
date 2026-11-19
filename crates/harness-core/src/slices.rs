//! Small verified slices: the deterministic part of `packages/agent/src/harness/slices.ts`.
//!
//! Measuring needs git and the file system, which stay with the runtime; these functions turn the
//! measurements into the change-size and file-growth signals.

use std::collections::{BTreeMap, BTreeSet};

/// Lines and files changed since the request's baseline: the absolute change of each path's count.
pub fn measure(
    baseline: &BTreeMap<String, usize>,
    current: &BTreeMap<String, usize>,
) -> (usize, usize) {
    let paths: BTreeSet<&String> = baseline.keys().chain(current.keys()).collect();
    let mut lines = 0;
    let mut files = 0;
    for path in paths {
        let before = baseline.get(path).copied().unwrap_or(0);
        let after = current.get(path).copied().unwrap_or(0);
        let delta = before.abs_diff(after);
        if delta > 0 {
            lines += delta;
            files += 1;
        }
    }
    (lines, files)
}

/// Whether an edit that left a file with `lines` lines flags it: new, crossed the guideline, or
/// grew by `growth` lines while already over it. A file at or under the guideline never flags.
pub fn flags_growth(
    previous: Option<usize>,
    lines: usize,
    max_file_lines: usize,
    growth: usize,
) -> bool {
    if lines <= max_file_lines {
        return false;
    }
    match previous {
        None => true,
        Some(previous) => previous <= max_file_lines || lines.saturating_sub(previous) >= growth,
    }
}

/// Reminder lines for the harness state, or None when both signals are quiet.
pub fn render(
    changed_lines: usize,
    changed_files: usize,
    max_changed_lines: usize,
    oversized: &[(String, usize)],
    max_file_lines: usize,
) -> Option<String> {
    let mut lines = Vec::new();
    if max_changed_lines > 0 && changed_lines > max_changed_lines {
        lines.push(format!(
            "This request has changed about {changed_lines} lines in {changed_files} files (guideline: {max_changed_lines}). Verify and report this slice before starting more, and propose how to split the rest."
        ));
    }
    for (path, count) in oversized {
        lines.push(format!(
            "{path} now has {count} lines (guideline: {max_file_lines}). Before adding more to it, extract a cohesive part into its own module."
        ));
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_against_the_baseline() {
        let baseline = BTreeMap::from([("old.ts".to_string(), 40)]);
        let current = BTreeMap::from([("old.ts".to_string(), 80), ("a.ts".to_string(), 70)]);
        assert_eq!(measure(&baseline, &current), (110, 2));
    }

    #[test]
    fn flags_files_that_cross_or_grow_a_lot() {
        assert!(flags_growth(Some(900), 1100, 1000, 200));
        assert!(!flags_growth(Some(1500), 1520, 1000, 200));
        assert!(flags_growth(Some(1500), 1800, 1000, 200));
        assert!(!flags_growth(None, 900, 1000, 200));
    }
}
