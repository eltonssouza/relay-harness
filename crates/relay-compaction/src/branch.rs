//! Branch summaries (`branch-summarization.ts`): when the session moves to another point of its
//! tree, the branch it leaves is summarized so its context is not lost. The entries from the old
//! leaf back to the common ancestor are taken newest first within a token budget, then summarized
//! as compaction summaries are, without reasoning and with at most 4096 tokens back.

use std::collections::HashSet;

use relay_ai::message::{OutputBlock, StopReason, Usage};
use relay_session::entries::{entry_type, time_value};
use relay_session::SessionManager;
use serde_json::{json, Map, Value};

use crate::estimate::estimate_tokens;
use crate::summarize::{response_text, summarization_failure, Summarizer};
use crate::utils::{
    compute_file_lists, convert_to_llm, field, format_file_operations, object, role,
    serialize_conversation, truthy, FileOperations,
};

const BRANCH_SUMMARY_PREAMBLE: &str =
    "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n";

const BRANCH_SUMMARY_PROMPT: &str = "Create a structured summary of this conversation branch for context when returning later.\n\nUse this EXACT format:\n\n## Goal\n[What was the user trying to accomplish in this branch?]\n\n## Constraints & Preferences\n- [Any constraints, preferences, or requirements mentioned]\n- [Or \"(none)\" if none were mentioned]\n\n## Progress\n### Done\n- [x] [Completed tasks/changes]\n\n### In Progress\n- [ ] [Work that was started but not finished]\n\n### Blocked\n- [Issues preventing progress, if any]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale]\n\n## Next Steps\n1. [What should happen next to continue this work]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.";

/// The entries a move from `old_leaf` to `target` leaves behind, oldest first, and the common
/// ancestor (`collectEntriesForBranchSummary`).
pub fn collect_entries_for_branch_summary(
    session: &SessionManager,
    old_leaf: Option<&str>,
    target: &str,
) -> (Vec<Value>, Option<String>) {
    let Some(old_leaf) = old_leaf.filter(|leaf| !leaf.is_empty()) else {
        return (Vec::new(), None);
    };
    let id = |entry: &Value| {
        field(entry, "id")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let old_path: HashSet<String> = session
        .branch_path(Some(old_leaf))
        .into_iter()
        .filter_map(id)
        .collect();
    let common = session
        .branch_path(Some(target))
        .into_iter()
        .rev()
        .filter_map(id)
        .find(|id| old_path.contains(id));
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    let mut current = Some(old_leaf.to_string());
    while let Some(id) = current.filter(|id| !id.is_empty() && Some(id) != common.as_ref()) {
        let Some(entry) = session.entry_by_id(&id) else {
            break;
        };
        // An entry that is its own ancestor ends the walk.
        if !seen.insert(id) {
            break;
        }
        entries.push(entry.clone());
        current = field(entry, "parentId")
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    entries.reverse();
    (entries, common)
}

/// An entry as the message a branch summary reads (`getMessageFromEntry`): tool results are
/// left out, their calls carry them; summaries become summary messages.
fn message_from_entry(entry: &Value) -> Option<Value> {
    let timestamp = || Some(time_value(field(entry, "timestamp")));
    match entry_type(entry) {
        Some("message") => {
            let message = field(entry, "message")?;
            (role(message) != Some("toolResult")).then(|| message.clone())
        }
        Some("custom_message") => Some(object(vec![
            ("role", Some(json!("custom"))),
            ("customType", field(entry, "customType").cloned()),
            ("content", field(entry, "content").cloned()),
            ("display", field(entry, "display").cloned()),
            ("details", field(entry, "details").cloned()),
            ("timestamp", timestamp()),
        ])),
        Some("branch_summary") => Some(object(vec![
            ("role", Some(json!("branchSummary"))),
            ("summary", field(entry, "summary").cloned()),
            ("fromId", field(entry, "fromId").cloned()),
            ("timestamp", timestamp()),
        ])),
        Some("compaction") => Some(object(vec![
            ("role", Some(json!("compactionSummary"))),
            ("summary", field(entry, "summary").cloned()),
            ("tokensBefore", field(entry, "tokensBefore").cloned()),
            ("timestamp", timestamp()),
        ])),
        _ => None,
    }
}

/// The messages a branch summary reads, the files they touched and their estimated tokens
/// (`BranchPreparation`).
#[derive(Debug, Clone, PartialEq)]
pub struct BranchPreparation {
    pub messages: Vec<Value>,
    pub file_ops: FileOperations,
    pub total_tokens: u64,
}

/// The newest messages that fit `token_budget` (0 for no limit), and the files every entry
/// touched (`prepareBranchEntries`). A summary entry over the budget still goes in while less
/// than 90% of it is used.
pub fn prepare_branch_entries(entries: &[Value], token_budget: f64) -> BranchPreparation {
    let mut file_ops = FileOperations::default();
    // Earlier summaries' file lists, unless an extension wrote them.
    for entry in entries {
        if entry_type(entry) != Some("branch_summary") || truthy(field(entry, "fromHook")) {
            continue;
        }
        let Some(details) = field(entry, "details").filter(|details| truthy(Some(details))) else {
            continue;
        };
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
    let mut messages = Vec::new();
    let mut total = 0u64;
    for entry in entries.iter().rev() {
        let Some(message) = message_from_entry(entry) else {
            continue;
        };
        file_ops.extract(&message);
        let tokens = estimate_tokens(&message);
        if token_budget > 0.0 && (total + tokens) as f64 > token_budget {
            let summary = matches!(entry_type(entry), Some("compaction" | "branch_summary"));
            if summary && (total as f64) < token_budget * 0.9 {
                messages.insert(0, message);
                total += tokens;
            }
            break;
        }
        messages.insert(0, message);
        total += tokens;
    }
    BranchPreparation {
        messages,
        file_ops,
        total_tokens: total,
    }
}

/// What a branch summary produced (`BranchSummaryResult`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BranchSummaryResult {
    pub summary: Option<String>,
    pub usage: Option<Usage>,
    pub read_files: Option<Vec<String>>,
    pub modified_files: Option<Vec<String>>,
    pub aborted: bool,
    pub error: Option<String>,
}

impl BranchSummaryResult {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        if let Some(summary) = &self.summary {
            object.insert("summary".into(), json!(summary));
        }
        if let Some(usage) = &self.usage {
            object.insert("usage".into(), json!(usage));
        }
        if let Some(read) = &self.read_files {
            object.insert("readFiles".into(), json!(read));
        }
        if let Some(modified) = &self.modified_files {
            object.insert("modifiedFiles".into(), json!(modified));
        }
        if self.aborted {
            object.insert("aborted".into(), json!(true));
        }
        if let Some(error) = &self.error {
            object.insert("error".into(), json!(error));
        }
        Value::Object(object)
    }
}

/// How a branch summary is asked for (`GenerateBranchSummaryOptions`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BranchSummaryOptions {
    pub custom_instructions: Option<String>,
    /// The instructions replace the default prompt instead of extending it.
    pub replace_instructions: bool,
    /// Tokens kept free of branch history; 16384 when unset.
    pub reserve_tokens: Option<f64>,
}

