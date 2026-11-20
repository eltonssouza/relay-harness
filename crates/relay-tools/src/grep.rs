//! The `grep` tool (`grep.ts`): ripgrep's matches as `path:line: text`, with context lines as
//! `path-line- text`, up to 100 matches or 50 KB, long lines cut to 500 characters.

use std::collections::HashMap;
use std::fs;

use futures_util::future::BoxFuture;
use relay_agent::{AgentTool, AgentToolResult, ToolUpdate};
use relay_ai::abort::AbortSignal;
use relay_ai::json::js_number;
use relay_ai::text::is_js_whitespace;
use relay_ai::{InputBlock, TextContent, Tool};
use serde_json::{json, Map, Value};

use crate::js::number;
use crate::paths::{basename, home_dir, relative, resolve_to_cwd};
use crate::process::{run, LineHandler, RunError};
use crate::tools_manager::tool_path;
use crate::truncate::{
    format_size, truncate_head, truncate_line, TruncationOptions, DEFAULT_MAX_BYTES,
    GREP_MAX_LINE_LENGTH,
};

const DEFAULT_LIMIT: f64 = 100.0;
const NO_LINE_LIMIT: u64 = 9_007_199_254_740_991;

fn declaration() -> Tool {
    Tool {
        name: "grep".into(),
        description: format!(
            "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to {DEFAULT_LIMIT} matches or {}KB (whichever is hit first). Long lines are truncated to {GREP_MAX_LINE_LENGTH} chars.",
            DEFAULT_MAX_BYTES / 1024
        ),
        parameters: json!({
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": {"type": "string", "description": "Search pattern (regex or literal string)"},
                "path": {"type": "string", "description": "Directory or file to search (default: current directory)"},
                "glob": {"type": "string", "description": "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'"},
                "ignoreCase": {"type": "boolean", "description": "Case-insensitive search (default: false)"},
                "literal": {"type": "boolean", "description": "Treat pattern as literal string instead of regex (default: false)"},
                "context": {"type": "number", "description": "Number of lines to show before and after each match (default: 0)"},
                "limit": {"type": "number", "description": "Maximum number of matches to return (default: 100)"},
            },
        }),
        constrained_sampling: None,
    }
}

/// A match ripgrep reported.
struct Match {
    path: String,
    line: f64,
    text: Option<String>,
}

/// Collects ripgrep's JSON match events until the limit.
struct Matches {
    limit: f64,
    count: f64,
    found: Vec<Match>,
    limit_reached: bool,
}

impl LineHandler for Matches {
    fn line(&mut self, line: &str) -> bool {
        if line.trim_matches(is_js_whitespace).is_empty() || self.count >= self.limit {
            return true;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return true;
        };
        if event["type"] != "match" {
            return true;
        }
        self.count += 1.0;
        let data = &event["data"];
        let path = data["path"]["text"]
            .as_str()
            .filter(|path| !path.is_empty());
        if let (Some(path), Some(line)) = (path, data["line_number"].as_f64()) {
            self.found.push(Match {
                path: path.to_string(),
                line,
                text: data["lines"]["text"].as_str().map(str::to_string),
            });
        }
        if self.count >= self.limit {
            self.limit_reached = true;
            return false;
        }
        true
    }
}

/// Searches file contents relative to a working directory.
pub struct GrepTool {
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

/// What the formatting needs to know about one call.
struct Format<'a> {
    search_path: &'a str,
    is_directory: bool,
    context: f64,
    files: HashMap<String, Vec<String>>,
    lines_truncated: bool,
}

impl Format<'_> {
    /// The path as the model sees it (`formatPath`): relative to a searched directory, else the
    /// file name.
    fn path(&self, file: &str) -> String {
        let windows = cfg!(windows);
        if self.is_directory {
            let relative = relative(self.search_path, file, windows);
            if !relative.is_empty() && !relative.starts_with("..") {
                return relative.replace('\\', "/");
            }
        }
        basename(file, windows)
    }

    /// The file's lines, LF-normalized; none when it cannot be read.
    fn lines(&mut self, file: &str) -> &[String] {
        self.files
            .entry(file.to_string())
            .or_insert_with(|| match fs::read(file) {
                Ok(bytes) => String::from_utf8_lossy(&bytes)
                    .replace("\r\n", "\n")
                    .replace('\r', "\n")
                    .split('\n')
                    .map(str::to_string)
                    .collect(),
                Err(_) => Vec::new(),
            })
    }

    fn cut(&mut self, line: &str) -> String {
        let (text, truncated) = truncate_line(line, GREP_MAX_LINE_LENGTH);
        self.lines_truncated |= truncated;
        text
    }

    /// A match with its context lines (`formatBlock`).
    fn block(&mut self, file: &str, line: f64) -> Vec<String> {
        let path = self.path(file);
        let lines = self.lines(file).to_vec();
        if lines.is_empty() {
            return vec![format!("{path}:{}: (unable to read file)", number(line))];
        }
        let (start, end) = if self.context > 0.0 {
            (
                (line - self.context).max(1.0),
                (lines.len() as f64).min(line + self.context),
            )
        } else {
            (line, line)
        };
        let mut block = Vec::new();
        let mut current = start;
        while current <= end {
            let index = current - 1.0;
            let text = if index.fract() == 0.0 && index >= 0.0 {
                lines.get(index as usize).cloned().unwrap_or_default()
            } else {
                String::new()
            };
            let text = self.cut(&text.replace('\r', ""));
            if current == line {
                block.push(format!("{path}:{}: {text}", number(current)));
            } else {
                block.push(format!("{path}-{}- {text}", number(current)));
            }
            current += 1.0;
        }
        block
    }
}

