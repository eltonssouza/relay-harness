//! Replays `crates/fixtures/tools/output.json` and `bash.json`, what the TypeScript output
//! accumulator and bash tool did (`packages/coding-agent/test/parity/shell-record.ts`). Output
//! file paths become `<output>`, the call tree's directory `<root>`, and strings over 2000
//! characters their length, FNV-1a hash and ends, as the recorder writes them.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use relay_agent::{AgentTool, AgentToolResult};
use relay_ai::abort::AbortController;
use relay_tools::bash::{ShellSession, ShellToolOptions, SpawnContext};
use relay_tools::output::{temp_dir, OutputAccumulator, OutputAccumulatorOptions, OutputSnapshot};
use relay_tools::ShellTool;
use serde_json::{json, Map, Value};

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/tools")
        .join(name);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

/// Compares serialized JSON, so key order counts too.
fn differences(label: &str, expected: &Value, actual: &Value, failures: &mut Vec<String>) {
    let expected = expected.to_string();
    let actual = actual.to_string();
    if expected != actual {
        let show = |text: &str| {
            if text.len() > 600 {
                format!("{}...", &text[..text.floor_char_boundary(600)])
            } else {
                text.to_string()
            }
        };
        failures.push(format!(
            "{label}\n    expected {}\n    actual   {}",
            show(&expected),
            show(&actual)
        ));
    }
}

