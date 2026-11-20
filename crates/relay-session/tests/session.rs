//! Replays `crates/fixtures/session/`, what the TypeScript session manager did
//! (`packages/coding-agent/test/parity/session-record.ts`): dates, handcrafted files, scripted
//! calls and listings. Outputs are normalized as the recorder normalizes them and compared as
//! serialized JSON, so key order counts.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use relay_session::date::{iso_string, now_ms, parse_date};
use relay_session::entries::{session_projection, Leaf};
use relay_session::manager::find_most_recent_session;
use relay_session::{NewSessionOptions, SessionInfo, SessionManager, TreeNode};
use serde_json::{json, Map, Value};

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/session")
        .join(name);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn differences(label: &str, expected: &Value, actual: &Value, failures: &mut Vec<String>) {
    let expected = expected.to_string();
    let actual = actual.to_string();
    if expected != actual {
        let show = |text: &str| {
            if text.len() > 900 {
                format!("{}...", &text[..text.floor_char_boundary(900)])
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

/// A fresh temporary directory, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "relay-session-{}-{nanos}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }

    fn join(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// The recorder's `Normalizer`.
struct Normalizer {
    root: String,
    cwd: String,
    fixed_ids: HashSet<String>,
    window: Option<(i64, i64)>,
    entry_ids: HashMap<String, String>,
    session_ids: HashMap<String, String>,
}

impl Normalizer {
    fn new(root: &str, fixed_ids: HashSet<String>, window: Option<(i64, i64)>) -> Self {
        Normalizer {
            root: root.to_string(),
            cwd: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            fixed_ids,
            window,
            entry_ids: HashMap::new(),
            session_ids: HashMap::new(),
        }
    }

    fn is_time(&self, value: f64) -> bool {
        self.window
            .is_some_and(|(start, end)| value >= start as f64 && value <= end as f64)
    }

    fn entry_placeholder(&mut self, id: &str) -> String {
        let next = self.entry_ids.len() + 1;
        self.entry_ids
            .entry(id.to_string())
            .or_insert_with(|| format!("#{next}"))
            .clone()
    }

    fn text(&mut self, value: &str, key: Option<&str>) -> String {
        let time_key = matches!(key, Some("timestamp" | "labelTimestamp"));
        if self.window.is_some() && time_key && value.len() >= 11 {
            let bytes = value.as_bytes();
            let shape = bytes[..4].iter().all(u8::is_ascii_digit)
                && bytes[4] == b'-'
                && bytes[5..7].iter().all(u8::is_ascii_digit)
                && bytes[7] == b'-'
                && bytes[8..10].iter().all(u8::is_ascii_digit)
                && bytes[10] == b'T';
            if shape && parse_date(value).is_some_and(|time| self.is_time(time as f64)) {
                return "<time>".into();
            }
        }
        if value.len() == 8 && value.bytes().all(is_lower_hex) && !self.fixed_ids.contains(value) {
            return self.entry_placeholder(value);
        }
        let mut text = value
            .replace(&self.root, "<root>")
            .replace(&self.cwd, "<cwd>");
        // `/` after `<root>` and `<cwd>`, up to a quote, space, `]` or `"`.
        let mut out = String::new();
        let mut rest = text.as_str();
        while let Some(index) = rest.find('<') {
            let tail = &rest[index..];
            let tag = ["<root>", "<cwd>"]
                .into_iter()
                .find(|tag| tail.starts_with(tag));
            out.push_str(&rest[..index]);
            match tag {
                Some(tag) => {
                    let end = tail
                        .find(|character: char| {
                            matches!(character, '\'' | ']' | '"') || character.is_whitespace()
                        })
                        .unwrap_or(tail.len());
                    let end = end.max(tag.len());
                    out.push_str(&tail[..end].replace('\\', "/"));
                    rest = &tail[end..];
                }
                None => {
                    out.push('<');
                    rest = &tail[1..];
                }
            }
        }
        out.push_str(rest);
        text = out;
        text = replace_stamps(&text);
        text = self.replace_uuids(&text);
        self.replace_embedded_ids(&text)
    }

    fn replace_uuids(&mut self, text: &str) -> String {
        let bytes = text.as_bytes();
        let mut out = String::new();
        let mut at = 0;
        let mut copied = 0;
        while at + 36 <= bytes.len() {
            let candidate = &bytes[at..at + 36];
            let dash = |index: usize| candidate[index] == b'-';
            let hex = |range: std::ops::Range<usize>| {
                candidate[range].iter().all(|byte| is_lower_hex(*byte))
            };
            let matches = hex(0..8)
                && dash(8)
                && hex(9..13)
                && dash(13)
                && candidate[14] == b'7'
                && hex(15..18)
                && dash(18)
                && matches!(candidate[19], b'8' | b'9' | b'a' | b'b')
                && hex(20..23)
                && dash(23)
                && hex(24..36);
            if matches {
                let id = &text[at..at + 36];
                let next = self.session_ids.len() + 1;
                let placeholder = self
                    .session_ids
                    .entry(id.to_string())
                    .or_insert_with(|| format!("<session-{next}>"))
                    .clone();
                out.push_str(&text[copied..at]);
                out.push_str(&placeholder);
                at += 36;
                copied = at;
            } else {
                at += 1;
            }
        }
        out.push_str(&text[copied..]);
        out
    }

    /// `\b[0-9a-f]{8}\b`: a word of exactly eight lowercase hexadecimal digits.
    fn replace_embedded_ids(&mut self, text: &str) -> String {
        let bytes = text.as_bytes();
        let mut out = String::new();
        let mut copied = 0;
        let mut at = 0;
        while at < bytes.len() {
            if !is_word(bytes[at]) {
                at += 1;
                continue;
            }
            let start = at;
            while at < bytes.len() && is_word(bytes[at]) {
                at += 1;
            }
            let word = &text[start..at];
            if word.len() == 8 && word.bytes().all(is_lower_hex) && !self.fixed_ids.contains(word) {
                let placeholder = self.entry_placeholder(word);
                out.push_str(&text[copied..start]);
                out.push_str(&placeholder);
                copied = at;
            }
        }
        out.push_str(&text[copied..]);
        out
    }

    fn walk(&mut self, value: &Value, key: Option<&str>) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(text, key)),
            Value::Number(number) => {
                let time_key = matches!(key, Some("timestamp" | "labelTimestamp"));
                if time_key && number.as_f64().is_some_and(|time| self.is_time(time)) {
                    json!(0)
                } else {
                    value.clone()
                }
            }
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.walk(item, None)).collect())
            }
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(name, item)| (name.clone(), self.walk(item, Some(name))))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
}

