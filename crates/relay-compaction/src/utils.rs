//! What summaries are built from (`compaction/utils.ts`, `convertToLlm` in `messages.ts`): the
//! agent's messages as model messages, a conversation as plain text, and the files its tool calls
//! read, wrote and edited.

use std::cmp::Ordering;

use relay_ai::text::{js_length, js_number_to_string};
use serde_json::{json, Map, Value};

pub const COMPACTION_SUMMARY_PREFIX: &str =
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
pub const COMPACTION_SUMMARY_SUFFIX: &str = "\n</summary>";
pub const BRANCH_SUMMARY_PREFIX: &str =
    "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
pub const BRANCH_SUMMARY_SUFFIX: &str = "</summary>";
/// Characters of a tool result kept in a summary request.
const TOOL_RESULT_MAX_CHARS: usize = 2000;

pub const SUMMARIZATION_SYSTEM_PROMPT: &str = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

pub(crate) fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    value.as_object()?.get(name)
}

pub(crate) fn text<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    field(value, name)?.as_str()
}

pub(crate) fn role(message: &Value) -> Option<&str> {
    text(message, "role")
}

/// JavaScript truthiness.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `String(value)` for template literals.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => js_number_to_string(number.as_f64().unwrap_or_default()),
        Some(Value::Null) => "null".into(),
        Some(other) => other.to_string(),
    }
}

/// An object of the fields that are present, in order.
pub(crate) fn object(fields: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(name, value)| Some((name.to_string(), value?)))
            .collect(),
    )
}

/// `contentText(content, separator)`: a string, or its text blocks joined.
pub fn content_text(content: Option<&Value>, separator: &str) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| text(block, "type") == Some("text"))
            .map(|block| match field(block, "text") {
                None | Some(Value::Null) => String::new(),
                Some(value) => js_string(Some(value)),
            })
            .collect::<Vec<_>>()
            .join(separator),
        _ => String::new(),
    }
}

/// A `!` command run as the user message the model reads (`bashExecutionToText`).
pub fn bash_execution_text(message: &Value) -> String {
    let mut out = format!("Ran `{}`\n", js_string(field(message, "command")));
    if truthy(field(message, "output")) {
        out.push_str(&format!(
            "```\n{}\n```",
            js_string(field(message, "output"))
        ));
    } else {
        out.push_str("(no output)");
    }
    let exit_code = field(message, "exitCode").filter(|code| !code.is_null());
    if truthy(field(message, "cancelled")) {
        out.push_str("\n\n(command cancelled)");
    } else if let Some(code) = exit_code.filter(|code| code.as_f64() != Some(0.0)) {
        out.push_str(&format!(
            "\n\nCommand exited with code {}",
            js_string(Some(code))
        ));
    }
    if truthy(field(message, "truncated")) && truthy(field(message, "fullOutputPath")) {
        out.push_str(&format!(
            "\n\n[Output truncated. Full output: {}]",
            js_string(field(message, "fullOutputPath"))
        ));
    }
    out
}

/// The agent's messages as model messages (`convertToLlm`): commands, extension messages and
/// summaries become user messages; a command run with `!!` is left out.
pub fn convert_to_llm(messages: &[Value]) -> Vec<Value> {
    let user = |content: Option<Value>, message: &Value| {
        object(vec![
            ("role", Some(json!("user"))),
            ("content", content),
            ("timestamp", field(message, "timestamp").cloned()),
        ])
    };
    let text_block = |text: String| Some(json!([{"type": "text", "text": text}]));
    messages
        .iter()
        .filter_map(|message| match role(message) {
            Some("bashExecution") => {
                if truthy(field(message, "excludeFromContext")) {
                    None
                } else {
                    Some(user(text_block(bash_execution_text(message)), message))
                }
            }
            Some("custom") => {
                let content = match field(message, "content") {
                    Some(Value::String(text)) => text_block(text.clone()),
                    other => other.cloned(),
                };
                Some(user(content, message))
            }
            Some("branchSummary") => Some(user(
                text_block(format!(
                    "{BRANCH_SUMMARY_PREFIX}{}{BRANCH_SUMMARY_SUFFIX}",
                    js_string(field(message, "summary"))
                )),
                message,
            )),
            Some("compactionSummary") => Some(user(
                text_block(format!(
                    "{COMPACTION_SUMMARY_PREFIX}{}{COMPACTION_SUMMARY_SUFFIX}",
                    js_string(field(message, "summary"))
                )),
                message,
            )),
            Some("system" | "user" | "assistant" | "toolResult") => Some(message.clone()),
            _ => None,
        })
        .collect()
}

/// The first `max` UTF-16 units of `text`, never splitting a character (JavaScript can leave half
/// of one).
fn slice_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, character) in text.char_indices() {
        units += character.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}

/// A tool result cut to its first characters with a marker (`truncateForSummary`).
fn truncate_for_summary(text: &str, max: usize) -> String {
    let length = js_length(text);
    if length <= max {
        return text.to_string();
    }
    format!(
        "{}\n\n[... {} more characters truncated]",
        slice_utf16(text, max),
        length - max
    )
}

