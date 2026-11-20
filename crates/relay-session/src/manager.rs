//! `SessionManager`: a conversation as an append-only tree of entries in a JSONL file.
//!
//! Each entry names its parent; the leaf is the current position, and appending adds a child of
//! the leaf. Branching moves the leaf to an earlier entry. A new session's file is written only
//! once it holds a user or assistant message, so setup entries alone leave no file behind.

use std::collections::{HashMap, HashSet};
use std::fs;

use serde_json::{json, Map, Value};

use crate::date::{now_iso, parse_date};
use crate::entries::{
    append_entry, entry_id, entry_type, exists, field, header_cwd, is_header,
    load_entries_from_file, message_role, migrate_to_current_version, read_session_header,
    session_projection, text, truthy, write_entries, HeaderError, Leaf, Projection,
    CURRENT_SESSION_VERSION,
};
use crate::ids::{assert_valid_session_id, generate_id, uuidv7};
use crate::paths;

const APP_NAME: &str = "relay";

/// Options for a new session (`NewSessionOptions`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewSessionOptions {
    pub id: Option<String>,
    pub parent_session: Option<String>,
}

/// A node of `get_tree` (`SessionTreeNode`).
#[derive(Debug, Clone, PartialEq)]
pub struct TreeNode {
    pub entry: Value,
    pub children: Vec<TreeNode>,
    pub label: Option<String>,
    pub label_timestamp: Option<String>,
}

/// The context sent to the model (`SessionContext`).
#[derive(Debug, Clone, PartialEq)]
pub struct SessionContext {
    pub messages: Vec<Value>,
    /// `None` when the latest thinking level entry has no level.
    pub thinking_level: Option<Value>,
    pub model: Option<Map<String, Value>>,
}

/// Entries' labels in a JavaScript `Map`'s order: a relabeled entry keeps its place, a cleared
/// one loses it.
#[derive(Debug, Clone, Default)]
struct Labels {
    order: Vec<String>,
    labels: HashMap<String, (String, String)>,
}

impl Labels {
    fn set(&mut self, target: &str, label: &str, timestamp: &str) {
        if !self.labels.contains_key(target) {
            self.order.push(target.to_string());
        }
        self.labels.insert(
            target.to_string(),
            (label.to_string(), timestamp.to_string()),
        );
    }

    fn delete(&mut self, target: &str) {
        if self.labels.remove(target).is_some() {
            self.order.retain(|existing| existing != target);
        }
    }

    fn get(&self, target: &str) -> Option<&(String, String)> {
        self.labels.get(target)
    }

    fn clear(&mut self) {
        self.order.clear();
        self.labels.clear();
    }

    fn iter(&self) -> impl Iterator<Item = (&str, &str, &str)> {
        self.order.iter().map(|target| {
            let (label, timestamp) = &self.labels[target];
            (target.as_str(), label.as_str(), timestamp.as_str())
        })
    }
}

/// What `get_tree` builds nodes from.
struct Tree<'a> {
    entries: &'a [Value],
    ids: &'a [Option<String>],
    children: &'a [Vec<usize>],
    labels: &'a Labels,
}

impl Tree<'_> {
    fn time(&self, index: usize) -> f64 {
        text(&self.entries[index], "timestamp")
            .and_then(parse_date)
            .map_or(f64::NAN, |time| time as f64)
    }

    /// A node with its children oldest first; equal or invalid times keep their order.
    fn node(&self, index: usize) -> TreeNode {
        let mut children = self.children[index].clone();
        children.sort_by(|a, b| {
            (self.time(*a) - self.time(*b))
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let label = self
            .labels
            .get(self.ids[index].as_deref().unwrap_or_default());
        TreeNode {
            entry: self.entries[index].clone(),
            children: children.into_iter().map(|child| self.node(child)).collect(),
            label: label.map(|(label, _)| label.clone()),
            label_timestamp: label.map(|(_, timestamp)| timestamp.clone()),
        }
    }
}

/// A conversation session (`SessionManager`).
#[derive(Debug, Clone)]
pub struct SessionManager {
    session_id: String,
    session_file: Option<String>,
    session_dir: String,
    cwd: String,
    persist: bool,
    flushed: bool,
    file_entries: Vec<Value>,
    /// Entry ids in first-insertion order, each to its latest entry's index, as a `Map` holds them.
    by_id: HashMap<String, usize>,
    id_order: Vec<String>,
    labels: Labels,
    leaf_id: Option<String>,
}

/// `new Date(timestamp).getTime()` for an ISO string, as a JSON number or null.
fn time_of(timestamp: &str) -> Value {
    parse_date(timestamp).map_or(Value::Null, Value::from)
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

/// `getCurrentSystemMessage` on context messages: every system message replayed into one, later
/// content appended, sections patched by name, the current tools.
pub fn current_system_message(messages: &[Value]) -> Option<Value> {
    let mut content: Vec<String> = Vec::new();
    let mut sections: Vec<(String, Value)> = Vec::new();
    let mut timestamp: Option<Value> = None;
    let mut tools: Vec<(String, Value)> = Vec::new();
    for message in messages {
        if text(message, "role") != Some("system") {
            continue;
        }
        if timestamp.as_ref().is_none_or(Value::is_null) {
            timestamp = field(message, "timestamp").cloned();
        }
        let message_text = match field(message, "content") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter(|block| text(block, "type") == Some("text"))
                .map(|block| text(block, "text").unwrap_or_default().to_string())
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        if !message_text.is_empty() {
            content.push(message_text);
        }
        if let Some(Value::Object(patch)) = field(message, "sections") {
            for (name, value) in patch {
                if value.is_null() {
                    sections.retain(|(existing, _)| existing != name);
                } else if let Some(section) =
                    sections.iter_mut().find(|(existing, _)| existing == name)
                {
                    section.1 = value.clone();
                } else {
                    sections.push((name.clone(), value.clone()));
                }
            }
        }
        for removed in field(message, "toolsRemoved")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(name) = text(removed, "name") {
                tools.retain(|(existing, _)| existing != name);
            }
        }
        for added in field(message, "toolsAdded")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let name = text(added, "name").unwrap_or_default().to_string();
            match tools.iter_mut().find(|(existing, _)| *existing == name) {
                Some(tool) => tool.1 = added.clone(),
                None => tools.push((name, added.clone())),
            }
        }
    }
    // Only an absent time means no system message; a null one becomes 0.
    if timestamp.is_none() && tools.is_empty() {
        return None;
    }
    Some(object(vec![
        ("role", Some(json!("system"))),
        ("content", Some(Value::String(content.join("\n\n")))),
        (
            "sections",
            (!sections.is_empty()).then(|| Value::Object(sections.into_iter().collect())),
        ),
        (
            "toolsAdded",
            (!tools.is_empty())
                .then(|| Value::Array(tools.into_iter().map(|(_, tool)| tool).collect())),
        ),
        (
            "timestamp",
            Some(
                timestamp
                    .filter(|value| !value.is_null())
                    .unwrap_or(json!(0)),
            ),
        ),
    ]))
}

