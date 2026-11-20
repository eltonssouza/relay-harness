//! Where compaction cuts (`findCutPoint`, `prepareCompaction` in `compaction.ts`): walking back
//! from the newest entry until about `keepRecentTokens` are kept, then cutting at a user or
//! assistant message, never at a tool result, which must follow its call. A cut inside a turn
//! summarizes that turn's start separately.

use relay_session::entries::{
    entry_context_messages, entry_type, session_projection, Leaf, ProjectedEntry,
};
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::estimate::{estimate_projected_context_tokens, estimate_tokens};
use crate::utils::{field, role, text, FileOperations};

/// Compaction's settings (`CompactionSettings`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionSettings {
    pub enabled: bool,
    #[serde(serialize_with = "relay_ai::json::serialize_js_f64")]
    pub reserve_tokens: f64,
    #[serde(serialize_with = "relay_ai::json::serialize_js_f64")]
    pub keep_recent_tokens: f64,
}

/// `DEFAULT_COMPACTION_SETTINGS`.
pub const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = CompactionSettings {
    enabled: true,
    reserve_tokens: 16384.0,
    keep_recent_tokens: 20000.0,
};

/// Where to cut (`CutPointResult`): the first entry kept, and the start of the turn it splits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutPoint {
    pub first_kept_entry_index: usize,
    /// -1 when the cut does not split a turn.
    pub turn_start_index: i64,
    pub is_split_turn: bool,
}

fn is_cut_point_message(message: &Value) -> bool {
    matches!(
        role(message),
        Some(
            "user"
                | "assistant"
                | "bashExecution"
                | "custom"
                | "branchSummary"
                | "compactionSummary"
        )
    )
}

fn is_turn_start_message(message: &Value) -> bool {
    matches!(
        role(message),
        Some("user" | "bashExecution" | "custom" | "branchSummary" | "compactionSummary")
    )
}

fn is_turn_start_entry(entry: &Value) -> bool {
    entry_type(entry) != Some("compaction")
        && entry_context_messages(entry)
            .iter()
            .any(is_turn_start_message)
}

fn entry_tokens(messages: &[Value]) -> u64 {
    messages.iter().map(estimate_tokens).sum()
}

/// The entry that starts the turn holding `entry_index`, or -1 (`findTurnStartIndex`).
pub fn find_turn_start_index(entries: &[Value], entry_index: usize, start_index: usize) -> i64 {
    (start_index..=entry_index)
        .rev()
        .find(|index| entries.get(*index).is_some_and(is_turn_start_entry))
        .map_or(-1, |index| index as i64)
}

/// The cut that keeps about `keep_recent_tokens` of `entries[start..end]` (`findCutPoint`).
pub fn find_cut_point(
    entries: &[Value],
    start: usize,
    end: usize,
    keep_recent_tokens: f64,
) -> CutPoint {
    let cut_points: Vec<usize> = (start..end)
        .filter(|index| {
            let entry = &entries[*index];
            entry_type(entry) != Some("compaction")
                && entry_context_messages(entry)
                    .iter()
                    .any(is_cut_point_message)
        })
        .collect();
    let Some(&first) = cut_points.first() else {
        return CutPoint {
            first_kept_entry_index: start,
            turn_start_index: -1,
            is_split_turn: false,
        };
    };
    let mut accumulated = 0.0;
    let mut cut = first;
    for index in (start..end).rev() {
        let tokens = entry_tokens(&entry_context_messages(&entries[index]));
        if tokens == 0 {
            continue;
        }
        accumulated += tokens as f64;
        if accumulated >= keep_recent_tokens {
            // The nearest cut point at or after this entry; past the last one, the last.
            cut = cut_points
                .iter()
                .copied()
                .find(|candidate| *candidate >= index)
                .unwrap_or(*cut_points.last().expect("cut points"));
            break;
        }
    }
    // Entries that only change state go with what follows them.
    while cut > start {
        let previous = &entries[cut - 1];
        if entry_type(previous) == Some("compaction")
            || !entry_context_messages(previous).is_empty()
        {
            break;
        }
        cut -= 1;
    }
    let starts_turn = is_turn_start_entry(&entries[cut]);
    let turn_start = if starts_turn {
        -1
    } else {
        find_turn_start_index(entries, cut, start)
    };
    CutPoint {
        first_kept_entry_index: cut,
        turn_start_index: turn_start,
        is_split_turn: !starts_turn && turn_start != -1,
    }
}