/// Model messages as text, so the summarizer reads them rather than continuing them
/// (`serializeConversation`).
pub fn serialize_conversation(messages: &[Value]) -> String {
    let mut parts = Vec::new();
    for message in messages {
        match role(message) {
            Some("user") => {
                let content = content_text(field(message, "content"), "");
                if !content.is_empty() {
                    parts.push(format!("[User]: {content}"));
                }
            }
            Some("assistant") => {
                let blocks = field(message, "content")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let mut thinking = Vec::new();
                let mut calls = Vec::new();
                for block in &blocks {
                    match text(block, "type") {
                        Some("thinking") => thinking.push(js_string(field(block, "thinking"))),
                        Some("toolCall") => {
                            let arguments = match field(block, "arguments") {
                                Some(Value::Object(arguments)) => arguments
                                    .iter()
                                    .map(|(name, value)| {
                                        format!("{name}={}", relay_ai::json::stringify(value))
                                    })
                                    .collect::<Vec<_>>()
                                    .join(", "),
                                _ => String::new(),
                            };
                            calls.push(format!("{}({arguments})", js_string(field(block, "name"))));
                        }
                        _ => {}
                    }
                }
                if !thinking.is_empty() {
                    parts.push(format!("[Assistant thinking]: {}", thinking.join("\n")));
                }
                if blocks
                    .iter()
                    .any(|block| text(block, "type") == Some("text"))
                {
                    parts.push(format!(
                        "[Assistant]: {}",
                        content_text(field(message, "content"), "\n")
                    ));
                }
                if !calls.is_empty() {
                    parts.push(format!("[Assistant tool calls]: {}", calls.join("; ")));
                }
            }
            Some("toolResult") => {
                let content = content_text(field(message, "content"), "");
                if !content.is_empty() {
                    parts.push(format!(
                        "[Tool result]: {}",
                        truncate_for_summary(&content, TOOL_RESULT_MAX_CHARS)
                    ));
                }
            }
            _ => {}
        }
    }
    parts.join("\n\n")
}

/// The files tool calls touched, in the order a `Set` keeps them (`FileOperations`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileOperations {
    pub read: Vec<String>,
    pub written: Vec<String>,
    pub edited: Vec<String>,
}

fn add(set: &mut Vec<String>, path: &str) {
    if !set.iter().any(|existing| existing == path) {
        set.push(path.to_string());
    }
}

impl FileOperations {
    fn add_operation(&mut self, tool: &str, arguments: Option<&Value>) {
        let Some(path) = arguments
            .and_then(|arguments| text(arguments, "path"))
            .filter(|path| !path.is_empty())
        else {
            return;
        };
        match tool {
            "read" => add(&mut self.read, path),
            "write" => add(&mut self.written, path),
            "edit" => add(&mut self.edited, path),
            _ => {}
        }
    }

    pub(crate) fn add_read(&mut self, path: &str) {
        add(&mut self.read, path);
    }

    pub(crate) fn add_edited(&mut self, path: &str) {
        add(&mut self.edited, path);
    }

    /// The files an assistant message's tool calls name, or the calls a tool result records
    /// from a script (`extractFileOpsFromMessage`).
    pub fn extract(&mut self, message: &Value) {
        match role(message) {
            Some("toolResult") => {
                let calls = field(message, "nestedCalls")
                    .and_then(|nested| field(nested, "calls"))
                    .and_then(Value::as_array);
                for call in calls.into_iter().flatten() {
                    self.add_operation(
                        text(call, "name").unwrap_or_default(),
                        field(call, "arguments"),
                    );
                }
            }
            Some("assistant") => {
                let blocks = field(message, "content").and_then(Value::as_array);
                for block in blocks.into_iter().flatten() {
                    if text(block, "type") != Some("toolCall") {
                        continue;
                    }
                    let (Some(arguments), Some(name)) =
                        (field(block, "arguments"), field(block, "name"))
                    else {
                        continue;
                    };
                    self.add_operation(name.as_str().unwrap_or_default(), Some(arguments));
                }
            }
            _ => {}
        }
    }

    /// `{ read, written, edited }`, each as an array.
    pub fn to_json(&self) -> Value {
        json!({"read": self.read, "written": self.written, "edited": self.edited})
    }
}

/// JavaScript's default sort order: UTF-16 code units.
fn utf16_order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Files only read, and files modified, each sorted (`computeFileLists`).
pub fn compute_file_lists(operations: &FileOperations) -> (Vec<String>, Vec<String>) {
    let mut modified: Vec<String> = Vec::new();
    for path in operations.edited.iter().chain(&operations.written) {
        add(&mut modified, path);
    }
    let mut read: Vec<String> = operations
        .read
        .iter()
        .filter(|path| !modified.contains(path))
        .cloned()
        .collect();
    read.sort_by(|a, b| utf16_order(a, b));
    modified.sort_by(|a, b| utf16_order(a, b));
    (read, modified)
}

/// The file lists as tags after a summary (`formatFileOperations`).
pub fn format_file_operations(read: &[String], modified: &[String]) -> String {
    let mut sections = Vec::new();
    if !read.is_empty() {
        sections.push(format!("<read-files>\n{}\n</read-files>", read.join("\n")));
    }
    if !modified.is_empty() {
        sections.push(format!(
            "<modified-files>\n{}\n</modified-files>",
            modified.join("\n")
        ));
    }
    if sections.is_empty() {
        return String::new();
    }
    format!("\n\n{}", sections.join("\n\n"))
}

/// `{ readFiles, modifiedFiles }` (`CompactionDetails`).
pub fn details_json(read: &[String], modified: &[String]) -> Value {
    let mut details = Map::new();
    details.insert("readFiles".into(), json!(read));
    details.insert("modifiedFiles".into(), json!(modified));
    Value::Object(details)
}