/// The session directory a working directory gets under the agent directory: the resolved path
/// with its separators and colons as dashes (`getDefaultSessionDirPath`).
pub fn default_session_dir_path(cwd: &str, agent_dir: &str) -> String {
    let resolved_cwd = paths::resolve(cwd);
    let resolved_agent_dir = paths::resolve(agent_dir);
    let trimmed = resolved_cwd
        .strip_prefix(['/', '\\'])
        .unwrap_or(&resolved_cwd);
    let safe: String = trimmed
        .chars()
        .map(|character| {
            if matches!(character, '/' | '\\' | ':') {
                '-'
            } else {
                character
            }
        })
        .collect();
    let sessions = paths::join(&resolved_agent_dir, "sessions");
    paths::join(&sessions, &format!("--{safe}--"))
}

/// The agent directory (`getAgentDir`).
pub fn agent_dir() -> String {
    relay_tools::tools_manager::agent_dir().unwrap_or_default()
}

/// The default session directory for a working directory, created if missing
/// (`getDefaultSessionDir`).
pub fn default_session_dir(cwd: &str, agent_dir: &str) -> Result<String, String> {
    let dir = default_session_dir_path(cwd, agent_dir);
    if !exists(&dir) {
        fs::create_dir_all(&dir)
            .map_err(|error| relay_tools::js::fs_error(&error, "mkdir", &dir))?;
    }
    Ok(dir)
}

/// The sessions directory every project's sessions are under (`getSessionsDir`).
pub fn sessions_dir() -> String {
    paths::join(&agent_dir(), "sessions")
}

/// Whether a header's working directory resolves to `resolved_cwd` (`sessionCwdMatches`).
pub fn session_cwd_matches(cwd: Option<&str>, resolved_cwd: &str) -> bool {
    cwd.is_some_and(|cwd| !cwd.is_empty() && paths::resolve(cwd) == resolved_cwd)
}

/// The newest session file in a directory by modification time, optionally only one started in
/// `cwd` (`findMostRecentSession`).
pub fn find_most_recent_session(session_dir: &str, cwd: Option<&str>) -> Option<String> {
    let dir = paths::normalize(session_dir);
    let resolved_cwd = cwd.map(paths::resolve);
    let mut files: Vec<(String, std::time::SystemTime)> = Vec::new();
    for entry in fs::read_dir(&dir).ok()? {
        let name = entry.ok()?.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".jsonl") {
            continue;
        }
        let path = paths::join(&dir, &name);
        let modified = fs::metadata(&path).ok()?.modified().ok()?;
        files.push((path, modified));
    }
    files.sort_by_key(|file| std::cmp::Reverse(file.1));
    files.into_iter().map(|(path, _)| path).find(|path| {
        crate::entries::read_session_header_for_discovery(path).is_some_and(|header| {
            resolved_cwd
                .as_deref()
                .is_none_or(|cwd| session_cwd_matches(header_cwd(&header), cwd))
        })
    })
}