impl GrepTool {
    pub fn new(cwd: impl Into<String>) -> Self {
        GrepTool {
            declaration: declaration(),
            cwd: cwd.into(),
            home: home_dir(),
        }
    }

    /// One call; the error is the message the model receives.
    pub async fn grep(
        &self,
        params: &Value,
        signal: &AbortSignal,
    ) -> Result<AgentToolResult, String> {
        if signal.is_aborted() {
            return Err("Operation aborted".into());
        }
        let Some(rg) = tool_path("rg") else {
            return Err("ripgrep (rg) is not available and could not be downloaded".into());
        };
        let path = params["path"]
            .as_str()
            .filter(|path| !path.is_empty())
            .unwrap_or(".");
        let search_path = resolve_to_cwd(path, &self.cwd, self.home.as_deref());
        let is_directory = fs::metadata(&search_path)
            .map(|metadata| metadata.is_dir())
            .map_err(|_| format!("Path not found: {search_path}"))?;
        let context = params["context"]
            .as_f64()
            .filter(|context| *context > 0.0)
            .unwrap_or(0.0);
        let limit = params["limit"].as_f64().unwrap_or(DEFAULT_LIMIT).max(1.0);

        let mut args: Vec<String> = ["--json", "--line-number", "--color=never", "--hidden"]
            .map(String::from)
            .to_vec();
        if params["ignoreCase"].as_bool() == Some(true) {
            args.push("--ignore-case".into());
        }
        if params["literal"].as_bool() == Some(true) {
            args.push("--fixed-strings".into());
        }
        if let Some(glob) = params["glob"].as_str().filter(|glob| !glob.is_empty()) {
            args.push("--glob".into());
            args.push(glob.into());
        }
        args.push("--".into());
        args.push(params["pattern"].as_str().unwrap_or_default().into());
        args.push(search_path.clone());

        let collector = Matches {
            limit,
            count: 0.0,
            found: Vec::new(),
            limit_reached: false,
        };
        let finished = match run(&rg, &args, signal, collector).await {
            Ok(finished) => finished,
            Err(RunError::Aborted) => return Err("Operation aborted".into()),
            Err(RunError::Spawn(error)) => return Err(format!("Failed to run ripgrep: {error}")),
        };
        let matches = finished.handler;
        if !finished.stopped && !matches!(finished.code, Some(0) | Some(1)) {
            let stderr = finished.stderr.trim_matches(is_js_whitespace);
            return Err(if stderr.is_empty() {
                let code = finished
                    .code
                    .map_or("null".to_string(), |code| code.to_string());
                format!("ripgrep exited with code {code}")
            } else {
                stderr.to_string()
            });
        }
        if matches.count == 0.0 {
            return Ok(text_result("No matches found".into(), None));
        }

        let mut format = Format {
            search_path: &search_path,
            is_directory,
            context,
            files: HashMap::new(),
            lines_truncated: false,
        };
        let mut output: Vec<String> = Vec::new();
        for found in &matches.found {
            match (&found.text, context == 0.0) {
                (Some(text), true) => {
                    let path = format.path(&found.path);
                    let text = text.replace("\r\n", "\n").replace('\r', "");
                    let text = text.strip_suffix('\n').unwrap_or(&text);
                    let text = format.cut(text);
                    output.push(format!("{path}:{}: {text}", number(found.line)));
                }
                _ => output.extend(format.block(&found.path, found.line)),
            }
        }

        let truncation = truncate_head(
            &output.join("\n"),
            TruncationOptions {
                max_lines: Some(NO_LINE_LIMIT),
                max_bytes: None,
            },
        );
        let mut text = truncation.content.clone();
        let mut details = Map::new();
        let mut notices: Vec<String> = Vec::new();
        if matches.limit_reached {
            notices.push(format!(
                "{} matches limit reached. Use limit={} for more, or refine pattern",
                number(limit),
                number(limit * 2.0)
            ));
            details.insert("matchLimitReached".into(), js_number(limit));
        }
        if truncation.truncated {
            notices.push(format!("{} limit reached", format_size(DEFAULT_MAX_BYTES)));
            details.insert("truncation".into(), json!(truncation));
        }
        if format.lines_truncated {
            notices.push(format!(
                "Some lines truncated to {GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines"
            ));
            details.insert("linesTruncated".into(), Value::Bool(true));
        }
        if !notices.is_empty() {
            text.push_str(&format!("\n\n[{}]", notices.join(". ")));
        }
        Ok(text_result(
            text,
            (!details.is_empty()).then_some(Value::Object(details)),
        ))
    }
}

impl AgentTool for GrepTool {
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
        Box::pin(async move { self.grep(&params, signal).await })
    }
}
