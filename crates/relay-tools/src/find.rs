//! The `find` tool (`find.ts`): fd's matches for a glob, relative to the searched directory, up to
//! 1000 results or 50 KB. Inside a git repository fd's git-aware ignores apply; outside one,
//! `.gitignore` files still count.

use std::path::Path;

use futures_util::future::BoxFuture;
use relay_agent::{AgentTool, AgentToolResult, ToolUpdate};
use relay_ai::abort::AbortSignal;
use relay_ai::json::js_number;
use relay_ai::text::is_js_whitespace;
use relay_ai::{InputBlock, TextContent, Tool};
use serde_json::{json, Map, Value};

use crate::js::number;
use crate::paths::{dirname, home_dir, is_absolute_path, relative, resolve_to_cwd};
use crate::process::{run, LineHandler, RunError};
use crate::tools_manager::{ensure_tool, ToolDownloads};
use crate::truncate::{format_size, truncate_head, TruncationOptions, DEFAULT_MAX_BYTES};

const DEFAULT_LIMIT: f64 = 1000.0;
const NO_LINE_LIMIT: u64 = 9_007_199_254_740_991;

fn declaration() -> Tool {
    Tool {
        name: "find".into(),
        description: format!(
            "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to {DEFAULT_LIMIT} results or {}KB (whichever is hit first).",
            DEFAULT_MAX_BYTES / 1024
        ),
        parameters: json!({
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"},
                "path": {"type": "string", "description": "Directory to search in (default: current directory)"},
                "limit": {"type": "number", "description": "Maximum number of results (default: 1000)"},
            },
        }),
        constrained_sampling: None,
    }
}

/// A result relative to the searched directory, with `/` separators and a directory's trailing
/// `/` kept (`relativizeFindResultPath`).
pub fn relativize_find_result_path(result: &str, search_path: &str, windows: bool) -> String {
    let had_trailing =
        result.ends_with(if windows { '\\' } else { '/' }) || (windows && result.ends_with('/'));
    let relative_path = if is_absolute_path(result, windows) {
        relative(search_path, result, windows)
    } else {
        result.to_string()
    };
    let separator = if windows { "\\" } else { "/" };
    let posix = relative_path.split(separator).collect::<Vec<_>>().join("/");
    if had_trailing && !posix.ends_with('/') {
        format!("{posix}/")
    } else {
        posix
    }
}

struct Lines(Vec<String>);

impl LineHandler for Lines {
    fn line(&mut self, line: &str) -> bool {
        self.0.push(line.to_string());
        true
    }
}

/// Finds files relative to a working directory.
pub struct FindTool {
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

/// Whether a directory or one of its parents holds `.git`.
fn inside_git_repository(path: &str, windows: bool) -> bool {
    let mut current = path.to_string();
    loop {
        if Path::new(&current).join(".git").exists() {
            return true;
        }
        let parent = dirname(&current, windows);
        if parent == current {
            return false;
        }
        current = parent;
    }
}

impl FindTool {
    pub fn new(cwd: impl Into<String>) -> Self {
        FindTool {
            declaration: declaration(),
            cwd: cwd.into(),
            home: home_dir(),
        }
    }

    /// One call; the error is the message the model receives.
    pub async fn find(
        &self,
        params: &Value,
        signal: &AbortSignal,
    ) -> Result<AgentToolResult, String> {
        if signal.is_aborted() {
            return Err("Operation aborted".into());
        }
        let windows = cfg!(windows);
        let path = params["path"]
            .as_str()
            .filter(|path| !path.is_empty())
            .unwrap_or(".");
        let search_path = resolve_to_cwd(path, &self.cwd, self.home.as_deref());
        let limit = params["limit"].as_f64().unwrap_or(DEFAULT_LIMIT);
        let Some(fd) = ensure_tool("fd", &ToolDownloads::default(), None).await else {
            return Err("fd is not available and could not be downloaded".into());
        };

        let mut args: Vec<String> = ["--glob", "--color=never", "--hidden"]
            .map(String::from)
            .to_vec();
        if !inside_git_repository(&search_path, windows) {
            args.push("--no-require-git".into());
        }
        args.push("--max-results".into());
        args.push(number(limit));
        let pattern = params["pattern"].as_str().unwrap_or_default();
        let mut effective = pattern.to_string();
        if pattern.contains('/') {
            args.push("--full-path".into());
            if !pattern.starts_with('/') && !pattern.starts_with("**/") && pattern != "**" {
                effective = format!("**/{pattern}");
            }
            if windows {
                effective = effective.replace('/', "[/\\\\]");
            }
        }
        args.push("--".into());
        args.push(effective);
        args.push(search_path.clone());

        let finished = match run(&fd, &args, signal, Lines(Vec::new())).await {
            Ok(finished) => finished,
            Err(RunError::Aborted) => return Err("Operation aborted".into()),
            Err(RunError::Spawn(error)) => return Err(format!("Failed to run fd: {error}")),
        };
        let lines = finished.handler.0;
        let output = lines.join("\n");
        if finished.code != Some(0) && output.is_empty() {
            let stderr = finished.stderr.trim_matches(is_js_whitespace);
            return Err(if stderr.is_empty() {
                let code = finished
                    .code
                    .map_or("null".to_string(), |code| code.to_string());
                format!("fd exited with code {code}")
            } else {
                stderr.to_string()
            });
        }
        if output.is_empty() {
            return Ok(text_result("No files found matching pattern".into(), None));
        }

        let relativized: Vec<String> = lines
            .iter()
            .map(|line| {
                line.strip_suffix('\r')
                    .unwrap_or(line)
                    .trim_matches(is_js_whitespace)
            })
            .filter(|line| !line.is_empty())
            .map(|line| relativize_find_result_path(line, &search_path, windows))
            .collect();
        let limit_reached = relativized.len() as f64 >= limit;
        let truncation = truncate_head(
            &relativized.join("\n"),
            TruncationOptions {
                max_lines: Some(NO_LINE_LIMIT),
                max_bytes: None,
            },
        );
        let mut text = truncation.content.clone();
        let mut details = Map::new();
        let mut notices: Vec<String> = Vec::new();
        if limit_reached {
            notices.push(format!(
                "{} results limit reached. Use limit={} for more, or refine pattern",
                number(limit),
                number(limit * 2.0)
            ));
            details.insert("resultLimitReached".into(), js_number(limit));
        }
        if truncation.truncated {
            notices.push(format!("{} limit reached", format_size(DEFAULT_MAX_BYTES)));
            details.insert("truncation".into(), json!(truncation));
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

impl AgentTool for FindTool {
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
        Box::pin(async move { self.find(&params, signal).await })
    }
}