impl SessionManager {
    fn construct(
        cwd: &str,
        session_dir: &str,
        session_file: Option<&str>,
        persist: bool,
        options: Option<NewSessionOptions>,
        preloaded: Option<Vec<Value>>,
    ) -> Result<Self, String> {
        let mut manager = SessionManager {
            session_id: String::new(),
            session_file: None,
            session_dir: paths::normalize(session_dir),
            cwd: paths::resolve(cwd),
            persist,
            flushed: false,
            file_entries: Vec::new(),
            by_id: HashMap::new(),
            id_order: Vec::new(),
            labels: Labels::default(),
            leaf_id: None,
        };
        if persist && !manager.session_dir.is_empty() && !exists(&manager.session_dir) {
            fs::create_dir_all(&manager.session_dir).map_err(|error| {
                relay_tools::js::fs_error(&error, "mkdir", &manager.session_dir)
            })?;
        }
        match (session_file, preloaded) {
            (Some(file), preloaded) => manager.set_session_file_with(file, preloaded)?,
            (None, Some(entries)) if !entries.is_empty() => {
                manager.load_entries(entries, options)?
            }
            _ => {
                manager.new_session(options)?;
            }
        }
        Ok(manager)
    }

    /// Switches to another session file, for resuming and branching (`setSessionFile`).
    pub fn set_session_file(&mut self, session_file: &str) -> Result<(), String> {
        self.set_session_file_with(session_file, None)
    }

    fn set_session_file_with(
        &mut self,
        session_file: &str,
        preloaded: Option<Vec<Value>>,
    ) -> Result<(), String> {
        let path = paths::resolve(session_file);
        self.session_file = Some(path.clone());
        if !exists(&path) {
            self.new_session(None)?;
            // An explicit path, as from `--session`, stays.
            self.session_file = Some(path);
            return Ok(());
        }
        let entries = match preloaded {
            Some(entries) => entries,
            None => load_entries_from_file(&path)?,
        };
        if entries.is_empty() {
            // An empty file gets a header; one that does not parse as a session stays untouched.
            let size = fs::metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            if size > 0 {
                return Err(format!(
                    "Session file is not a valid {APP_NAME} session: {path}"
                ));
            }
            self.new_session(None)?;
            self.session_file = Some(path);
            self.rewrite_file()?;
            self.flushed = true;
            return Ok(());
        }
        self.load_entries(entries, None)?;
        self.flushed = true;
        Ok(())
    }

    /// Starts a new session; its file path when it persists (`newSession`).
    pub fn new_session(
        &mut self,
        options: Option<NewSessionOptions>,
    ) -> Result<Option<String>, String> {
        let options = options.unwrap_or_default();
        if let Some(id) = &options.id {
            assert_valid_session_id(id)?;
        }
        self.session_id = options.id.clone().unwrap_or_else(uuidv7);
        let timestamp = now_iso();
        let header = object(vec![
            ("type", Some(json!("session"))),
            ("version", Some(json!(CURRENT_SESSION_VERSION))),
            ("id", Some(json!(self.session_id))),
            ("timestamp", Some(json!(timestamp))),
            ("cwd", Some(json!(self.cwd))),
            ("parentSession", options.parent_session.map(Value::String)),
        ]);
        self.file_entries = vec![header];
        self.by_id.clear();
        self.id_order.clear();
        self.labels.clear();
        self.leaf_id = None;
        self.flushed = false;
        if self.persist {
            let file_timestamp = timestamp.replace([':', '.'], "-");
            self.session_file = Some(paths::join(
                &self.session_dir,
                &format!("{file_timestamp}_{}.jsonl", self.session_id),
            ));
        }
        Ok(self.session_file.clone())
    }

    fn load_entries(
        &mut self,
        entries: Vec<Value>,
        options: Option<NewSessionOptions>,
    ) -> Result<(), String> {
        match entries.iter().find(|entry| is_header(entry)).cloned() {
            Some(header) => {
                self.file_entries = entries;
                self.session_id = text(&header, "id").unwrap_or_default().to_string();
                if migrate_to_current_version(&mut self.file_entries) {
                    self.rewrite_file()?;
                }
            }
            None => {
                self.new_session(options)?;
                self.file_entries.extend(entries);
            }
        }
        self.build_index();
        Ok(())
    }

    fn index_entry(&mut self, index: usize) {
        let Some(id) = entry_id(&self.file_entries[index]).map(str::to_string) else {
            return;
        };
        if self.by_id.insert(id.clone(), index).is_none() {
            self.id_order.push(id.clone());
        }
        self.leaf_id = Some(id);
    }

    fn build_index(&mut self) {
        self.by_id.clear();
        self.id_order.clear();
        self.labels.clear();
        self.leaf_id = None;
        for index in 0..self.file_entries.len() {
            let entry = &self.file_entries[index];
            if is_header(entry) {
                continue;
            }
            if entry_type(entry) == Some("label") {
                let target = text(entry, "targetId").unwrap_or_default().to_string();
                if truthy(field(entry, "label")) {
                    let label = text(entry, "label").unwrap_or_default().to_string();
                    let timestamp = text(entry, "timestamp").unwrap_or_default().to_string();
                    self.labels.set(&target, &label, &timestamp);
                } else {
                    self.labels.delete(&target);
                }
            }
            self.index_entry(index);
        }
    }

    fn rewrite_file(&self) -> Result<(), String> {
        match (&self.session_file, self.persist) {
            (Some(file), true) => write_entries(file, &self.file_entries, false),
            _ => Ok(()),
        }
    }

    pub fn is_persisted(&self) -> bool {
        self.persist
    }

    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    pub fn session_dir(&self) -> &str {
        &self.session_dir
    }