impl Summarizer<'_> {
    /// A summary of the entries a move left behind (`generateBranchSummary`).
    pub async fn branch_summary(
        &self,
        entries: &[Value],
        options: &BranchSummaryOptions,
    ) -> BranchSummaryResult {
        let window = self
            .model
            .context_window
            .filter(|window| *window > 0)
            .unwrap_or(128_000) as f64;
        let budget = window - options.reserve_tokens.unwrap_or(16_384.0);
        let preparation = prepare_branch_entries(entries, budget);
        if preparation.messages.is_empty() {
            return BranchSummaryResult {
                summary: Some("No content to summarize".into()),
                ..BranchSummaryResult::default()
            };
        }
        let conversation = serialize_conversation(&convert_to_llm(&preparation.messages));
        let custom = options
            .custom_instructions
            .as_deref()
            .filter(|custom| !custom.is_empty());
        let instructions = match (options.replace_instructions, custom) {
            (true, Some(custom)) => custom.to_string(),
            (false, Some(custom)) => {
                format!("{BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: {custom}")
            }
            (_, None) => BRANCH_SUMMARY_PROMPT.to_string(),
        };
        let prompt = format!("<conversation>\n{conversation}\n</conversation>\n\n{instructions}");
        let cap = if self.model.max_tokens > 0 {
            self.model.max_tokens as f64
        } else {
            f64::INFINITY
        };
        let response = self
            .complete_with(prompt, cap.min(4096.0), None, None)
            .await;
        if response.stop_reason == StopReason::Aborted {
            return BranchSummaryResult {
                aborted: true,
                ..BranchSummaryResult::default()
            };
        }
        if let Some(failure) = summarization_failure(&response, "Branch summarization") {
            return BranchSummaryResult {
                error: Some(failure),
                ..BranchSummaryResult::default()
            };
        }
        if response
            .content
            .iter()
            .any(|block| matches!(block, OutputBlock::ToolCall(_)))
        {
            return BranchSummaryResult {
                error: Some("Branch summarization attempted to call a tool".into()),
                ..BranchSummaryResult::default()
            };
        }
        let (read, modified) = compute_file_lists(&preparation.file_ops);
        let summary = format!(
            "{BRANCH_SUMMARY_PREAMBLE}{}{}",
            response_text(&response),
            format_file_operations(&read, &modified)
        );
        BranchSummaryResult {
            summary: Some(summary),
            usage: Some(response.usage),
            read_files: Some(read),
            modified_files: Some(modified),
            aborted: false,
            error: None,
        }
    }
}