fn fnv(text: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

/// The length of an output file name after the temporary directory: `[\\/]relay-<name>-<16
/// hexadecimal digits>.log`.
fn output_name_length(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if !matches!(bytes.first(), Some(b'\\' | b'/')) || !text[1..].starts_with("relay-") {
        return None;
    }
    let mut at = 7;
    let start = at;
    while bytes.get(at).is_some_and(u8::is_ascii_lowercase) {
        at += 1;
    }
    if at == start || bytes.get(at) != Some(&b'-') {
        return None;
    }
    at += 1;
    for _ in 0..16 {
        if !bytes
            .get(at)
            .is_some_and(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return None;
        }
        at += 1;
    }
    text[at..].starts_with(".log").then_some(at + 4)
}

fn replace_output_paths(text: &str) -> String {
    let temp = temp_dir();
    let mut result = String::new();
    let mut rest = text;
    while let Some(index) = rest.find(&temp) {
        result.push_str(&rest[..index]);
        let after = &rest[index + temp.len()..];
        match output_name_length(after) {
            Some(length) => {
                result.push_str("<output>");
                rest = &after[length..];
            }
            None => {
                result.push_str(&temp);
                rest = after;
            }
        }
    }
    result.push_str(rest);
    result
}

fn replace_root(text: &str, root: &str) -> String {
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
    result
}

/// The recorder's `portable`.
fn portable(value: Value, root: Option<&str>) -> Value {
    match value {
        Value::String(text) => {
            let mut text = replace_output_paths(&text);
            if let Some(root) = root {
                text = replace_root(&text, root);
            }
            let length: usize = text.chars().map(char::len_utf16).sum();
            if length <= 2000 {
                return Value::String(text);
            }
            let points: Vec<char> = text.chars().collect();
            json!({
                "long": length,
                "fnv": fnv(&text),
                "start": points[..80].iter().collect::<String>(),
                "end": points[points.len() - 80..].iter().collect::<String>(),
            })
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

fn snapshot_json(snapshot: &OutputSnapshot) -> Value {
    let mut fields = Map::new();
    fields.insert("content".into(), json!(snapshot.content));
    fields.insert("truncation".into(), json!(snapshot.truncation));
    if let Some(path) = &snapshot.full_output_path {
        fields.insert("fullOutputPath".into(), json!(path));
    }
    Value::Object(fields)
}

fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[test]
fn the_output_accumulator_matches_the_typescript_one() {
    let cases = fixture("output.json");
    let mut failures = Vec::new();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut output = OutputAccumulator::new(OutputAccumulatorOptions {
            max_lines: case["maxLines"].as_u64().unwrap(),
            max_bytes: case["maxBytes"].as_u64().unwrap(),
            temp_file_prefix: "relay-parity".into(),
        });
        let mut snapshots = Vec::new();
        for chunk in case["chunks"].as_array().unwrap() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(chunk.as_str().unwrap())
                .unwrap();
            output.append(&bytes);
            snapshots.push(snapshot_json(&output.snapshot(false)));
        }
        output.finish();
        let last = output.snapshot(true);
        output.close_temp_file().unwrap();
        let full_outputs: Vec<Value> = [1, 7, 16, 1000]
            .into_iter()
            .map(|max_bytes| {
                let full = output.read_full_output(max_bytes).unwrap();
                json!({"maxBytes": max_bytes, "content": full.content, "truncated": full.truncated})
            })
            .collect();
        let file = last.full_output_path.as_ref().map(|path| {
            let bytes = fs::read(path).unwrap();
            let _ = fs::remove_file(path);
            base64(&bytes)
        });
        let actual = portable(
            json!({
                "snapshots": snapshots,
                "final": snapshot_json(&last),
                "lastLineBytes": output.last_line_bytes(),
                "file": file,
                "fullOutputs": full_outputs,
            }),
            None,
        );
        for field in ["snapshots", "final", "lastLineBytes", "file", "fullOutputs"] {
            let expected = case.get(field).cloned().unwrap_or(Value::Null);
            differences(
                &format!("{name}: {field}"),
                &expected,
                &actual[field],
                &mut failures,
            );
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The calls' working tree in a fresh temporary directory, removed on drop.
struct Tree(PathBuf);

impl Tree {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            Path::new(&temp_dir()).join(format!("relay-shell-tree-{}-{nanos}", std::process::id()));
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("file.txt"), "in the root\n").unwrap();
        fs::write(root.join("sub").join("inner.txt"), "in sub\n").unwrap();
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

fn check_declaration(tool: &dyn AgentTool, expected: &Value, failures: &mut Vec<String>) {
    let actual = serde_json::to_string(tool.declaration()).unwrap();
    let expected = serde_json::to_string(expected).unwrap();
    if actual != expected {
        failures.push(format!(
            "declaration\n    expected {expected}\n    actual   {actual}"
        ));
    }
}

fn session(call: &Value, root: &str) -> Option<ShellSession> {
    let session = call.get("session")?;
    let text = |field: &str| session[field].as_str().map(str::to_string);
    Some(ShellSession {
        cwd: text("cwd").map(|cwd| cwd.replace("<root>", root)),
        session_id: text("sessionId").unwrap(),
        session_file: text("sessionFile"),
        model: session["model"].as_array().map(|model| {
            (
                model[0].as_str().unwrap().to_string(),
                model[1].as_str().unwrap().to_string(),
            )
        }),
        thinking_level: text("thinkingLevel"),
    })
}

fn tool(call: &Value, root: &str) -> ShellTool {
    let mut options = ShellToolOptions {
        session: session(call, root).map(|session| {
            let source: relay_tools::bash::SessionSource = Arc::new(move || session.clone());
            source
        }),
        ..ShellToolOptions::default()
    };
    let mut cwd = root.to_string();
    match call["tool"].as_str() {
        Some("prefix") => options.command_prefix = Some("GREETING=hi".into()),
        Some("hook") => {
            options.spawn_hook = Some(Arc::new(|mut context: SpawnContext| {
                context.command = format!("echo hooked; {}", context.command);
                context.env.push(("HOOKED".into(), "1".into()));
                context
            }));
        }
        Some("missing cwd") => {
            cwd = Path::new(root)
                .join("missing")
                .to_string_lossy()
                .into_owned();
        }
        Some("hidden session") => options.expose_session_environment = false,
        _ => {}
    }
    ShellTool::bash(cwd, options)
}

#[tokio::test]
async fn bash_answers_as_the_typescript_tool_does() {
    let recorded = fixture("bash.json");
    // A command must not see the agent's own session.
    std::env::set_var("RELAY_MODEL", "parent-model");
    let tree = Tree::new();
    let root = tree.root();
    let mut failures = Vec::new();
    check_declaration(
        &ShellTool::bash(&root, ShellToolOptions::default()),
        &recorded["declaration"],
        &mut failures,
    );
    check_declaration(
        &ShellTool::powershell(&root, ShellToolOptions::default()),
        &recorded["powershellDeclaration"],
        &mut failures,
    );
    for call in recorded["calls"].as_array().unwrap() {
        let name = call["name"].as_str().unwrap();
        let tool = tool(call, &root);
        let controller = AbortController::new();
        if call["abortBefore"] == true {
            controller.abort();
        }
        let abort_on = call["abortOn"].as_str();
        let updates = Mutex::new(Vec::new());
        let on_update = |update: AgentToolResult| {
            let value = json!(update);
            let text = value["content"][0]["text"].as_str().unwrap_or_default();
            if abort_on.is_some_and(|marker| text.contains(marker)) {
                controller.abort();
            }
            updates.lock().unwrap().push(value);
        };
        let started = Instant::now();
        let signal = controller.signal();
        let outcome = tool
            .execute("call", call["args"].clone(), &signal, &on_update)
            .await;
        if let Some(within) = call["withinSeconds"].as_f64() {
            if started.elapsed() > Duration::from_secs_f64(within) {
                failures.push(format!(
                    "{name}: took {:?}, over {within} s: it waited for the processes it started",
                    started.elapsed()
                ));
            }
        }
        let mut actual = Map::new();
        let mut file = None;
        match outcome {
            Ok(result) => {
                let mut result = json!(result);
                if let Some(path) = result["details"]["fullOutputPath"].as_str() {
                    if let Ok(bytes) = fs::read(path) {
                        file = Some(String::from_utf8_lossy(&bytes).into_owned());
                        let _ = fs::remove_file(path);
                    }
                }
                if result["structuredContent"].is_object() {
                    result["structuredContent"]["wall_time_seconds"] = json!(0);
                }
                actual.insert("result".into(), result);
            }
            Err(error) => {
                actual.insert("error".into(), json!(error));
            }
        }
        let updates = updates.into_inner().unwrap();
        actual.insert(
            "firstUpdate".into(),
            updates.first().cloned().unwrap_or(Value::Null),
        );
        actual.insert(
            "lastUpdate".into(),
            updates.last().cloned().unwrap_or(Value::Null),
        );
        actual.insert("file".into(), json!(file));
        let actual = portable(Value::Object(actual), Some(&root));
        for field in ["result", "error", "firstUpdate", "lastUpdate", "file"] {
            let expected = call.get(field).cloned().unwrap_or(Value::Null);
            let actual = actual.get(field).cloned().unwrap_or(Value::Null);
            differences(
                &format!("{name}: {field}"),
                &expected,
                &actual,
                &mut failures,
            );
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// PowerShell exists only on Windows, so the recorder cannot run it everywhere; this checks that
/// the tool runs it and reads its UTF-8 output.
#[cfg(windows)]
#[tokio::test]
async fn powershell_runs_commands_on_windows() {
    let tree = Tree::new();
    let tool = ShellTool::powershell(tree.root(), ShellToolOptions::default());
    let signal = relay_ai::abort::AbortSignal::never();
    let result = tool
        .execute(
            "call",
            json!({"command": "Write-Output 'héllo'; exit 4"}),
            &signal,
            &|_| {},
        )
        .await
        .unwrap();
    assert_eq!(
        json!(result.content)[0]["text"],
        json!("héllo\r\n\n\nCommand exited with code 4")
    );
}