/// `\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_` becomes `<stamp>_`.
fn replace_stamps(text: &str) -> String {
    const SHAPE: &[u8] = b"dddd-dd-ddTdd-dd-dd-dddZ_";
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut copied = 0;
    let mut at = 0;
    while at + SHAPE.len() <= bytes.len() {
        let fits = SHAPE
            .iter()
            .zip(&bytes[at..])
            .all(|(shape, byte)| match shape {
                b'd' => byte.is_ascii_digit(),
                other => other == byte,
            });
        if fits {
            out.push_str(&text[copied..at]);
            out.push_str("<stamp>_");
            at += SHAPE.len();
            copied = at;
        } else {
            at += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

fn tree_json(nodes: &[TreeNode]) -> Value {
    Value::Array(
        nodes
            .iter()
            .map(|node| {
                let mut object = Map::new();
                object.insert(
                    "id".into(),
                    node.entry.get("id").cloned().unwrap_or(Value::Null),
                );
                if let Some(label) = &node.label {
                    object.insert("label".into(), json!(label));
                }
                if let Some(timestamp) = &node.label_timestamp {
                    object.insert("labelTimestamp".into(), json!(timestamp));
                }
                object.insert("children".into(), tree_json(&node.children));
                Value::Object(object)
            })
            .collect(),
    )
}

fn context_json(
    messages: Vec<Value>,
    thinking_level: Option<Value>,
    model: Option<Map<String, Value>>,
) -> Map<String, Value> {
    let mut object = Map::new();
    object.insert("messages".into(), Value::Array(messages));
    if let Some(level) = thinking_level {
        object.insert("thinkingLevel".into(), level);
    }
    object.insert("model".into(), model.map_or(Value::Null, Value::Object));
    object
}

fn file_lines(path: Option<&str>) -> Value {
    let Some(path) = path.filter(|path| Path::new(path).exists()) else {
        return json!("<absent>");
    };
    let text = String::from_utf8_lossy(&fs::read(path).unwrap()).into_owned();
    let lines: Vec<Value> = text
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                return json!("");
            }
            serde_json::from_str(line).unwrap_or_else(|_| json!({"unparsed": line}))
        })
        .collect();
    json!({"lines": lines})
}

