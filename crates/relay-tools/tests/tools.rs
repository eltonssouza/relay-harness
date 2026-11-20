//! Replays `crates/fixtures/tools/`, what the TypeScript tools and helpers returned
//! (`packages/coding-agent/test/parity/tools-record.ts`): the helpers on fixed inputs, and `read`
//! and `ls` on a fixture tree. The tree is written to a temporary directory; its path becomes
//! `<root>`, as the recorder writes it.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use relay_agent::AgentTool;
use relay_ai::abort::AbortSignal;
use relay_tools::diff::{diff_lines, display_diff, unified_patch};
use relay_tools::edit::prepare_edit_arguments;
use relay_tools::mime::detect_supported_image_mime_type;
use relay_tools::truncate::{
    format_size, truncate_head, truncate_line, truncate_middle, truncate_tail, TruncationOptions,
};
use relay_tools::{EditTool, LsTool, ReadTool, WriteTool};
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/tools")
        .join(name);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn differences(label: &str, expected: &Value, actual: &Value, failures: &mut Vec<String>) {
    if expected != actual {
        let show = |value: &Value| {
            let text = value.to_string();
            if text.len() > 600 {
                format!("{}...", &text[..text.floor_char_boundary(600)])
            } else {
                text
            }
        };
        failures.push(format!(
            "{label}\n    expected {}\n    actual   {}",
            show(expected),
            show(actual)
        ));
    }
}

