//! Session file entries (`session-manager.ts`): reading the JSONL file, migrating versions 1 and
//! 2, and projecting the path to a leaf into model context.
//!
//! Entries stay JSON values, as the TypeScript manager keeps parsed objects: unknown fields and
//! key order survive a rewrite, and a field that is absent stays absent.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};

use serde_json::{json, Map, Value};

use crate::date::parse_date;
use crate::ids::generate_id;
use relay_ai::json::stringify;

pub const CURRENT_SESSION_VERSION: u64 = 3;
/// How far the header search reads before giving up (`MAX_SESSION_HEADER_SCAN_BYTES`).
pub const MAX_SESSION_HEADER_SCAN_BYTES: u64 = 1024 * 1024;

/// A field of an entry, if the entry is an object and has it.
pub fn field<'a>(entry: &'a Value, name: &str) -> Option<&'a Value> {
    entry.as_object()?.get(name)
}

/// A string field.
pub fn text<'a>(entry: &'a Value, name: &str) -> Option<&'a str> {
    field(entry, name)?.as_str()
}

/// An entry's `type`.
pub fn entry_type(entry: &Value) -> Option<&str> {
    text(entry, "type")
}

pub fn is_header(entry: &Value) -> bool {
    entry_type(entry) == Some("session")
}

/// An entry's `id`.
pub fn entry_id(entry: &Value) -> Option<&str> {
    text(entry, "id")
}

/// The role of a message entry's message.
pub fn message_role(entry: &Value) -> Option<&str> {
    text(field(entry, "message")?, "role")
}

/// JavaScript truthiness.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `new Date(timestamp).getTime()` as JSON: a number, or `null` for an invalid date.
pub fn time_value(timestamp: Option<&Value>) -> Value {
    timestamp
        .and_then(Value::as_str)
        .and_then(parse_date)
        .map_or(Value::Null, Value::from)
}

/// A line's entry, or `None` for a blank or malformed line (`parseSessionEntryLine`).
pub fn parse_line(line: &str) -> Option<Value> {
    if line
        .trim_matches(relay_ai::text::is_js_whitespace)
        .is_empty()
    {
        return None;
    }
    serde_json::from_str(line).ok()
}

/// Every parseable line of `content` (`parseSessionEntries`).
pub fn parse_session_entries(content: &str) -> Vec<Value> {
    content
        .trim_matches(relay_ai::text::is_js_whitespace)
        .split('\n')
        .filter_map(parse_line)
        .collect()
}

/// A session file's entries (`loadEntriesFromFile`): none when the file is missing or its first
/// entry is not a session header. A last line without a newline gets one, so later appends start
/// on their own line.
pub fn load_entries_from_file(path: &str) -> Result<Vec<Value>, String> {
    let mut bytes = Vec::new();
    match File::open(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(relay_tools::js::fs_error(&error, "open", path)),
        Ok(mut file) => file
            .read_to_end(&mut bytes)
            .map_err(|error| relay_tools::js::fs_error(&error, "read", path))?,
    };
    let content = String::from_utf8_lossy(&bytes);
    let mut entries = Vec::new();
    let mut pending = "";
    let mut rest = content.as_ref();
    while let Some(newline) = rest.find('\n') {
        if let Some(entry) = parse_line(&rest[..newline]) {
            entries.push(entry);
        }
        rest = &rest[newline + 1..];
    }
    if !rest.is_empty() {
        pending = rest;
        if let Some(entry) = parse_line(rest) {
            entries.push(entry);
        }
    }
    let Some(first) = entries.first() else {
        return Ok(entries);
    };
    if !is_header(first) || !field(first, "id").is_some_and(Value::is_string) {
        return Ok(Vec::new());
    }
    if !pending.is_empty() {
        OpenOptions::new()
            .append(true)
            .open(path)
            .and_then(|mut file| file.write_all(b"\n"))
            .map_err(|error| relay_tools::js::fs_error(&error, "open", path))?;
    }
    Ok(entries)
}