fn state(manager: &SessionManager) -> Map<String, Value> {
    let mut object = Map::new();
    object.insert(
        "header".into(),
        manager.header().cloned().unwrap_or(Value::Null),
    );
    object.insert(
        "leafId".into(),
        manager.leaf_id().map_or(Value::Null, |id| json!(id)),
    );
    object.insert(
        "sessionName".into(),
        manager.session_name().map_or(Value::Null, Value::String),
    );
    object.insert("entries".into(), Value::Array(manager.entries()));
    object.insert("tree".into(), tree_json(&manager.tree()));
    let context = manager.build_session_context();
    object.insert(
        "context".into(),
        Value::Object(context_json(
            context.messages,
            context.thinking_level,
            context.model,
        )),
    );
    object
}

fn projection_json(entries: &[Value], leaf: Leaf<'_>, label: Value) -> Value {
    let projection = session_projection(entries, leaf);
    let mut object = Map::new();
    object.insert("leafId".into(), label);
    object.insert(
        "entryIds".into(),
        Value::Array(
            projection
                .entries
                .iter()
                .map(|(id, _)| id.clone())
                .collect(),
        ),
    );
    object.extend(context_json(
        projection.messages,
        projection.thinking_level,
        projection.model,
    ));
    Value::Object(object)
}

/// `bytes` with every `from` replaced by `to`.
fn replace_bytes(bytes: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at..].starts_with(from) {
            out.extend_from_slice(to);
            at += from.len();
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    out
}