    /// Whether the session directory is the working directory's default (`usesDefaultSessionDir`).
    pub fn uses_default_session_dir(&self) -> bool {
        self.session_dir == default_session_dir_path(&self.cwd, &agent_dir())
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn session_file(&self) -> Option<&str> {
        self.session_file.as_deref()
    }

    /// Whether a user or assistant message is in the session (`_hasConversation`).
    fn has_conversation(&self) -> bool {
        self.file_entries.iter().any(|entry| {
            entry_type(entry) == Some("message")
                && matches!(message_role(entry), Some("user" | "assistant"))
        })
    }

    /// Writes an appended entry: the whole file once the session has a conversation, then one
    /// line at a time (`_persist`).
    fn persist_entry(&mut self, entry: &Value) -> Result<(), String> {
        let (Some(file), true) = (self.session_file.clone(), self.persist) else {
            return Ok(());
        };
        if self.flushed {
            return append_entry(&file, entry);
        }
        if !self.has_conversation() {
            return Ok(());
        }
        write_entries(&file, &self.file_entries, true)?;
        self.flushed = true;
        Ok(())
    }

    fn append_entry(&mut self, entry: Value) -> Result<(), String> {
        self.file_entries.push(entry.clone());
        self.index_entry(self.file_entries.len() - 1);
        self.persist_entry(&entry)
    }

    fn new_id(&self) -> String {
        generate_id(|candidate| self.by_id.contains_key(candidate))
    }

    fn parent(&self) -> Value {
        self.leaf_id.clone().map_or(Value::Null, Value::String)
    }

    /// An entry's common fields, then its own.
    fn entry(&self, kind: &str, fields: Vec<(&str, Option<Value>)>) -> (String, Value) {
        let id = self.new_id();
        let mut all = vec![
            ("type", Some(json!(kind))),
            ("id", Some(json!(id))),
            ("parentId", Some(self.parent())),
            ("timestamp", Some(json!(now_iso()))),
        ];
        all.extend(fields);
        (id, object(all))
    }

    fn append(&mut self, kind: &str, fields: Vec<(&str, Option<Value>)>) -> Result<String, String> {
        let (id, entry) = self.entry(kind, fields);
        self.append_entry(entry)?;
        Ok(id)
    }

    /// Appends a message as a child of the leaf (`appendMessage`). Compaction and branch
    /// summaries have their own entries.
    pub fn append_message(&mut self, message: Value) -> Result<String, String> {
        self.append("message", vec![("message", Some(message))])
    }

    pub fn append_thinking_level_change(&mut self, thinking_level: &str) -> Result<String, String> {
        self.append(
            "thinking_level_change",
            vec![("thinkingLevel", Some(json!(thinking_level)))],
        )
    }

    pub fn append_model_change(
        &mut self,
        provider: &str,
        model_id: &str,
    ) -> Result<String, String> {
        self.append(
            "model_change",
            vec![
                ("provider", Some(json!(provider))),
                ("modelId", Some(json!(model_id))),
            ],
        )
    }

    /// Appends model usage outside the model's context; the entry (`appendUsage`).
    pub fn append_usage(
        &mut self,
        kind: &str,
        provider: &str,
        model: &str,
        usage: Value,
        note: Option<&str>,
    ) -> Result<Value, String> {
        let (_, entry) = self.entry(
            "usage",
            vec![
                ("kind", Some(json!(kind))),
                ("provider", Some(json!(provider))),
                ("model", Some(json!(model))),
                ("usage", Some(usage)),
                (
                    "note",
                    note.filter(|note| !note.is_empty()).map(|note| json!(note)),
                ),
            ],
        );
        self.append_entry(entry.clone())?;
        Ok(entry)
    }

    /// Appends a compaction summary, with the system message in force (`appendCompaction`).
    /// Without `first_kept_entry_id` the compaction keeps itself.
    pub fn append_compaction(
        &mut self,
        summary: &str,
        first_kept_entry_id: Option<&str>,
        tokens_before: f64,
        details: Option<Value>,
        from_hook: Option<bool>,
        usage: Option<Value>,
    ) -> Result<String, String> {
        let timestamp = now_iso();
        let system = current_system_message(&self.build_session_projection().messages);
        let id = self.new_id();
        let system = system.map(|system| {
            let mut system = system.as_object().cloned().unwrap_or_default();
            system.insert("timestamp".into(), time_of(&timestamp));
            Value::Object(system)
        });
        let entry = object(vec![
            ("type", Some(json!("compaction"))),
            ("id", Some(json!(id))),
            ("parentId", Some(self.parent())),
            ("timestamp", Some(json!(timestamp))),
            ("summary", Some(json!(summary))),
            (
                "firstKeptEntryId",
                Some(json!(first_kept_entry_id.unwrap_or(&id))),
            ),
            (
                "tokensBefore",
                Some(relay_ai::json::js_number(tokens_before)),
            ),
            ("details", details),
            ("usage", usage),
            ("fromHook", from_hook.map(Value::Bool)),
            ("systemMessage", system),
        ]);
        self.append_entry(entry)?;
        Ok(id)
    }

    /// Appends extension state outside the model's context (`appendCustomEntry`).
    pub fn append_custom_entry(
        &mut self,
        custom_type: &str,
        data: Option<Value>,
    ) -> Result<String, String> {
        let id = self.new_id();
        let entry = object(vec![
            ("type", Some(json!("custom"))),
            ("customType", Some(json!(custom_type))),
            ("data", data),
            ("id", Some(json!(id))),
            ("parentId", Some(self.parent())),
            ("timestamp", Some(json!(now_iso()))),
        ]);
        self.append_entry(entry)?;
        Ok(id)
    }

    /// Appends the session's display name, on one line (`appendSessionInfo`).
    pub fn append_session_info(&mut self, name: &str) -> Result<String, String> {
        let mut one_line = String::new();
        let mut in_break = false;
        for character in name.chars() {
            if character == '\r' || character == '\n' {
                if !in_break {
                    one_line.push(' ');
                }
                in_break = true;
            } else {
                one_line.push(character);
                in_break = false;
            }
        }
        let name = relay_ai::text::js_trim(&one_line).to_string();
        self.append("session_info", vec![("name", Some(json!(name)))])
    }

    /// The latest session name; an empty one clears it (`getSessionName`).
    pub fn session_name(&self) -> Option<String> {
        let entry = self
            .file_entries
            .iter()
            .rev()
            .find(|entry| entry_type(entry) == Some("session_info"))?;
        let name = relay_ai::text::js_trim(text(entry, "name")?);
        (!name.is_empty()).then(|| name.to_string())
    }

    /// Appends a message from an extension that is part of the model's context
    /// (`appendCustomMessageEntry`).
    pub fn append_custom_message_entry(
        &mut self,
        custom_type: &str,
        content: Value,
        display: bool,
        details: Option<Value>,
    ) -> Result<String, String> {
        let id = self.new_id();
        let entry = object(vec![
            ("type", Some(json!("custom_message"))),
            ("customType", Some(json!(custom_type))),
            ("content", Some(content)),
            ("display", Some(json!(display))),
            ("details", details),
            ("id", Some(json!(id))),
            ("parentId", Some(self.parent())),
            ("timestamp", Some(json!(now_iso()))),
        ]);
        self.append_entry(entry)?;
        Ok(id)
    }

    /// Appends an edit of an earlier entry's model content on the active branch
    /// (`appendContextEdit`): `null` omits it, `{ content }` replaces its content.
    pub fn append_context_edit(
        &mut self,
        target_id: &str,
        replacement: Value,
    ) -> Result<String, String> {
        let valid = match &replacement {
            Value::Null => true,
            Value::Object(object) => matches!(
                object.get("content"),
                Some(Value::String(_) | Value::Array(_))
            ),
            _ => false,
        };
        if !valid {
            return Err(
                "Context edit replacement must be null or contain string/array content".into(),
            );
        }
        let Some(&target_index) = self.by_id.get(target_id) else {
            return Err(format!("Entry {target_id} not found"));
        };
        if !self.branch_ids(None).iter().any(|id| id == target_id) {
            return Err(format!("Entry {target_id} is not on the active branch"));
        }
        let target = &self.file_entries[target_index];
        let editable = entry_type(target) == Some("custom_message")
            || (entry_type(target) == Some("message")
                && matches!(
                    message_role(target),
                    Some("user" | "assistant" | "toolResult")
                ));
        if !editable {
            return Err(format!(
                "Entry {target_id} does not contribute editable model content"
            ));
        }
        let role = if entry_type(target) == Some("message") {
            message_role(target).unwrap_or_default()
        } else {
            "custom"
        };
        let replacement = match replacement.get("content") {
            Some(Value::String(content)) if role == "assistant" || role == "toolResult" => {
                json!({"content": [{"type": "text", "text": content}]})
            }
            _ => replacement,
        };
        self.append(
            "context_edit",
            vec![
                ("targetId", Some(json!(target_id))),
                ("replacement", Some(replacement)),
            ],
        )
    }

    pub fn leaf_id(&self) -> Option<&str> {
        self.leaf_id.as_deref()
    }

    pub fn leaf_entry(&self) -> Option<&Value> {
        self.entry_by_id(self.leaf_id.as_deref()?)
    }

    pub fn entry_by_id(&self, id: &str) -> Option<&Value> {
        self.by_id.get(id).map(|index| &self.file_entries[*index])
    }

    /// An entry's direct children, in the order their ids were first seen (`getChildren`).
    pub fn children(&self, parent_id: &str) -> Vec<&Value> {
        self.id_order
            .iter()
            .map(|id| &self.file_entries[self.by_id[id]])
            .filter(|entry| text(entry, "parentId") == Some(parent_id))
            .collect()
    }

    pub fn label(&self, id: &str) -> Option<&str> {
        self.labels.get(id).map(|(label, _)| label.as_str())
    }

    /// Sets or, with `None` or an empty label, clears an entry's label (`appendLabelChange`).
    pub fn append_label_change(
        &mut self,
        target_id: &str,
        label: Option<&str>,
    ) -> Result<String, String> {
        if !self.by_id.contains_key(target_id) {
            return Err(format!("Entry {target_id} not found"));
        }
        let (id, entry) = self.entry(
            "label",
            vec![
                ("targetId", Some(json!(target_id))),
                ("label", label.map(|label| json!(label))),
            ],
        );
        let timestamp = text(&entry, "timestamp").unwrap_or_default().to_string();
        self.append_entry(entry)?;
        match label.filter(|label| !label.is_empty()) {
            Some(label) => self.labels.set(target_id, label, &timestamp),
            None => self.labels.delete(target_id),
        }
        Ok(id)
    }

    /// The ids from the root to `from` (default: the leaf).
    fn branch_ids(&self, from: Option<&str>) -> Vec<String> {
        self.branch_path(from)
            .into_iter()
            .filter_map(|entry| entry_id(entry).map(str::to_string))
            .collect()
    }

    /// The entries from the root to `from`, or to the leaf (`getBranch`). An entry that is its
    /// own ancestor ends the walk.
    pub fn branch_path(&self, from: Option<&str>) -> Vec<&Value> {
        let start = from.or(self.leaf_id.as_deref());
        let mut path = Vec::new();
        let mut seen = HashSet::new();
        let mut current = start.and_then(|id| self.entry_by_id(id));
        while let Some(entry) = current {
            if !seen.insert(entry as *const Value) {
                break;
            }
            path.push(entry);
            current = text(entry, "parentId")
                .filter(|parent| !parent.is_empty())
                .and_then(|parent| self.entry_by_id(parent));
        }
        path.reverse();
        path
    }

    fn leaf(&self) -> Leaf<'_> {
        match &self.leaf_id {
            Some(id) => Leaf::Id(id),
            None => Leaf::Root,
        }
    }