/// Why the header search stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderError {
    /// The header is not within the first megabyte.
    ScanLimit(String),
    Io(String),
}

/// A header among a line's candidates: `None` keeps searching (blank or malformed), `Some(None)`
/// is a parsed entry that is not a header.
fn header_candidate(line: &str) -> Option<Option<Value>> {
    let entry = parse_line(line)?;
    if !is_header(&entry) || !field(&entry, "id").is_some_and(Value::is_string) {
        return Some(None);
    }
    Some(Some(entry))
}

/// The session header, from the first parsed line within the scan limit (`readSessionHeader`).
pub fn read_session_header(path: &str) -> Result<Option<Value>, HeaderError> {
    let mut file = File::open(path)
        .map_err(|error| HeaderError::Io(relay_tools::js::fs_error(&error, "open", path)))?;
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut scanned = 0usize;
    let limit = MAX_SESSION_HEADER_SCAN_BYTES as usize;
    let mut line_start = 0;
    loop {
        if scanned >= limit {
            // A header ending exactly at the limit is allowed; another byte is too far.
            let mut probe = [0u8; 1];
            let read = file.read(&mut probe).map_err(|error| {
                HeaderError::Io(relay_tools::js::fs_error(&error, "read", path))
            })?;
            if read == 0 {
                let line = String::from_utf8_lossy(&bytes[line_start..]);
                return Ok(header_candidate(&line).flatten());
            }
            return Err(HeaderError::ScanLimit(format!(
                "Session header exceeds {MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: {path}"
            )));
        }
        let wanted = buffer.len().min(limit - scanned);
        let read = file
            .read(&mut buffer[..wanted])
            .map_err(|error| HeaderError::Io(relay_tools::js::fs_error(&error, "read", path)))?;
        if read == 0 {
            let line = String::from_utf8_lossy(&bytes[line_start..]);
            return Ok(header_candidate(&line).flatten());
        }
        scanned += read;
        bytes.extend_from_slice(&buffer[..read]);
        while let Some(offset) = bytes[line_start..].iter().position(|byte| *byte == b'\n') {
            let line = String::from_utf8_lossy(&bytes[line_start..line_start + offset]);
            if let Some(candidate) = header_candidate(&line) {
                return Ok(candidate);
            }
            line_start += offset + 1;
        }
    }
}

/// Discovery is best effort: unreadable or oversized files are not sessions.
pub fn read_session_header_for_discovery(path: &str) -> Option<Value> {
    read_session_header(path).ok().flatten()
}

/// The header's `cwd`, if it is a string.
pub fn header_cwd(header: &Value) -> Option<&str> {
    text(header, "cwd")
}

/// Version 1 to 2: ids and parent ids in file order, and compactions' kept index to an id.
fn migrate_v1_to_v2(entries: &mut [Value]) {
    let mut ids: HashSet<String> = HashSet::new();
    let mut previous: Option<String> = None;
    for index in 0..entries.len() {
        if is_header(&entries[index]) {
            if let Some(object) = entries[index].as_object_mut() {
                object.insert("version".into(), json!(2));
            }
            continue;
        }
        let id = generate_id(|candidate| ids.contains(candidate));
        ids.insert(id.clone());
        let kept_index = field(&entries[index], "firstKeptEntryIndex").cloned();
        let is_compaction = entry_type(&entries[index]) == Some("compaction");
        let kept_id = match (&kept_index, is_compaction) {
            (Some(Value::Number(number)), true) => number
                .as_f64()
                .filter(|index| index.fract() == 0.0 && *index >= 0.0)
                .and_then(|kept| entries.get(kept as usize))
                .filter(|target| !is_header(target))
                .and_then(|target| target.get("id").cloned()),
            _ => None,
        };
        let Some(object) = entries[index].as_object_mut() else {
            continue;
        };
        object.insert("id".into(), Value::String(id.clone()));
        object.insert(
            "parentId".into(),
            previous.clone().map_or(Value::Null, Value::String),
        );
        if is_compaction && matches!(kept_index, Some(Value::Number(_))) {
            if let Some(kept_id) = kept_id {
                object.insert("firstKeptEntryId".into(), kept_id);
            }
            object.shift_remove("firstKeptEntryIndex");
        }
        previous = Some(id);
    }
}