fn is_projected_turn_start(entry: &ProjectedEntry) -> bool {
    entry_type(&entry.source) != Some("compaction")
        && entry.messages.iter().any(is_turn_start_message)
}

fn find_projected_turn_start(entries: &[ProjectedEntry], entry_index: usize, start: usize) -> i64 {
    (start..=entry_index)
        .rev()
        .find(|index| is_projected_turn_start(&entries[*index]))
        .map_or(-1, |index| index as i64)
}

/// `findCutPoint` over projected entries, which also steps past an omitted recovery attempt
/// (`findProjectedCutPoint`).
fn find_projected_cut_point(
    entries: &[ProjectedEntry],
    start: usize,
    end: usize,
    keep_recent_tokens: f64,
) -> CutPoint {
    let cut_points: Vec<usize> = (start..end)
        .filter(|index| {
            let entry = &entries[*index];
            entry_type(&entry.source) != Some("compaction")
                && entry.messages.iter().any(is_cut_point_message)
        })
        .collect();
    let Some(&first) = cut_points.first() else {
        return CutPoint {
            first_kept_entry_index: start,
            turn_start_index: -1,
            is_split_turn: false,
        };
    };
    let mut accumulated = 0.0;
    let mut exceeded = false;
    let mut cut = first;
    for index in (start..end).rev() {
        let tokens = entry_tokens(&entries[index].messages);
        if tokens == 0 {
            continue;
        }
        accumulated += tokens as f64;
        if accumulated >= keep_recent_tokens {
            exceeded = true;
            cut = cut_points
                .iter()
                .copied()
                .find(|candidate| *candidate >= index)
                .unwrap_or(*cut_points.last().expect("cut points"));
            break;
        }
    }

    // A failed attempt the context edits omitted, after the last visible input, is not context:
    // the cut moves past it, unless something else in that suffix still counts.
    let suffix = &entries[(cut + 1).min(end)..end];
    let visible = |entry: &ProjectedEntry| {
        entry_type(&entry.source) != Some("context_edit")
            && !entry_context_messages(&entry.source).is_empty()
    };
    let omitted = |entry: &ProjectedEntry| visible(entry) && entry.messages.is_empty();
    let omitted_ids: Vec<&Value> = suffix
        .iter()
        .filter(|entry| omitted(entry))
        .filter_map(|entry| field(&entry.source, "id"))
        .collect();
    let external_replacement = suffix.iter().any(|entry| {
        entry_type(&entry.source) == Some("context_edit")
            && !matches!(field(&entry.source, "replacement"), Some(Value::Null))
            && !field(&entry.source, "targetId").is_some_and(|target| omitted_ids.contains(&target))
    });
    let recovery_suffix = exceeded
        && !external_replacement
        && suffix.iter().any(|entry| {
            entry_type(&entry.source) == Some("message")
                && field(&entry.source, "message").and_then(role) == Some("assistant")
                && omitted(entry)
        })
        && suffix.iter().all(|entry| {
            entry_type(&entry.source) != Some("compaction") && (!visible(entry) || omitted(entry))
        });
    if recovery_suffix {
        cut += 1;
    }

    while cut > start {
        let previous = &entries[cut - 1];
        if entry_type(&previous.source) == Some("compaction") || !previous.messages.is_empty() {
            break;
        }
        cut -= 1;
    }
    let starts_turn = is_projected_turn_start(&entries[cut]);
    let turn_start = if starts_turn {
        -1
    } else {
        find_projected_turn_start(entries, cut, start)
    };
    CutPoint {
        first_kept_entry_index: cut,
        turn_start_index: turn_start,
        is_split_turn: !starts_turn && turn_start != -1,
    }
}

/// What a compaction summarizes and keeps (`CompactionPreparation`).
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionPreparation {
    pub first_kept_entry_id: String,
    /// Summarized and dropped.
    pub messages_to_summarize: Vec<Value>,
    /// The split turn's start, summarized separately.
    pub turn_prefix_messages: Vec<Value>,
    pub is_split_turn: bool,
    pub tokens_before: u64,
    pub previous_summary: Option<Value>,
    pub file_ops: FileOperations,
    pub settings: CompactionSettings,
}