    /// The compaction-aware entries of the leaf's path (`buildContextEntries`).
    pub fn build_context_entries(&self) -> Vec<Value> {
        let entries = self.entries();
        crate::entries::context_entries(&entries, self.leaf())
            .into_iter()
            .cloned()
            .collect()
    }

    /// The model context with each message's source (`buildSessionProjection`).
    pub fn build_session_projection(&self) -> Projection {
        session_projection(&self.entries(), self.leaf())
    }

    /// What is sent to the model (`buildSessionContext`).
    pub fn build_session_context(&self) -> SessionContext {
        let projection = self.build_session_projection();
        SessionContext {
            messages: projection.messages,
            thinking_level: projection.thinking_level,
            model: projection.model,
        }
    }

    pub fn header(&self) -> Option<&Value> {
        self.file_entries.iter().find(|entry| is_header(entry))
    }

    pub fn entry_count(&self) -> usize {
        self.by_id.len()
    }

    /// Every entry but the header (`getEntries`).
    pub fn entries(&self) -> Vec<Value> {
        self.file_entries
            .iter()
            .filter(|entry| !is_header(entry))
            .cloned()
            .collect()
    }

    /// The entries as a tree, children oldest first (`getTree`). An entry whose parent is missing
    /// or itself is a root.
    pub fn tree(&self) -> Vec<TreeNode> {
        let entries = self.entries();
        let ids: Vec<Option<String>> = entries
            .iter()
            .map(|entry| entry_id(entry).map(str::to_string))
            .collect();
        let mut node_of: HashMap<String, usize> = HashMap::new();
        for (index, id) in ids.iter().enumerate() {
            if let Some(id) = id {
                node_of.insert(id.clone(), index);
            }
        }
        let mut children: Vec<Vec<usize>> = vec![Vec::new(); entries.len()];
        let mut roots = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            // Each id's node is the last entry with it, as the node map keeps it.
            let node = ids[index]
                .as_ref()
                .and_then(|id| node_of.get(id))
                .copied()
                .unwrap_or(index);
            let parent = field(entry, "parentId");
            let is_root = matches!(parent, Some(Value::Null))
                || (parent.is_some() && parent == field(entry, "id"));
            match parent
                .and_then(Value::as_str)
                .and_then(|parent| node_of.get(parent))
            {
                Some(&parent) if !is_root => children[parent].push(node),
                _ => roots.push(node),
            }
        }
        let tree = Tree {
            entries: &entries,
            ids: &ids,
            children: &children,
            labels: &self.labels,
        };
        roots.into_iter().map(|root| tree.node(root)).collect()
    }

    /// Moves the leaf to an earlier entry, so the next append starts a branch (`branch`).
    pub fn branch(&mut self, branch_from_id: &str) -> Result<(), String> {
        if !self.by_id.contains_key(branch_from_id) {
            return Err(format!("Entry {branch_from_id} not found"));
        }
        self.leaf_id = Some(branch_from_id.to_string());
        Ok(())
    }

    /// Moves the leaf before every entry: the next append is a new root (`resetLeaf`).
    pub fn reset_leaf(&mut self) {
        self.leaf_id = None;
    }

    /// Branches with a summary of the path left behind (`branchWithSummary`).
    pub fn branch_with_summary(
        &mut self,
        branch_from_id: Option<&str>,
        summary: &str,
        details: Option<Value>,
        from_hook: Option<bool>,
        usage: Option<Value>,
    ) -> Result<String, String> {
        if let Some(id) = branch_from_id {
            if !self.by_id.contains_key(id) {
                return Err(format!("Entry {id} not found"));
            }
        }
        let from_id = self.leaf_id.clone().unwrap_or_else(|| "root".to_string());
        self.leaf_id = branch_from_id.map(str::to_string);
        let id = self.new_id();
        let entry = object(vec![
            ("type", Some(json!("branch_summary"))),
            ("id", Some(json!(id))),
            (
                "parentId",
                Some(branch_from_id.map_or(Value::Null, |id| json!(id))),
            ),
            ("timestamp", Some(json!(now_iso()))),
            ("fromId", Some(json!(from_id))),
            ("summary", Some(json!(summary))),
            ("details", details),
            ("usage", usage),
            ("fromHook", from_hook.map(Value::Bool)),
        ]);
        self.append_entry(entry)?;
        Ok(id)
    }

    /// Replaces the session with a new one holding only the path to `leaf_id`, labels re-added at
    /// its end (`createBranchedSession`). The new file's path when the session persists.
    pub fn create_branched_session(&mut self, leaf_id: &str) -> Result<Option<String>, String> {
        let previous_file = self.session_file.clone();
        let path: Vec<Value> = self
            .branch_path(Some(leaf_id))
            .into_iter()
            .cloned()
            .collect();
        if path.is_empty() {
            return Err(format!("Entry {leaf_id} not found"));
        }
        // Labels are entries too, and later entries can be their children: dropping them means
        // re-chaining the path.
        let mut kept: Vec<Value> = Vec::new();
        let mut replacement_of_label: HashMap<String, String> = HashMap::new();
        let mut pending_labels: Vec<String> = Vec::new();
        let mut parent_id = Value::Null;
        for entry in &path {
            if entry_type(entry) == Some("label") {
                pending_labels.push(entry_id(entry).unwrap_or_default().to_string());
                continue;
            }
            let id = entry_id(entry).unwrap_or_default().to_string();
            for label in pending_labels.drain(..) {
                replacement_of_label.insert(label, id.clone());
            }
            let mut copy = entry.as_object().cloned().unwrap_or_default();
            copy.insert("parentId".into(), parent_id.clone());
            if entry_type(entry) == Some("compaction") {
                let first_kept = text(entry, "firstKeptEntryId")
                    .unwrap_or_default()
                    .to_string();
                let first_kept = if first_kept == id {
                    id.clone()
                } else {
                    replacement_of_label
                        .get(&first_kept)
                        .cloned()
                        .unwrap_or(first_kept)
                };
                if field(entry, "firstKeptEntryId").is_some() || !first_kept.is_empty() {
                    copy.insert("firstKeptEntryId".into(), json!(first_kept));
                }
            }
            kept.push(Value::Object(copy));
            parent_id = json!(id);
        }

        let new_session_id = uuidv7();
        let timestamp = now_iso();
        let file_timestamp = timestamp.replace([':', '.'], "-");
        let new_file = paths::join(
            &self.session_dir,
            &format!("{file_timestamp}_{new_session_id}.jsonl"),
        );
        let header = object(vec![
            ("type", Some(json!("session"))),
            ("version", Some(json!(CURRENT_SESSION_VERSION))),
            ("id", Some(json!(new_session_id))),
            ("timestamp", Some(json!(timestamp))),
            ("cwd", Some(json!(self.cwd))),
            (
                "parentSession",
                previous_file.filter(|_| self.persist).map(Value::String),
            ),
        ]);

        let mut path_ids: HashSet<String> = kept
            .iter()
            .filter_map(|entry| entry_id(entry).map(str::to_string))
            .collect();
        let labels: Vec<(String, String, String)> = self
            .labels
            .iter()
            .filter(|(target, _, _)| path_ids.contains(*target))
            .map(|(target, label, timestamp)| {
                (target.to_string(), label.to_string(), timestamp.to_string())
            })
            .collect();
        let mut parent = kept
            .last()
            .and_then(|entry| entry_id(entry))
            .filter(|id| !id.is_empty())
            .map_or(Value::Null, |id| json!(id));
        let mut label_entries = Vec::new();
        for (target, label, label_timestamp) in labels {
            let id = generate_id(|candidate| path_ids.contains(candidate));
            path_ids.insert(id.clone());
            label_entries.push(object(vec![
                ("type", Some(json!("label"))),
                ("id", Some(json!(id))),
                ("parentId", Some(parent)),
                ("timestamp", Some(json!(label_timestamp))),
                ("targetId", Some(json!(target))),
                ("label", Some(json!(label))),
            ]));
            parent = json!(id);
        }

        self.file_entries = std::iter::once(header)
            .chain(kept)
            .chain(label_entries)
            .collect();
        self.session_id = new_session_id;
        if !self.persist {
            self.build_index();
            return Ok(None);
        }
        self.session_file = Some(new_file.clone());
        self.build_index();
        // As in `persist_entry`: written now if the path holds a conversation, else later.
        if self.has_conversation() {
            self.rewrite_file()?;
            self.flushed = true;
        } else {
            self.flushed = false;
        }
        Ok(Some(new_file))
    }

    /// A new persisted session (`SessionManager.create`), in `session_dir` or the working
    /// directory's default.
    pub fn create(
        cwd: &str,
        session_dir: Option<&str>,
        options: Option<NewSessionOptions>,
    ) -> Result<Self, String> {
        let dir = match session_dir {
            Some(dir) => paths::normalize(dir),
            None => default_session_dir(cwd, &agent_dir())?,
        };
        Self::construct(cwd, &dir, None, true, options, None)
    }

    /// Opens a session file (`SessionManager.open`). Its working directory comes from
    /// `cwd_override`, else the file's header, else the process.
    pub fn open(
        path: &str,
        session_dir: Option<&str>,
        cwd_override: Option<&str>,
    ) -> Result<Self, String> {
        let resolved = paths::resolve(path);
        let mut header = None;
        let mut preloaded = None;
        if cwd_override.is_none() && exists(&resolved) {
            match read_session_header(&resolved) {
                Ok(found) => header = found,
                Err(HeaderError::Io(error)) => return Err(error),
                // The bounded scan only speeds up discovery; a full load decides.
                Err(HeaderError::ScanLimit(_)) => {
                    let entries = load_entries_from_file(&resolved)?;
                    header = entries.first().filter(|entry| is_header(entry)).cloned();
                    preloaded = Some(entries);
                }
            }
        }
        let process_cwd = std::env::current_dir()
            .map(|cwd| cwd.to_string_lossy().into_owned())
            .unwrap_or_default();
        let cwd = cwd_override
            .map(str::to_string)
            .or_else(|| header.as_ref().and_then(header_cwd).map(str::to_string))
            .unwrap_or(process_cwd);
        let dir = match session_dir {
            Some(dir) => paths::normalize(dir),
            None => relay_tools::paths::node_resolve(&[&resolved, ".."], cfg!(windows)),
        };
        Self::construct(&cwd, &dir, Some(&resolved), true, None, preloaded)
    }

    /// Continues the most recent session, or starts one (`SessionManager.continueRecent`).
    pub fn continue_recent(cwd: &str, session_dir: Option<&str>) -> Result<Self, String> {
        let dir = match session_dir {
            Some(dir) => paths::normalize(dir),
            None => default_session_dir(cwd, &agent_dir())?,
        };
        let filter_cwd =
            session_dir.is_some() && dir != default_session_dir_path(cwd, &agent_dir());
        let recent = find_most_recent_session(&dir, filter_cwd.then_some(cwd));
        Self::construct(cwd, &dir, recent.as_deref(), true, None, None)
    }

    /// A session that is never written, optionally from entries held elsewhere
    /// (`SessionManager.inMemory`).
    pub fn in_memory(
        cwd: Option<&str>,
        options: Option<NewSessionOptions>,
        entries: Option<Vec<Value>>,
    ) -> Result<Self, String> {
        let process_cwd = std::env::current_dir()
            .map(|cwd| cwd.to_string_lossy().into_owned())
            .unwrap_or_default();
        Self::construct(
            cwd.unwrap_or(&process_cwd),
            "",
            None,
            false,
            options,
            entries,
        )
    }

    /// A new session in `target_cwd` with the whole history of another
    /// (`SessionManager.forkFrom`).
    pub fn fork_from(
        source_path: &str,
        target_cwd: &str,
        session_dir: Option<&str>,
        options: Option<NewSessionOptions>,
    ) -> Result<Self, String> {
        let source = paths::resolve(source_path);
        let target = paths::resolve(target_cwd);
        let entries = load_entries_from_file(&source)?;
        if entries.is_empty() {
            return Err(format!(
                "Cannot fork: source session file is empty or invalid: {source}"
            ));
        }
        if !entries.iter().any(is_header) {
            return Err(format!(
                "Cannot fork: source session has no header: {source}"
            ));
        }
        let dir = match session_dir {
            Some(dir) => paths::normalize(dir),
            None => default_session_dir(&target, &agent_dir())?,
        };
        if !exists(&dir) {
            fs::create_dir_all(&dir)
                .map_err(|error| relay_tools::js::fs_error(&error, "mkdir", &dir))?;
        }
        let options = options.unwrap_or_default();
        if let Some(id) = &options.id {
            assert_valid_session_id(id)?;
        }
        let id = options.id.unwrap_or_else(uuidv7);
        let timestamp = now_iso();
        let file_timestamp = timestamp.replace([':', '.'], "-");
        let file = paths::join(&dir, &format!("{file_timestamp}_{id}.jsonl"));
        let header = json!({
            "type": "session",
            "version": CURRENT_SESSION_VERSION,
            "id": id,
            "timestamp": timestamp,
            "cwd": target,
            "parentSession": source,
        });
        write_entries(&file, &[header], true)?;
        for entry in entries.iter().filter(|entry| !is_header(entry)) {
            append_entry(&file, entry)?;
        }
        Self::construct(&target, &dir, Some(&file), true, None, None)
    }

    /// A session file by exact id, reading only headers (`SessionManager.findById`).
    pub fn find_by_id(cwd: &str, id: &str, session_dir: Option<&str>) -> Option<String> {
        let dir = match session_dir {
            Some(dir) => paths::normalize(dir),
            None => default_session_dir(cwd, &agent_dir()).ok()?,
        };
        let filter_cwd =
            session_dir.is_some() && dir != default_session_dir_path(cwd, &agent_dir());
        let resolved_cwd = paths::resolve(cwd);
        for entry in fs::read_dir(&dir).ok()?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".jsonl") {
                continue;
            }
            let path = paths::join(&dir, &name);
            let Some(header) = crate::entries::read_session_header_for_discovery(&path) else {
                continue;
            };
            if text(&header, "id") != Some(id) {
                continue;
            }
            if filter_cwd && !session_cwd_matches(header_cwd(&header), &resolved_cwd) {
                continue;
            }
            return Some(path);
        }
        None
    }
}