/// Version 2 to 3: the `hookMessage` role became `custom`.
fn migrate_v2_to_v3(entries: &mut [Value]) {
    for entry in entries.iter_mut() {
        if is_header(entry) {
            if let Some(object) = entry.as_object_mut() {
                object.insert("version".into(), json!(3));
            }
            continue;
        }
        if entry_type(entry) == Some("message") && message_role(entry) == Some("hookMessage") {
            if let Some(message) = entry.get_mut("message").and_then(Value::as_object_mut) {
                message.insert("role".into(), json!("custom"));
            }
        }
    }
}

/// Brings entries to the current version; whether anything changed (`migrateToCurrentVersion`).
pub fn migrate_to_current_version(entries: &mut [Value]) -> bool {
    let version = entries
        .iter()
        .find(|entry| is_header(entry))
        .and_then(|header| field(header, "version"))
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    if version >= CURRENT_SESSION_VERSION as f64 {
        return false;
    }
    if version < 2.0 {
        migrate_v1_to_v2(entries);
    }
    if version < 3.0 {
        migrate_v2_to_v3(entries);
    }
    true
}

/// Entries by id; a repeated id keeps the last entry, as a `Map` does.
pub fn entry_index(entries: &[Value]) -> HashMap<&str, &Value> {
    entries
        .iter()
        .filter_map(|entry| Some((entry_id(entry)?, entry)))
        .collect()
}

/// Which entry a path ends at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Leaf<'a> {
    /// The last entry (`leafId` undefined, or an id that is not found).
    Last,
    /// Before any entry: an empty path.
    Root,
    Id(&'a str),
}

/// The path from the root to the leaf (`buildSessionPath`). An entry that is its own ancestor
/// ends the walk; the TypeScript walk would loop until its array overflows.
pub fn session_path<'a>(entries: &'a [Value], leaf: Leaf<'_>) -> Vec<&'a Value> {
    let index = entry_index(entries);
    let leaf_entry = match leaf {
        Leaf::Root => return Vec::new(),
        Leaf::Id(id) => index.get(id).copied().or_else(|| entries.last()),
        Leaf::Last => entries.last(),
    };
    let mut path = Vec::new();
    let mut seen: HashSet<*const Value> = HashSet::new();
    let mut current = leaf_entry;
    while let Some(entry) = current {
        if !seen.insert(entry as *const Value) {
            break;
        }
        path.push(entry);
        current = text(entry, "parentId")
            .filter(|parent| !parent.is_empty())
            .and_then(|parent| index.get(parent).copied());
    }
    path.reverse();
    path
}

/// The thinking level and model along a path (`getSessionContextSettings`). `None` stands for a
/// field the entry lacks, which JSON leaves out.
pub fn context_settings(path: &[&Value]) -> (Option<Value>, Option<Map<String, Value>>) {
    let mut thinking_level = Some(json!("off"));
    let mut model: Option<Map<String, Value>> = None;
    let pair = |provider: Option<&Value>, model_id: Option<&Value>| {
        let mut object = Map::new();
        if let Some(provider) = provider {
            object.insert("provider".into(), provider.clone());
        }
        if let Some(model_id) = model_id {
            object.insert("modelId".into(), model_id.clone());
        }
        object
    };
    for entry in path {
        match entry_type(entry) {
            Some("thinking_level_change") => {
                thinking_level = field(entry, "thinkingLevel").cloned()
            }
            Some("model_change") => {
                model = Some(pair(field(entry, "provider"), field(entry, "modelId")));
            }
            Some("message") if message_role(entry) == Some("assistant") => {
                let message = field(entry, "message");
                model = Some(pair(
                    message.and_then(|message| field(message, "provider")),
                    message.and_then(|message| field(message, "model")),
                ));
            }
            _ => {}
        }
    }
    (thinking_level, model)
}