impl CompactionPreparation {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("firstKeptEntryId".into(), json!(self.first_kept_entry_id));
        object.insert(
            "messagesToSummarize".into(),
            Value::Array(self.messages_to_summarize.clone()),
        );
        object.insert(
            "turnPrefixMessages".into(),
            Value::Array(self.turn_prefix_messages.clone()),
        );
        object.insert("isSplitTurn".into(), json!(self.is_split_turn));
        object.insert("tokensBefore".into(), json!(self.tokens_before));
        if let Some(summary) = &self.previous_summary {
            object.insert("previousSummary".into(), summary.clone());
        }
        object.insert("fileOps".into(), self.file_ops.to_json());
        object.insert("settings".into(), json!(self.settings));
        Value::Object(object)
    }
}

/// An entry's messages for a summary: none from a compaction, and no system messages, which the
/// compaction carries itself.
fn summarized_messages(entry: &ProjectedEntry) -> Vec<Value> {
    if entry_type(&entry.source) == Some("compaction") {
        return Vec::new();
    }
    entry
        .messages
        .iter()
        .filter(|message| role(message) != Some("system"))
        .cloned()
        .collect()
}

/// What to summarize and keep for the path ending at its last entry, or `None` when there is
/// nothing to compact (`prepareCompaction`).
pub fn prepare_compaction(
    path: &[Value],
    settings: CompactionSettings,
) -> Option<CompactionPreparation> {
    if path
        .last()
        .is_some_and(|entry| entry_type(entry) == Some("compaction"))
    {
        return None;
    }
    let projection = session_projection(path, Leaf::Last);
    let entries = &projection.entries;
    // The newest compaction comes first; older ones in its kept range contribute nothing.
    let previous_index = entries.iter().position(|entry| {
        entry_type(&entry.source) == Some("compaction") && !entry.messages.is_empty()
    });
    let previous_summary =
        previous_index.and_then(|index| field(&entries[index].source, "summary").cloned());
    let boundary_start = previous_index.map_or(0, |index| index + 1);
    let tokens_before = estimate_projected_context_tokens(&projection, path).tokens;
    let cut = find_projected_cut_point(
        entries,
        boundary_start,
        entries.len(),
        settings.keep_recent_tokens,
    );
    let first_kept = entries.get(cut.first_kept_entry_index)?;
    let first_kept_entry_id = text(&first_kept.source, "id")
        .filter(|id| !id.is_empty())?
        .to_string();
    let history_end = if cut.is_split_turn {
        cut.turn_start_index as usize
    } else {
        cut.first_kept_entry_index
    };
    let messages_to_summarize: Vec<Value> = entries
        .get(boundary_start..history_end.max(boundary_start))
        .unwrap_or_default()
        .iter()
        .flat_map(summarized_messages)
        .collect();
    let turn_prefix_messages: Vec<Value> = if cut.is_split_turn {
        entries[cut.turn_start_index as usize..cut.first_kept_entry_index]
            .iter()
            .flat_map(summarized_messages)
            .collect()
    } else {
        Vec::new()
    };
    if messages_to_summarize.is_empty() && turn_prefix_messages.is_empty() {
        return None;
    }

    let mut file_ops = FileOperations::default();
    // The previous compaction's lists, unless an extension wrote it.
    if let Some(index) = previous_index {
        let previous = &entries[index].source;
        let from_hook = crate::utils::truthy(field(previous, "fromHook"));
        if let (false, Some(details)) = (
            from_hook,
            field(previous, "details").filter(|details| crate::utils::truthy(Some(details))),
        ) {
            for path in field(details, "readFiles")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(path) = path.as_str() {
                    file_ops.add_read(path);
                }
            }
            for path in field(details, "modifiedFiles")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(path) = path.as_str() {
                    file_ops.add_edited(path);
                }
            }
        }
    }
    for message in &messages_to_summarize {
        file_ops.extract(message);
    }
    if cut.is_split_turn {
        for message in &turn_prefix_messages {
            file_ops.extract(message);
        }
    }

    Some(CompactionPreparation {
        first_kept_entry_id,
        messages_to_summarize,
        turn_prefix_messages,
        is_split_turn: cut.is_split_turn,
        tokens_before,
        previous_summary,
        file_ops,
        settings,
    })
}
