//! The `edit` tool (`edit.ts`): exact-text replacements in one file, every `oldText` matched
//! against the original. The line endings and a byte order mark are kept; the details carry the
//! display diff, the unified patch and the first changed line.

use std::fs;

use futures_util::future::{ready, BoxFuture};
use relay_agent::{AgentTool, AgentToolResult, ToolUpdate};
use relay_ai::abort::AbortSignal;
use relay_ai::{InputBlock, JsonObject, TextContent, Tool};
use serde_json::{json, Value};

use crate::diff::{display_diff, unified_patch};
use crate::edit_diff::{
    apply_edits, detect_line_ending, normalize_to_lf, restore_line_endings, Edit,
};
use crate::js::fs_error;
use crate::mutation::with_file_lock;
use crate::paths::{home_dir, resolve_to_cwd};

const CONTEXT_LINES: usize = 4;

fn declaration() -> Tool {
    Tool {
        name: "edit".into(),
        description: "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.".into(),
        parameters: json!({
            "type": "object",
            "required": ["path", "edits"],
            "properties": {
                "path": {"type": "string", "description": "Path to the file to edit (relative or absolute)"},
                "edits": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["oldText", "newText"],
                        "properties": {
                            "oldText": {"type": "string", "description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."},
                            "newText": {"type": "string", "description": "Replacement text for this targeted edit."},
                        },
                    },
                    "description": "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
                },
            },
        }),
        constrained_sampling: Some(json!({"type": "json_schema", "strict": "prefer"})),
    }
}

fn is_single_edit(value: &Value) -> bool {
    value.as_object().is_some_and(|edit| {
        edit.get("oldText").is_some_and(Value::is_string)
            && edit.get("newText").is_some_and(Value::is_string)
    })
}

/// `prepareEditArguments`: edits sent as a JSON string or as one object become an array, and the
/// legacy `oldText`/`newText` fields join them. `None` when nothing changes.
pub fn prepare_edit_arguments(arguments: &JsonObject) -> Option<Value> {
    let mut args = arguments.clone();
    match args.get("edits") {
        Some(Value::String(text)) => match serde_json::from_str::<Value>(text) {
            Ok(parsed @ Value::Array(_)) => {
                args.insert("edits".into(), parsed);
            }
            Ok(parsed) if is_single_edit(&parsed) => {
                args.insert("edits".into(), Value::Array(vec![parsed]));
            }
            _ => {}
        },
        Some(edit) if is_single_edit(edit) => {
            let edit = edit.clone();
            args.insert("edits".into(), Value::Array(vec![edit]));
        }
        _ => {}
    }
    let legacy = match (args.get("oldText"), args.get("newText")) {
        (Some(Value::String(old_text)), Some(Value::String(new_text))) => {
            Some(json!({"oldText": old_text, "newText": new_text}))
        }
        _ => None,
    };
    if let Some(legacy) = legacy {
        let mut edits = match args.get("edits") {
            Some(Value::Array(edits)) => edits.clone(),
            _ => Vec::new(),
        };
        edits.push(legacy);
        args.shift_remove("oldText");
        args.shift_remove("newText");
        args.insert("edits".into(), Value::Array(edits));
    }
    (&args != arguments).then_some(Value::Object(args))
}

/// Edits files relative to a working directory.
pub struct EditTool {
    declaration: Tool,
    cwd: String,
    home: Option<String>,
}

impl EditTool {
    pub fn new(cwd: impl Into<String>) -> Self {
        EditTool {
            declaration: declaration(),
            cwd: cwd.into(),
            home: home_dir(),
        }
    }

    /// One call on prepared arguments; the error is the message the model receives.
    pub fn edit(&self, params: &Value, signal: &AbortSignal) -> Result<AgentToolResult, String> {
        let edits: Vec<Edit> = match params.get("edits") {
            Some(Value::Array(edits)) if !edits.is_empty() => edits
                .iter()
                .map(|edit| Edit {
                    old_text: edit["oldText"].as_str().unwrap_or_default().to_string(),
                    new_text: edit["newText"].as_str().unwrap_or_default().to_string(),
                })
                .collect(),
            _ => {
                return Err(
                    "Edit tool input is invalid. edits must contain at least one replacement."
                        .into(),
                )
            }
        };
        let path = params["path"].as_str().unwrap_or_default();
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
            let writable = fs::metadata(&absolute).and_then(|metadata| {
                if metadata.permissions().readonly() {
                    Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
                } else {
                    Ok(())
                }
            });
            if let Err(error) = writable {
                aborted()?;
                let code = fs_error(&error, "access", &absolute);
                let code = code.split(':').next().unwrap_or_default();
                return Err(format!("Could not edit file: {path}. Error code: {code}."));
            }
            aborted()?;
            let bytes = fs::read(&absolute).map_err(|error| fs_error(&error, "read", &absolute))?;
            let raw = String::from_utf8_lossy(&bytes);
            aborted()?;
            let (bom, content) = match raw.strip_prefix('\u{FEFF}') {
                Some(content) => ("\u{FEFF}", content),
                None => ("", raw.as_ref()),
            };
            let ending = detect_line_ending(content);
            let normalized = normalize_to_lf(content);
            let applied = apply_edits(&normalized, &edits, path)?;
            aborted()?;
            let written = format!("{bom}{}", restore_line_endings(&applied.new, ending));
            fs::write(&absolute, written).map_err(|error| fs_error(&error, "open", &absolute))?;
            aborted()?;
            let (diff, first_changed) = display_diff(&applied.base, &applied.new, CONTEXT_LINES);
            let patch = unified_patch(path, &applied.base, &applied.new, CONTEXT_LINES);
            let mut details = json!({"diff": diff, "patch": patch});
            if let Some(line) = first_changed {
                details["firstChangedLine"] = json!(line);
            }
            Ok(AgentToolResult {
                content: vec![InputBlock::Text(TextContent {
                    text: format!("Successfully replaced {} block(s) in {path}.", edits.len()),
                    text_signature: None,
                    volatile: None,
                })],
                details: Some(details),
                structured_content: None,
                usage: None,
                is_error: None,
                terminate: None,
            })
        })
    }
}

impl AgentTool for EditTool {
    fn declaration(&self) -> &Tool {
        &self.declaration
    }

    fn typebox(&self) -> bool {
        true
    }

    fn prepare_arguments(&self, arguments: &JsonObject) -> Result<Option<Value>, String> {
        Ok(prepare_edit_arguments(arguments))
    }

    fn execute<'a>(
        &'a self,
        _tool_call_id: &'a str,
        params: Value,
        signal: &'a AbortSignal,
        _on_update: ToolUpdate<'a>,
    ) -> BoxFuture<'a, Result<AgentToolResult, String>> {
        Box::pin(ready(self.edit(&params, signal)))
    }
}