/// `{ ...object, name: value }`: an existing key keeps its place, a new one goes last.
fn with_field(object: &Value, name: &str, value: Value) -> Value {
    let mut copy = object.as_object().cloned().unwrap_or_default();
    copy.insert(name.into(), value);
    Value::Object(copy)
}

/// An object of the fields that are present, in order.
fn object(fields: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(name, value)| Some((name.to_string(), value?)))
            .collect(),
    )
}

/// The context messages of one entry (`sessionEntryToContextMessages`): plain custom entries and
/// state entries give none.
pub fn entry_context_messages(entry: &Value) -> Vec<Value> {
    match entry_type(entry) {
        Some("message") => {
            let Some(message) = field(entry, "message") else {
                return Vec::new();
            };
            // Files are read without validation, so content can be null or missing.
            let content_missing = matches!(field(message, "content"), None | Some(Value::Null));
            match text(message, "role") {
                Some("system") if content_missing => {
                    vec![with_field(message, "content", json!(""))]
                }
                Some("user" | "assistant" | "toolResult") if content_missing => {
                    vec![with_field(message, "content", json!([]))]
                }
                _ => vec![message.clone()],
            }
        }
        Some("custom_message") => {
            let content = match field(entry, "content") {
                None | Some(Value::Null) => json!([]),
                Some(content) => content.clone(),
            };
            vec![object(vec![
                ("role", Some(json!("custom"))),
                ("customType", field(entry, "customType").cloned()),
                ("content", Some(content)),
                ("display", field(entry, "display").cloned()),
                ("details", field(entry, "details").cloned()),
                ("timestamp", Some(time_value(field(entry, "timestamp")))),
            ])]
        }
        Some("branch_summary") if truthy(field(entry, "summary")) => vec![object(vec![
            ("role", Some(json!("branchSummary"))),
            ("summary", field(entry, "summary").cloned()),
            ("fromId", field(entry, "fromId").cloned()),
            ("timestamp", Some(time_value(field(entry, "timestamp")))),
        ])],
        Some("compaction") => {
            let summary = object(vec![
                ("role", Some(json!("compactionSummary"))),
                ("summary", field(entry, "summary").cloned()),
                ("tokensBefore", field(entry, "tokensBefore").cloned()),
                ("timestamp", Some(time_value(field(entry, "timestamp")))),
            ]);
            match field(entry, "systemMessage") {
                Some(system) if truthy(Some(system)) => vec![system.clone(), summary],
                _ => vec![summary],
            }
        }
        _ => Vec::new(),
    }
}

/// The path with the latest compaction standing for what it summarized (`buildContextEntries`):
/// the compaction, the kept entries from `firstKeptEntryId` on (without system messages, which
/// the compaction's own system message replaces), then everything after it.
pub fn context_entries<'a>(entries: &'a [Value], leaf: Leaf<'_>) -> Vec<&'a Value> {
    let path = session_path(entries, leaf);
    let Some(compaction_index) = path
        .iter()
        .rposition(|entry| entry_type(entry) == Some("compaction"))
    else {
        return path;
    };
    let compaction = path[compaction_index];
    // `findIndex` by id: an earlier entry with the same id comes first.
    let compaction_index = path
        .iter()
        .position(|entry| field(entry, "id") == field(compaction, "id"))
        .unwrap_or(compaction_index);
    let first_kept = field(compaction, "firstKeptEntryId");
    let mut result = vec![compaction];
    let mut found_first_kept = false;
    for entry in &path[..compaction_index] {
        if field(entry, "id") == first_kept {
            found_first_kept = true;
        }
        let is_system =
            entry_type(entry) == Some("message") && message_role(entry) == Some("system");
        if found_first_kept && !is_system {
            result.push(entry);
        }
    }
    result.extend_from_slice(&path[compaction_index + 1..]);
    result
}

