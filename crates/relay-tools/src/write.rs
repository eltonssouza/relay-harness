//! The `write` tool (`write.ts`): creates or overwrites a file, and its parent directories.

use std::fs;
use std::path::Path;

use futures_util::future::{ready, BoxFuture};
use relay_agent::{AgentTool, AgentToolResult, ToolUpdate};
use relay_ai::abort::AbortSignal;
use relay_ai::{InputBlock, TextContent, Tool};
use serde_json::{json, Value};

use crate::js::fs_error;
use crate::mutation::with_file_lock;
use crate::paths::{home_dir, resolve_to_cwd};

fn declaration() -> Tool {
    Tool {
        name: "write".into(),
        description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.".into(),
        parameters: json!({
            "type": "object",
            "required": ["path", "content"],
            "properties": {
                "path": {"type": "string", "description": "Path to the file to write (relative or absolute)"},
                "content": {"type": "string", "description": "Content to write to the file"},
            },
        }),
        constrained_sampling: Some(json!({"type": "json_schema", "strict": "prefer"})),
    }
}

/// Writes files relative to a working directory.
pub struct WriteTool {
    declaration: Tool,
    cwd: String,
    home: Option<String>,
}

impl WriteTool {
    pub fn new(cwd: impl Into<String>) -> Self {
        WriteTool {
            declaration: declaration(),
            cwd: cwd.into(),
            home: home_dir(),
        }
    }

    /// One call; the error is the message the model receives.
    pub fn write(
        &self,
        path: &str,
        content: &str,
        signal: &AbortSignal,
    ) -> Result<AgentToolResult, String> {
        let absolute = resolve_to_cwd(path, &self.cwd, self.home.as_deref());
        let aborted = || {
            if signal.is_aborted() {
                Err("Operation aborted".to_string())
            } else {
                Ok(())
            }
        };
        with_file_lock(&absolute, || {
            aborted()?;
            if let Some(parent) = Path::new(&absolute).parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| fs_error(&error, "mkdir", &parent.to_string_lossy()))?;
            }
            aborted()?;
            fs::write(&absolute, content).map_err(|error| fs_error(&error, "open", &absolute))?;
            aborted()?;
            Ok(AgentToolResult {
                content: vec![InputBlock::Text(TextContent {
                    text: format!("Successfully wrote to {path}"),
                    text_signature: None,
                    volatile: None,
                })],
                details: None,
                structured_content: None,
                usage: None,
                is_error: None,
                terminate: None,
            })
        })
    }
}

impl AgentTool for WriteTool {
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
        let path = params["path"].as_str().unwrap_or_default();
        let content = params["content"].as_str().unwrap_or_default();
        Box::pin(ready(self.write(path, content, signal)))
    }
}
