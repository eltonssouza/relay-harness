//! Context size estimates (`compaction.ts`): the last assistant response's reported usage plus
//! characters / 4 for what came after it, or characters / 4 throughout when no usage can be
//! trusted.

use relay_ai::text::js_length;
use relay_session::entries::{entry_type, Projection};
use relay_session::manager::current_system_message;
use serde::Serialize;
use serde_json::Value;

use crate::utils::{field, role, text, truthy};

/// An image's estimated size in characters.
const ESTIMATED_IMAGE_CHARS: usize = 4800;

/// A context estimate (`ContextUsageEstimate`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageEstimate {
    pub tokens: u64,
    pub usage_tokens: u64,
    pub trailing_tokens: u64,
    pub last_usage_index: Option<usize>,
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or_default()
}

/// The context size a usage reports: `totalTokens`, else its parts (`calculateContextTokens`).
pub fn calculate_context_tokens(usage: &Value) -> f64 {
    let total = number(field(usage, "totalTokens"));
    if total != 0.0 && !total.is_nan() {
        return total;
    }
    ["input", "output", "cacheRead", "cacheWrite"]
        .iter()
        .map(|name| number(field(usage, name)))
        .sum()
}

/// A response's usage, unless it was aborted, failed or reports nothing (`getAssistantUsage`).
fn assistant_usage(message: &Value) -> Option<&Value> {
    if role(message) != Some("assistant") {
        return None;
    }
    let usage = field(message, "usage")?;
    let stop = text(message, "stopReason");
    if stop == Some("aborted") || stop == Some("error") || !truthy(Some(usage)) {
        return None;
    }
    (calculate_context_tokens(usage) > 0.0).then_some(usage)
}

/// The latest usable usage among session entries (`getLastAssistantUsage`).
pub fn last_assistant_usage(entries: &[Value]) -> Option<&Value> {
    entries.iter().rev().find_map(|entry| {
        if entry_type(entry) != Some("message") {
            return None;
        }
        assistant_usage(field(entry, "message")?)
    })
}

/// Characters of text and images (`estimateTextAndImageContentChars`).
fn content_chars(content: Option<&Value>) -> usize {
    match content {
        Some(Value::String(text)) => js_length(text),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| match text(block, "type") {
                Some("text") => text(block, "text").map_or(0, js_length),
                Some("image") => ESTIMATED_IMAGE_CHARS,
                _ => 0,
            })
            .sum(),
        _ => 0,
    }
}

fn tokens(chars: usize) -> u64 {
    chars.div_ceil(4) as u64
}

/// A message's estimated tokens, characters / 4 rounded up (`estimateTokens`).
pub fn estimate_tokens(message: &Value) -> u64 {
    let length = |name: &str| text(message, name).map_or(0, js_length);
    match role(message) {
        Some("system") => {
            let mut chars = content_chars(field(message, "content"));
            if let Some(Value::Object(sections)) = field(message, "sections") {
                chars += sections
                    .values()
                    .filter_map(Value::as_str)
                    .map(js_length)
                    .sum::<usize>();
            }
            if let Some(tools) = field(message, "toolsAdded").filter(|tools| truthy(Some(tools))) {
                chars += js_length(&relay_ai::json::stringify(tools));
            }
            tokens(chars)
        }
        Some("user" | "custom" | "toolResult") => tokens(content_chars(field(message, "content"))),
        Some("assistant") => {
            let blocks = field(message, "content").and_then(Value::as_array);
            let chars = blocks
                .into_iter()
                .flatten()
                .map(|block| match text(block, "type") {
                    Some("text") => text(block, "text").map_or(0, js_length),
                    Some("thinking") => text(block, "thinking").map_or(0, js_length),
                    Some("toolCall") => {
                        text(block, "name").map_or(0, js_length)
                            + field(block, "arguments").map_or(0, |arguments| {
                                js_length(&relay_ai::json::stringify(arguments))
                            })
                    }
                    _ => 0,
                })
                .sum();
            tokens(chars)
        }
        Some("bashExecution") => tokens(length("command") + length("output")),
        Some("branchSummary" | "compactionSummary") => tokens(length("summary")),
        _ => 0,
    }
}

/// The context size: the last usable usage plus estimates for the messages after it
/// (`estimateContextTokens`).
pub fn estimate_context_tokens(messages: &[Value]) -> ContextUsageEstimate {
    let last = messages
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, message)| Some((index, assistant_usage(message)?)));
    let Some((index, usage)) = last else {
        let estimated = messages.iter().map(estimate_tokens).sum();
        return ContextUsageEstimate {
            tokens: estimated,
            usage_tokens: 0,
            trailing_tokens: estimated,
            last_usage_index: None,
        };
    };
    let usage_tokens = calculate_context_tokens(usage) as u64;
    let trailing: u64 = messages[index + 1..].iter().map(estimate_tokens).sum();
    ContextUsageEstimate {
        tokens: usage_tokens + trailing,
        usage_tokens,
        trailing_tokens: trailing,
        last_usage_index: Some(index),
    }
}

/// The projected context's size, distrusting usage reported before a later context edit or
/// compaction (`estimateProjectedContextTokens`).
pub fn estimate_projected_context_tokens(
    projection: &Projection,
    branch_entries: &[Value],
) -> ContextUsageEstimate {
    let estimate = estimate_context_tokens(&projection.messages);
    if let Some(last_usage) = estimate.last_usage_index {
        let mut start = 0;
        let mut usage_entry_id = None;
        for entry in &projection.entries {
            let next = start + entry.messages.len();
            if last_usage < next {
                usage_entry_id = field(&entry.source, "id").and_then(Value::as_str);
                break;
            }
            start = next;
        }
        let usage_index = usage_entry_id.and_then(|id| {
            branch_entries
                .iter()
                .position(|entry| field(entry, "id").and_then(Value::as_str) == Some(id))
        });
        let invalidating = branch_entries
            .iter()
            .rposition(|entry| matches!(entry_type(entry), Some("context_edit" | "compaction")));
        let after = match (usage_index, invalidating) {
            (Some(usage), Some(invalidating)) => usage > invalidating,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if after {
            return estimate;
        }
    }
    let system = current_system_message(&projection.messages);
    let mut tokens = system.as_ref().map_or(0, estimate_tokens);
    tokens += projection
        .messages
        .iter()
        .filter(|message| role(message) != Some("system"))
        .map(estimate_tokens)
        .sum::<u64>();
    ContextUsageEstimate {
        tokens,
        usage_tokens: 0,
        trailing_tokens: tokens,
        last_usage_index: None,
    }
}

/// Whether the context is over the window minus the reserve (`shouldCompact`).
pub fn should_compact(
    context_tokens: f64,
    context_window: f64,
    enabled: bool,
    reserve_tokens: f64,
) -> bool {
    enabled && context_tokens > context_window - reserve_tokens
}