/// One entry's messages with its latest context edit applied (`projectContextEntry`).
fn project_entry(entry: &Value, edit: Option<&Value>) -> Vec<Value> {
    let messages = entry_context_messages(entry);
    let Some(edit) = edit else {
        return messages;
    };
    let replacement = field(edit, "replacement");
    if matches!(replacement, Some(Value::Null)) {
        return Vec::new();
    }
    let replacement_content = replacement.and_then(|replacement| field(replacement, "content"));
    messages
        .into_iter()
        .map(|message| {
            let role = text(&message, "role").unwrap_or_default().to_string();
            if !matches!(
                role.as_str(),
                "user" | "assistant" | "toolResult" | "custom"
            ) {
                return message;
            }
            let content = match replacement_content {
                Some(Value::String(text)) if role == "assistant" || role == "toolResult" => {
                    json!([{"type": "text", "text": text}])
                }
                Some(content) => content.clone(),
                // `{ ...message, content: undefined }` drops it from JSON.
                None => {
                    let mut copy = message.as_object().cloned().unwrap_or_default();
                    copy.shift_remove("content");
                    return Value::Object(copy);
                }
            };
            with_field(&message, "content", content)
        })
        .collect()
}

/// One context entry and the messages it contributes after edits (`ProjectedSessionEntry`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedEntry {
    pub source: Value,
    /// Empty for state entries, omitted entries and older compactions.
    pub messages: Vec<Value>,
}

/// The context of a path: which entry each message came from, the messages, the thinking level
/// and the model (`SessionProjection`).
#[derive(Debug, Clone, PartialEq)]
pub struct Projection {
    pub entries: Vec<ProjectedEntry>,
    pub messages: Vec<Value>,
    pub thinking_level: Option<Value>,
    pub model: Option<Map<String, Value>>,
}

/// Compaction-aware context with each message's source entry (`buildSessionProjection`).
pub fn session_projection(entries: &[Value], leaf: Leaf<'_>) -> Projection {
    let path = session_path(entries, leaf);
    let (thinking_level, model) = context_settings(&path);
    let context = context_entries(entries, leaf);
    let mut edits: HashMap<&str, &Value> = HashMap::new();
    for entry in &context {
        if entry_type(entry) == Some("context_edit") {
            if let Some(target) = text(entry, "targetId") {
                edits.insert(target, entry);
            }
        }
    }
    let projected: Vec<ProjectedEntry> = context
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            // An older compaction kept inside the newest one's range contributes nothing.
            let messages = if entry_type(entry) == Some("compaction") && index > 0 {
                Vec::new()
            } else {
                let edit = entry_id(entry).and_then(|id| edits.get(id).copied());
                project_entry(entry, edit)
            };
            ProjectedEntry {
                source: (*entry).clone(),
                messages,
            }
        })
        .collect();
    Projection {
        messages: projected
            .iter()
            .flat_map(|entry| entry.messages.iter().cloned())
            .collect(),
        entries: projected,
        thinking_level,
        model,
    }
}

/// The text of a user or assistant message for listings (`extractTextContent`): a string, or
/// its text blocks joined by spaces.
pub fn message_text(message: &Value) -> String {
    match field(message, "content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| text(block, "type") == Some("text"))
            .map(|block| match field(block, "text") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
                None => "undefined".to_string(),
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// Writes entries as JSON lines, replacing the file.
pub fn write_entries(path: &str, entries: &[Value], create_new: bool) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    let mut file = options
        .open(path)
        .map_err(|error| relay_tools::js::fs_error(&error, "open", path))?;
    let mut text = String::new();
    for entry in entries {
        text.push_str(&stringify(entry));
        text.push('\n');
    }
    file.write_all(text.as_bytes())
        .map_err(|error| relay_tools::js::fs_error(&error, "write", path))
}

/// Appends one entry's line.
pub fn append_entry(path: &str, entry: &Value) -> Result<(), String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(format!("{}\n", stringify(entry)).as_bytes()))
        .map_err(|error| relay_tools::js::fs_error(&error, "open", path))
}

/// Whether a file exists (`existsSync`).
pub fn exists(path: &str) -> bool {
    fs::metadata(path).is_ok()
}
