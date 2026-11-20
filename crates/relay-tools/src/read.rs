//! The `read` tool (`read.ts`): a text file's lines from an offset, cut to 2000 lines or 50 KB
//! with a notice that says how to continue. Images are attached in TypeScript; here they are
//! not supported yet, since resizing them needs an image codec.

use std::fs;
use std::path::Path;

use futures_util::future::{ready, BoxFuture};
use relay_agent::{AgentTool, AgentToolResult, ToolUpdate};
use relay_ai::abort::AbortSignal;
use relay_ai::{InputBlock, TextContent, Tool};
use serde_json::{json, Value};

use crate::js::{fs_error, number, slice};
use crate::mime::detect_supported_image_mime_type_from_file;
use crate::paths::{home_dir, resolve_read_path};
use crate::truncate::{
    format_size, truncate_head, TruncatedBy, TruncationOptions, DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
};

/// The declaration the TypeScript agent sends for `read`.
fn declaration() -> Tool {
    Tool {
        name: "read".into(),
        description: format!(
            "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to {DEFAULT_MAX_LINES} lines or {}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
            DEFAULT_MAX_BYTES / 1024
        ),
        parameters: json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string", "description": "Path to the file to read (relative or absolute)"},
                "offset": {"type": "number", "description": "Line number to start reading from (1-indexed)"},
                "limit": {"type": "number", "description": "Maximum number of lines to read"},
            },
        }),
        constrained_sampling: Some(json!({"type": "json_schema", "strict": "prefer"})),
    }
}

/// Reads files relative to a working directory.
pub struct ReadTool {
    declaration: Tool,
    cwd: String,
    home: Option<String>,
}

impl ReadTool {
    pub fn new(cwd: impl Into<String>) -> Self {
        ReadTool {
            declaration: declaration(),
            cwd: cwd.into(),
            home: home_dir(),
        }
    }

    /// One call; the error is the message the model receives.
    pub fn read(
        &self,
        path: &str,
        offset: Option<f64>,
        limit: Option<f64>,
    ) -> Result<AgentToolResult, String> {
        let absolute = resolve_read_path(path, &self.cwd, self.home.as_deref());
        fs::metadata(&absolute).map_err(|error| fs_error(&error, "access", &absolute))?;
        let image = detect_supported_image_mime_type_from_file(Path::new(&absolute))
            .map_err(|error| fs_error(&error, "open", &absolute))?;
        if image.is_some() {
            return Err("Reading images is not supported by the Rust tools yet".into());
        }
        let bytes = fs::read(&absolute).map_err(|error| fs_error(&error, "open", &absolute))?;
        let text = String::from_utf8_lossy(&bytes);
        let (text, details) = read_lines(&text, path, offset, limit)?;
        Ok(AgentToolResult {
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
        })
    }
}

/// The text of a read and its details, with JavaScript's arithmetic for the offset and the
/// limit: fractions and negative numbers behave as they do there.
fn read_lines(
    text: &str,
    path: &str,
    offset: Option<f64>,
    limit: Option<f64>,
) -> Result<(String, Option<Value>), String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let total = lines.len() as f64;
    let start = match offset {
        Some(offset) if offset != 0.0 && !offset.is_nan() => (offset - 1.0).max(0.0),
        _ => 0.0,
    };
    let start_display = start + 1.0;
    if start >= total {
        let offset = offset.map_or("undefined".into(), number);
        return Err(format!(
            "Offset {offset} is beyond end of file ({} lines total)",
            lines.len()
        ));
    }
    let (selected, user_limited) = match limit {
        Some(limit) => {
            let end = (start + limit).min(total);
            (
                slice(&lines, start, Some(end)).join("\n"),
                Some(end - start),
            )
        }
        None => (slice(&lines, start, None).join("\n"), None),
    };
    let truncation = truncate_head(&selected, TruncationOptions::default());
    let limit_text = format_size(DEFAULT_MAX_BYTES);
    if truncation.first_line_exceeds_limit {
        let first = lines[start as usize];
        let size = format_size(first.len() as u64);
        let line = number(start_display);
        let text = format!(
            "[Line {line} is {size}, exceeds {limit_text} limit. Use bash: sed -n '{line}p' {path} | head -c {DEFAULT_MAX_BYTES}]"
        );
        return Ok((text, Some(json!({ "truncation": truncation }))));
    }
    if truncation.truncated {
        let end_display = start_display + truncation.output_lines as f64 - 1.0;
        let next = number(end_display + 1.0);
        let range = format!("{}-{}", number(start_display), number(end_display));
        let notice = match truncation.truncated_by {
            Some(TruncatedBy::Lines) => {
                format!("[Showing lines {range} of {}. Use offset={next} to continue.]", lines.len())
            }
            _ => format!(
                "[Showing lines {range} of {} ({limit_text} limit). Use offset={next} to continue.]",
                lines.len()
            ),
        };
        let text = format!("{}\n\n{notice}", truncation.content);
        return Ok((text, Some(json!({ "truncation": truncation }))));
    }
    if let Some(limited) = user_limited.filter(|limited| start + limited < total) {
        let remaining = number(total - (start + limited));
        let next = number(start + limited + 1.0);
        let text = format!(
            "{}\n\n[{remaining} more lines in file. Use offset={next} to continue.]",
            truncation.content
        );
        return Ok((text, None));
    }
    Ok((truncation.content, None))
}

impl AgentTool for ReadTool {
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
        let path = params["path"].as_str().unwrap_or_default();
        let result = self.read(path, params["offset"].as_f64(), params["limit"].as_f64());
        Box::pin(ready(result))
    }
}