#[test]
fn helpers_match_the_typescript_helpers() {
    let helpers = fixture("helpers.json");
    let mut failures = Vec::new();
    for case in helpers["truncation"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let options = TruncationOptions {
            max_lines: case["options"]["maxLines"].as_u64(),
            max_bytes: case["options"]["maxBytes"].as_u64(),
        };
        let label = format!("{:?} {}", text, case["options"]);
        let head = json!(truncate_head(text, options));
        differences(
            &format!("head {label}"),
            &case["head"],
            &head,
            &mut failures,
        );
        let tail = json!(truncate_tail(text, options));
        differences(
            &format!("tail {label}"),
            &case["tail"],
            &tail,
            &mut failures,
        );
    }
    for case in helpers["middle"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let max = case["maxBytes"].as_u64().unwrap();
        let actual = json!(truncate_middle(text, max));
        differences(
            &format!("middle {text:?} {max}"),
            &case["result"],
            &actual,
            &mut failures,
        );
    }
    for case in helpers["line"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let max = case["max"].as_u64().unwrap() as usize;
        let (line, truncated) = truncate_line(text, max);
        let actual = json!({"text": line, "wasTruncated": truncated});
        differences(
            &format!("line {text:?} {max}"),
            &case["result"],
            &actual,
            &mut failures,
        );
    }
    for case in helpers["sizes"].as_array().unwrap() {
        let bytes = case["bytes"].as_u64().unwrap();
        differences(
            &format!("size {bytes}"),
            &case["text"],
            &json!(format_size(bytes)),
            &mut failures,
        );
    }
    for case in helpers["images"].as_array().unwrap() {
        let bytes: Vec<u8> = case["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|byte| byte.as_u64().unwrap() as u8)
            .collect();
        let actual = json!(detect_supported_image_mime_type(&bytes));
        differences(
            &format!("image {bytes:?}"),
            &case["mimeType"],
            &actual,
            &mut failures,
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The fixture tree in a fresh temporary directory, removed on drop.
struct Tree(PathBuf);

impl Tree {
    fn new(entries: &[Value]) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let next = NEXT.fetch_add(1, Ordering::SeqCst);
        let name = format!("relay-tools-{}-{nanos}-{next}", std::process::id());
        let root = std::env::temp_dir().join(name);
        fs::create_dir_all(&root).unwrap();
        for entry in entries {
            let path = entry["path"].as_str().unwrap();
            let target = root.join(path);
            if path.ends_with('/') {
                fs::create_dir_all(&target).unwrap();
            } else if let Some(encoded) = entry["base64"].as_str() {
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .unwrap();
                fs::write(&target, bytes).unwrap();
            } else {
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                fs::write(&target, entry["text"].as_str().unwrap_or_default()).unwrap();
            }
        }
        Tree(root)
    }

    fn root(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// `<root>` for the tree's directory and `/` in the paths under it, as the recorder writes them.
fn portable(value: Value, root: &str) -> Value {
    match value {
        Value::String(text) if text.contains(root) => {
            let replaced = text.replace(root, "<root>");
            let mut result = String::new();
            let mut rest = replaced.as_str();
            while let Some(index) = rest.find("<root>") {
                result.push_str(&rest[..index]);
                let path = &rest[index..];
                let end = path
                    .find(|character: char| {
                        character == '\'' || character == ']' || character.is_whitespace()
                    })
                    .unwrap_or(path.len());
                result.push_str(&path[..end].replace('\\', "/"));
                rest = &path[end..];
            }
            result.push_str(rest);
            Value::String(result)
        }
        Value::Array(items) => {
            Value::Array(items.into_iter().map(|item| portable(item, root)).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, item)| (key, portable(item, root)))
                .collect(),
        ),
        other => other,
    }
}

fn with_root(args: &Value, root: &str) -> Value {
    serde_json::from_str(
        &args
            .to_string()
            .replace("<root>", &root.replace('\\', "\\\\")),
    )
    .unwrap()
}

fn outcome(result: Result<relay_agent::AgentToolResult, String>, root: &str) -> Value {
    match result {
        Ok(result) => json!({ "result": portable(json!(result), root) }),
        Err(error) => json!({ "error": portable(json!(error), root) }),
    }
}

fn expected_outcome(call: &Value) -> Value {
    match call.get("error") {
        Some(error) => json!({ "error": error }),
        None => json!({ "result": call["result"] }),
    }
}

fn check_declaration(tool: &dyn AgentTool, expected: &Value, failures: &mut Vec<String>) {
    let actual = serde_json::to_string(tool.declaration()).unwrap();
    let expected = serde_json::to_string(expected).unwrap();
    if actual != expected {
        failures.push(format!(
            "declaration\n    expected {expected}\n    actual   {actual}"
        ));
    }
}

#[test]
fn read_and_ls_answer_as_the_typescript_tools_do() {
    let read_cases = fixture("read.json");
    let ls_cases = fixture("ls.json");
    let tree = Tree::new(read_cases["tree"].as_array().unwrap());
    let root = tree.root();
    let read = ReadTool::new(root.clone());
    let ls = LsTool::new(root.clone());
    let mut failures = Vec::new();
    check_declaration(&read, &read_cases["declaration"], &mut failures);
    check_declaration(&ls, &ls_cases["declaration"], &mut failures);
    for call in read_cases["calls"].as_array().unwrap() {
        let args = with_root(&call["args"], &root);
        let result = read.read(
            args["path"].as_str().unwrap(),
            args["offset"].as_f64(),
            args["limit"].as_f64(),
        );
        let label = format!("read {}", call["args"]);
        differences(
            &label,
            &expected_outcome(call),
            &outcome(result, &root),
            &mut failures,
        );
    }
    for call in ls_cases["calls"].as_array().unwrap() {
        let args = with_root(&call["args"], &root);
        let result = ls.list(args["path"].as_str(), args["limit"].as_f64());
        let label = format!("ls {}", call["args"]);
        differences(
            &label,
            &expected_outcome(call),
            &outcome(result, &root),
            &mut failures,
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn diffs_match_jsdiff() {
    let mut failures = Vec::new();
    for (index, case) in fixture("diff.json").as_array().unwrap().iter().enumerate() {
        let before = case["before"].as_str().unwrap();
        let after = case["after"].as_str().unwrap();
        let label = format!("diff {index} {before:?} -> {after:?}");
        let parts: Vec<Value> = diff_lines(before, after)
            .into_iter()
            .map(|change| {
                json!({
                    "value": change.value,
                    "count": change.count,
                    "added": change.added,
                    "removed": change.removed,
                })
            })
            .collect();
        differences(
            &format!("{label} parts"),
            &case["parts"],
            &json!(parts),
            &mut failures,
        );
        let (diff, first) = display_diff(before, after, 4);
        let mut display = json!({ "diff": diff });
        if let Some(first) = first {
            display["firstChangedLine"] = json!(first);
        }
        differences(
            &format!("{label} display"),
            &case["display"],
            &display,
            &mut failures,
        );
        let patch = unified_patch("f.txt", before, after, 4);
        differences(
            &format!("{label} patch"),
            &case["patch"],
            &json!(patch),
            &mut failures,
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A call's files afterwards: their bytes, or that they are missing.
fn files_after(root: &str, call: &Value) -> Value {
    let states: Vec<Value> = call["after"]
        .as_array()
        .unwrap()
        .iter()
        .map(|state| {
            let path = state["path"].as_str().unwrap();
            match fs::read(Path::new(root).join(path)) {
                Ok(bytes) => json!({
                    "path": path,
                    "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
                }),
                Err(_) => json!({ "path": path, "missing": true }),
            }
        })
        .collect();
    json!(states)
}

#[test]
fn edit_and_write_change_files_as_the_typescript_tools_do() {
    let mut failures = Vec::new();
    for tool in ["edit", "write"] {
        let cases = fixture(&format!("{tool}.json"));
        for call in cases["calls"].as_array().unwrap() {
            let tree = Tree::new(call["files"].as_array().unwrap());
            let root = tree.root();
            let signal = AbortSignal::never();
            let args = &call["args"];
            let result = if tool == "edit" {
                let edit = EditTool::new(root.clone());
                check_declaration(&edit, &cases["declaration"], &mut failures);
                let prepared = prepare_edit_arguments(args.as_object().unwrap())
                    .unwrap_or_else(|| args.clone());
                edit.edit(&prepared, &signal)
            } else {
                let write = WriteTool::new(root.clone());
                check_declaration(&write, &cases["declaration"], &mut failures);
                let path = args["path"].as_str().unwrap();
                write.write(path, args["content"].as_str().unwrap(), &signal)
            };
            let label = format!("{tool} {}", call["name"]);
            differences(
                &label,
                &expected_outcome(call),
                &outcome(result, &root),
                &mut failures,
            );
            let after = files_after(&root, call);
            differences(
                &format!("{label} files"),
                &call["after"],
                &after,
                &mut failures,
            );
        }
    }
    failures.dedup();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
