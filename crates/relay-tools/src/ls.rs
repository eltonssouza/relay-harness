//! The `ls` tool (`ls.ts`): a directory's entries in `localeCompare` order, ignoring case, with
//! `/` after directories; up to 500 entries or 50 KB.

use std::fs;
use std::path::Path;

use futures_util::future::{ready, BoxFuture};
use relay_agent::{AgentTool, AgentToolResult, ToolUpdate};
use relay_ai::abort::AbortSignal;
use relay_ai::json::js_number;
use relay_ai::{InputBlock, TextContent, Tool};
use serde_json::{json, Map, Value};

use crate::js::{fs_error, locale_compare, number};
use crate::paths::{home_dir, resolve_to_cwd};
use crate::truncate::{format_size, truncate_head, TruncationOptions, DEFAULT_MAX_BYTES};

const DEFAULT_LIMIT: f64 = 500.0;
/// `Number.MAX_SAFE_INTEGER`: the entry limit already bounds the lines.
const NO_LINE_LIMIT: u64 = 9_007_199_254_740_991;

fn declaration() -> Tool {
    Tool {
        name: "ls".into(),
        description: format!(
            "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to {DEFAULT_LIMIT} entries or {}KB (whichever is hit first).",
            DEFAULT_MAX_BYTES / 1024
        ),
        parameters: json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory to list (default: current directory)"},
                "limit": {"type": "number", "description": "Maximum number of entries to return (default: 500)"},
            },
        }),
        constrained_sampling: None,
    }
}

/// Lists directories relative to a working directory.
pub struct LsTool {
    declaration: Tool,
    cwd: String,
    home: Option<String>,
}

fn text_result(text: String, details: Option<Value>) -> AgentToolResult {
    AgentToolResult {
        content: vec![InputBlock::Text(TextContent {
            text,
            text_signature: None,
            volatile: None,
        })],
        details,
        structured_content: None,
        usage: None,
        is_error: None,
        terminate: None,
    }
}

impl LsTool {
    pub fn new(cwd: impl Into<String>) -> Self {
        LsTool {
            declaration: declaration(),
            cwd: cwd.into(),
            home: home_dir(),
        }
    }

    /// One call; the error is the message the model receives.
    pub fn list(&self, path: Option<&str>, limit: Option<f64>) -> Result<AgentToolResult, String> {
        let path = path.filter(|path| !path.is_empty()).unwrap_or(".");
        let directory = resolve_to_cwd(path, &self.cwd, self.home.as_deref());
        if !Path::new(&directory).exists() {
            return Err(format!("Path not found: {directory}"));
        }
        let metadata =
            fs::metadata(&directory).map_err(|error| fs_error(&error, "stat", &directory))?;
        if !metadata.is_dir() {
            return Err(format!("Not a directory: {directory}"));
        }
        let mut entries: Vec<String> = fs::read_dir(&directory)
            .map_err(|error| {
                format!(
                    "Cannot read directory: {}",
                    fs_error(&error, "scandir", &directory)
                )
            })?
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        entries.sort_by(|a, b| locale_compare(&a.to_lowercase(), &b.to_lowercase()));

        let limit = limit.unwrap_or(DEFAULT_LIMIT);
        let mut results: Vec<String> = Vec::new();
        let mut limit_reached = false;
        for entry in entries {
            if results.len() as f64 >= limit {
                limit_reached = true;
                break;
            }
            // Entries that cannot be read are left out.
            let Ok(metadata) = fs::metadata(Path::new(&directory).join(&entry)) else {
                continue;
            };
            let suffix = if metadata.is_dir() { "/" } else { "" };
            results.push(format!("{entry}{suffix}"));
        }
        if results.is_empty() {
            return Ok(text_result("(empty directory)".into(), None));
        }

        let truncation = truncate_head(
            &results.join("\n"),
            TruncationOptions {
                max_lines: Some(NO_LINE_LIMIT),
                max_bytes: None,
            },
        );
        let mut output = truncation.content.clone();
        let mut details = Map::new();
        let mut notices: Vec<String> = Vec::new();
        if limit_reached {
            notices.push(format!(
                "{} entries limit reached. Use limit={} for more",
                number(limit),
                number(limit * 2.0)
            ));
            details.insert("entryLimitReached".into(), js_number(limit));
        }
        if truncation.truncated {
            notices.push(format!("{} limit reached", format_size(DEFAULT_MAX_BYTES)));
            details.insert("truncation".into(), json!(truncation));
        }
        if !notices.is_empty() {
            output.push_str(&format!("\n\n[{}]", notices.join(". ")));
        }
        let details = (!details.is_empty()).then_some(Value::Object(details));
        Ok(text_result(output, details))
    }
}

impl AgentTool for LsTool {
    fn declaration(&self) -> &Tool {
        &self.declaration
    }

    fn typebox(&self) -> bool {
        true
    }

    fn execute<'a>(
        &'a self,
        _tool_call_id: &'a str,
        params: Value,
        signal: &'a AbortSignal,
        _on_update: ToolUpdate<'a>,
    ) -> BoxFuture<'a, Result<AgentToolResult, String>> {
        if signal.is_aborted() {
            return Box::pin(ready(Err("Operation aborted".into())));
        }
        let result = self.list(params["path"].as_str(), params["limit"].as_f64());
        Box::pin(ready(result))
    }
}