#[test]
fn dates_parse_as_javascript_parses_them() {
    let mut failures = Vec::new();
    for case in fixture("dates.json").as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let actual = parse_date(text).map_or(Value::Null, Value::from);
        differences(
            &format!("date {text:?}"),
            &case["time"],
            &actual,
            &mut failures,
        );
        if let Some(time) = parse_date(text) {
            assert_eq!(parse_date(&iso_string(time)), Some(time), "{text}");
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn files_open_as_the_typescript_manager_opens_them() {
    let mut failures = Vec::new();
    for case in fixture("files.json").as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let root = TempDir::new();
        let path = root.join("case.jsonl");
        let escaped_root = serde_json::to_string(&root.path()).unwrap();
        let escaped_root = &escaped_root[1..escaped_root.len() - 1];
        let bytes = match case.get("base64").and_then(Value::as_str) {
            Some(encoded) => base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
            None => case["text"]
                .as_str()
                .unwrap_or_default()
                .as_bytes()
                .to_vec(),
        };
        fs::write(
            &path,
            replace_bytes(&bytes, b"<root>", escaped_root.as_bytes()),
        )
        .unwrap();
        let fixed_ids: HashSet<String> = case["text"]
            .as_str()
            .unwrap_or_default()
            .split('\n')
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|value| value.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        let started = now_ms();
        // The recorder walks the case's own fields first; their placeholders come first.
        let mut outcome = Map::new();
        for field in ["name", "text", "base64"] {
            if let Some(value) = case.get(field) {
                outcome.insert(field.into(), value.clone());
            }
        }
        match SessionManager::open(&path, Some(&root.join("sessions")), None) {
            Ok(manager) => {
                outcome.extend(state(&manager));
                outcome.insert("cwd".into(), json!(manager.cwd()));
                outcome.insert("sessionId".into(), json!(manager.session_id()));
                outcome.insert("file".into(), file_lines(Some(&path)));
                let entries = manager.entries();
                let mut projections = vec![
                    projection_json(&entries, Leaf::Last, json!("<default>")),
                    projection_json(&entries, Leaf::Root, Value::Null),
                ];
                for entry in &entries {
                    let id = entry["id"].as_str().unwrap();
                    projections.push(projection_json(&entries, Leaf::Id(id), json!(id)));
                }
                outcome.insert("projections".into(), Value::Array(projections));
            }
            Err(error) => {
                outcome.insert("error".into(), json!(error));
                outcome.insert("file".into(), file_lines(Some(&path)));
            }
        }
        let mut normalizer = Normalizer::new(
            &root.path(),
            fixed_ids,
            Some((started - 1000, now_ms() + 1000)),
        );
        let actual = normalizer.walk(&Value::Object(outcome), None);
        for (field, expected) in case.as_object().unwrap() {
            if matches!(field.as_str(), "name" | "text" | "base64") {
                continue;
            }
            differences(
                &format!("{name}: {field}"),
                expected,
                &actual[field.as_str()],
                &mut failures,
            );
        }
        let expected_fields: Vec<&String> = case.as_object().unwrap().keys().collect();
        for field in actual.as_object().unwrap().keys() {
            if !expected_fields.contains(&field) {
                failures.push(format!("{name}: unexpected field {field}"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The result of call N for a `$N` argument.
fn argument(value: &Value, results: &[Value]) -> Value {
    match value.as_str() {
        Some(text) if text.starts_with('$') && text[1..].parse::<usize>().is_ok() => {
            results[text[1..].parse::<usize>().unwrap()].clone()
        }
        _ => value.clone(),
    }
}

fn optional(value: &Value) -> Option<Value> {
    (!value.is_null()).then(|| value.clone())
}

fn run_operation(
    manager: &mut SessionManager,
    operation: &Value,
    results: &[Value],
) -> Result<Value, String> {
    let get = |name: &str| operation.get(name).cloned().unwrap_or(Value::Null);
    let text = |name: &str| {
        operation
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let arg = |name: &str| argument(&get(name), results);
    let arg_text = |name: &str| arg(name).as_str().map(str::to_string);
    match operation["op"].as_str().unwrap() {
        "message" => manager.append_message(get("message")).map(Value::String),
        "thinking" => manager
            .append_thinking_level_change(&text("level").unwrap())
            .map(Value::String),
        "model" => manager
            .append_model_change(&text("provider").unwrap(), &text("modelId").unwrap())
            .map(Value::String),
        "usage" => manager
            .append_usage(
                &text("kind").unwrap(),
                &text("provider").unwrap(),
                &text("model").unwrap(),
                get("usage"),
                text("note").as_deref(),
            )
            .map(|entry| entry["id"].clone()),
        "compaction" => manager
            .append_compaction(
                &text("summary").unwrap(),
                arg_text("firstKept").as_deref(),
                get("tokensBefore").as_f64().unwrap(),
                optional(&get("details")),
                get("fromHook").as_bool(),
                optional(&get("usage")),
            )
            .map(Value::String),
        "custom" => manager
            .append_custom_entry(&text("customType").unwrap(), optional(&get("data")))
            .map(Value::String),
        "info" => manager
            .append_session_info(&text("name").unwrap())
            .map(Value::String),
        "name" => Ok(manager.session_name().map_or(Value::Null, Value::String)),
        "customMessage" => manager
            .append_custom_message_entry(
                &text("customType").unwrap(),
                get("content"),
                get("display").as_bool().unwrap(),
                optional(&get("details")),
            )
            .map(Value::String),
        "contextEdit" => manager
            .append_context_edit(&arg_text("target").unwrap_or_default(), get("replacement"))
            .map(Value::String),
        "label" => manager
            .append_label_change(
                &arg_text("target").unwrap_or_default(),
                text("label").as_deref(),
            )
            .map(Value::String),
        "getLabel" => Ok(manager
            .label(&arg_text("target").unwrap_or_default())
            .map_or(Value::Null, |label| json!(label))),
        "branch" => manager
            .branch(&arg_text("target").unwrap_or_default())
            .map(|()| Value::Null),
        "resetLeaf" => {
            manager.reset_leaf();
            Ok(Value::Null)
        }
        "branchWithSummary" => manager
            .branch_with_summary(
                arg_text("target").as_deref(),
                &text("summary").unwrap(),
                optional(&get("details")),
                get("fromHook").as_bool(),
                None,
            )
            .map(Value::String),
        "createBranchedSession" => manager
            .create_branched_session(&arg_text("target").unwrap_or_default())
            .map(|file| file.map_or(Value::Null, Value::String)),
        "newSession" => {
            let options = (operation.get("id").is_some()
                || operation.get("parentSession").is_some())
            .then(|| NewSessionOptions {
                id: text("id"),
                parent_session: text("parentSession"),
            });
            manager
                .new_session(options)
                .map(|file| file.map_or(Value::Null, Value::String))
        }
        "children" => Ok(Value::Array(
            manager
                .children(&arg_text("target").unwrap_or_default())
                .iter()
                .map(|child| child["id"].clone())
                .collect(),
        )),
        "getBranch" => Ok(Value::Array(
            manager
                .branch_path(arg_text("target").as_deref())
                .iter()
                .map(|entry| entry["id"].clone())
                .collect(),
        )),
        "file" => Ok(file_lines(manager.session_file())),
        other => panic!("unknown operation {other}"),
    }
}

#[test]
fn calls_change_sessions_as_the_typescript_manager_does() {
    let mut failures = Vec::new();
    for case in fixture("operations.json").as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let root = TempDir::new();
        let started = now_ms();
        let cwd = root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let mut manager = if case["persist"] == true {
            SessionManager::create(&cwd, Some(&root.join("sessions")), None).unwrap()
        } else {
            SessionManager::in_memory(Some(&cwd), None, None).unwrap()
        };
        let mut outcomes = Vec::new();
        let mut results: Vec<Value> = Vec::new();
        for operation in case["operations"].as_array().unwrap() {
            match run_operation(&mut manager, operation, &results) {
                Ok(value) => {
                    outcomes.push(json!({"result": value}));
                    results.push(value);
                }
                Err(error) => {
                    outcomes.push(json!({"error": error}));
                    results.push(Value::Null);
                }
            }
        }
        let mut recorded = Map::new();
        recorded.insert("outcomes".into(), Value::Array(outcomes));
        recorded.extend(state(&manager));
        recorded.insert(
            "sessionFile".into(),
            manager
                .session_file()
                .map_or(Value::Null, |file| json!(file)),
        );
        recorded.insert("file".into(), file_lines(manager.session_file()));
        let mut normalizer = Normalizer::new(
            &root.path(),
            HashSet::new(),
            Some((started - 1000, now_ms() + 1000)),
        );
        // The recorder walks the case's own fields first; their placeholders come first.
        let mut whole = Map::new();
        for field in ["name", "persist", "operations"] {
            whole.insert(field.into(), case[field].clone());
        }
        whole.extend(recorded);
        let actual = normalizer.walk(&Value::Object(whole), None);
        for (field, expected) in case.as_object().unwrap() {
            differences(
                &format!("{name}: {field}"),
                expected,
                &actual[field.as_str()],
                &mut failures,
            );
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn info_json(info: &SessionInfo) -> Value {
    let date = |time: f64| {
        if time.is_nan() {
            Value::Null
        } else {
            json!(iso_string(time as i64))
        }
    };
    let mut object = Map::new();
    object.insert("path".into(), json!(info.path));
    if let Some(id) = &info.id {
        object.insert("id".into(), id.clone());
    }
    object.insert("cwd".into(), json!(info.cwd));
    if let Some(name) = &info.name {
        object.insert("name".into(), json!(name));
    }
    if let Some(parent) = &info.parent_session_path {
        object.insert("parentSessionPath".into(), parent.clone());
    }
    object.insert("created".into(), date(info.created));
    object.insert("modified".into(), date(info.modified));
    object.insert("messageCount".into(), json!(info.message_count));
    object.insert("firstMessage".into(), json!(info.first_message));
    object.insert("allMessagesText".into(), json!(info.all_messages_text));
    Value::Object(object)
}

#[test]
fn listings_find_sessions_as_the_typescript_manager_does() {
    let recorded = fixture("listing.json");
    let root = TempDir::new();
    let started = now_ms();
    let cwd = root.join("project");
    let other = root.join("other");
    let dir = root.join("sessions");
    for path in [&cwd, &other, &dir] {
        fs::create_dir_all(path).unwrap();
    }
    // `<root>` inside JSON text: the directory as JSON escapes it.
    let escaped_root = serde_json::to_string(&root.path()).unwrap();
    let escaped_root = escaped_root[1..escaped_root.len() - 1].to_string();
    let with_root = |text: &str| text.replace("<root>", &escaped_root);
    let mut fixed_ids = HashSet::new();
    for file in recorded["files"].as_array().unwrap() {
        let path = Path::new(&dir).join(file["name"].as_str().unwrap());
        let content = match file.get("raw").and_then(Value::as_str) {
            Some(raw) => raw.to_string(),
            None => file["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| {
                    if let Some(id) = entry.get("id").and_then(Value::as_str) {
                        fixed_ids.insert(id.to_string());
                    }
                    with_root(&entry.to_string()) + "\n"
                })
                .collect(),
        };
        fs::write(&path, content).unwrap();
        let mtime = UNIX_EPOCH + Duration::from_secs(file["mtime"].as_u64().unwrap());
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
    }
    let path_value = |path: Option<String>| path.map_or(Value::Null, Value::String);
    let mut actual = Map::new();
    actual.insert("files".into(), recorded["files"].clone());
    actual.insert(
        "list".into(),
        Value::Array(
            relay_session::list::list(&cwd, Some(&dir))
                .iter()
                .map(info_json)
                .collect(),
        ),
    );
    actual.insert(
        "mostRecent".into(),
        path_value(find_most_recent_session(&dir, None)),
    );
    actual.insert(
        "mostRecentForCwd".into(),
        path_value(find_most_recent_session(&dir, Some(&cwd))),
    );
    actual.insert(
        "mostRecentMissingDir".into(),
        path_value(find_most_recent_session(&root.join("missing"), None)),
    );
    actual.insert(
        "findById".into(),
        path_value(SessionManager::find_by_id(&cwd, "s-c", Some(&dir))),
    );
    actual.insert(
        "findOtherCwd".into(),
        path_value(SessionManager::find_by_id(&cwd, "s-b", Some(&dir))),
    );
    actual.insert(
        "findMissing".into(),
        path_value(SessionManager::find_by_id(&cwd, "nothing", Some(&dir))),
    );
    actual.insert(
        "continueRecent".into(),
        path_value(
            SessionManager::continue_recent(&cwd, Some(&dir))
                .unwrap()
                .session_file()
                .map(str::to_string),
        ),
    );
    let a = Path::new(&dir)
        .join("a.jsonl")
        .to_string_lossy()
        .into_owned();
    let b = Path::new(&dir)
        .join("b.jsonl")
        .to_string_lossy()
        .into_owned();
    actual.insert(
        "openWithCwd".into(),
        json!(SessionManager::open(&a, None, Some(&other)).unwrap().cwd()),
    );
    actual.insert(
        "openReadsCwd".into(),
        json!(SessionManager::open(&b, None, None).unwrap().cwd()),
    );
    let forked = SessionManager::fork_from(&a, &other, Some(&root.join("forks")), None).unwrap();
    actual.insert(
        "fork".into(),
        json!({
            "sessionFile": forked.session_file(),
            "file": file_lines(forked.session_file()),
            "entries": forked.entries(),
        }),
    );
    let d = Path::new(&dir)
        .join("d.jsonl")
        .to_string_lossy()
        .into_owned();
    actual.insert(
        "forkEmpty".into(),
        match SessionManager::fork_from(&d, &other, Some(&root.join("forks")), None) {
            Ok(_) => Value::Null,
            Err(error) => json!(error),
        },
    );
    let mut normalizer = Normalizer::new(
        &root.path(),
        fixed_ids,
        Some((started - 1000, now_ms() + 1000)),
    );
    let actual = normalizer.walk(&Value::Object(actual), None);
    let mut failures = Vec::new();
    for (field, expected) in recorded.as_object().unwrap() {
        differences(field, expected, &actual[field.as_str()], &mut failures);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn rewritten_files_hold_compact_lines() {
    let root = TempDir::new();
    let cwd = root.join("project");
    let mut manager = SessionManager::create(&cwd, Some(&root.join("sessions")), None).unwrap();
    manager
        .append_message(json!({"role": "user", "content": "hi", "timestamp": 1}))
        .unwrap();
    manager
        .append_usage(
            "probe",
            "p",
            "m",
            json!({"cost": {"total": 0.0000012}}),
            None,
        )
        .unwrap();
    let text = fs::read_to_string(manager.session_file().unwrap()).unwrap();
    assert!(text.contains(r#""cost":{"total":0.0000012}"#), "{text}");
    for line in text.lines() {
        let value: Value = serde_json::from_str(line).unwrap();
        assert_eq!(relay_session::json::stringify(&value), line);
    }
}
