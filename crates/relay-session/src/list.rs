//! Listing sessions (`SessionManager.list`, `listAll`): each file's header, name, message count,
//! first user message and last activity, newest first.

use std::fs;
use std::time::UNIX_EPOCH;

use serde_json::Value;

use crate::date::parse_date;
use crate::entries::{entry_type, field, message_text, parse_line, text};
use crate::manager::{
    agent_dir, default_session_dir, default_session_dir_path, session_cwd_matches, sessions_dir,
};
use crate::paths;

/// A session in a listing (`SessionInfo`). Times are milliseconds; an invalid `created` is NaN,
/// as an invalid `Date` is.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionInfo {
    pub path: String,
    /// The header's `id`, absent when it has none.
    pub id: Option<Value>,
    /// Where the session started; empty for old sessions.
    pub cwd: String,
    pub name: Option<String>,
    /// The session this one was forked from.
    pub parent_session_path: Option<Value>,
    pub created: f64,
    pub modified: f64,
    pub message_count: usize,
    pub first_message: String,
    pub all_messages_text: String,
}

/// `new Date(value).getTime()` for a header field.
fn date_of(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::String(text)) => parse_date(text).map_or(f64::NAN, |time| time as f64),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    }
}

/// When a user or assistant message happened: its own time, else its entry's
/// (`getMessageActivityTime`).
fn activity_time(entry: &Value) -> Option<f64> {
    let message = field(entry, "message")?;
    if text(message, "role").is_none() || field(message, "content").is_none() {
        return None;
    }
    if !matches!(text(message, "role"), Some("user" | "assistant")) {
        return None;
    }
    if let Some(Value::Number(time)) = field(message, "timestamp") {
        return time.as_f64();
    }
    text(entry, "timestamp")
        .and_then(parse_date)
        .map(|time| time as f64)
}

/// Lines as `readline` splits them: at `\n`, `\r\n` and a lone `\r`.
fn read_lines(content: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut start = 0;
    let bytes = content.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'\n' => {
                lines.push(&content[start..at]);
                start = at + 1;
            }
            b'\r' => {
                lines.push(&content[start..at]);
                if bytes.get(at + 1) == Some(&b'\n') {
                    at += 1;
                }
                start = at + 1;
            }
            _ => {}
        }
        at += 1;
    }
    if start < bytes.len() {
        lines.push(&content[start..]);
    }
    lines
}

/// One file's listing, or `None` when it is not a session (`buildSessionInfo`).
pub fn session_info(path: &str) -> Option<SessionInfo> {
    let metadata = fs::metadata(path).ok()?;
    let bytes = fs::read(path).ok()?;
    let content = String::from_utf8_lossy(&bytes);
    let mut header: Option<Value> = None;
    let mut message_count = 0;
    let mut first_message = String::new();
    let mut all_messages: Vec<String> = Vec::new();
    let mut name: Option<String> = None;
    let mut last_activity: Option<f64> = None;
    for line in read_lines(&content) {
        let Some(entry) = parse_line(line) else {
            continue;
        };
        if header.is_none() {
            if entry_type(&entry) != Some("session") {
                return None;
            }
            header = Some(entry);
            continue;
        }
        if entry_type(&entry) == Some("session_info") {
            name = text(&entry, "name")
                .map(relay_ai::text::js_trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string);
        }
        if entry_type(&entry) != Some("message") {
            continue;
        }
        message_count += 1;
        if let Some(time) = activity_time(&entry) {
            last_activity = Some(last_activity.unwrap_or(0.0).max(time));
        }
        let Some(message) = field(&entry, "message") else {
            continue;
        };
        if text(message, "role").is_none() || field(message, "content").is_none() {
            continue;
        }
        let role = text(message, "role");
        if !matches!(role, Some("user" | "assistant")) {
            continue;
        }
        let message_text = message_text(message);
        if message_text.is_empty() {
            continue;
        }
        if first_message.is_empty() && role == Some("user") {
            first_message = message_text.clone();
        }
        all_messages.push(message_text);
    }
    let header = header?;
    let header_time = match field(&header, "timestamp") {
        Some(Value::String(text)) => parse_date(text).map_or(f64::NAN, |time| time as f64),
        _ => f64::NAN,
    };
    let modified = match last_activity {
        Some(time) if time > 0.0 => time,
        _ if !header_time.is_nan() => header_time,
        _ => metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(f64::NAN, |time| time.as_millis() as f64),
    };
    Some(SessionInfo {
        path: path.to_string(),
        id: field(&header, "id").cloned(),
        cwd: text(&header, "cwd").unwrap_or_default().to_string(),
        name,
        parent_session_path: field(&header, "parentSession").cloned(),
        created: date_of(field(&header, "timestamp")),
        modified,
        message_count,
        first_message: if first_message.is_empty() {
            "(no messages)".to_string()
        } else {
            first_message
        },
        all_messages_text: all_messages.join(" "),
    })
}

/// Newest activity first; equal times keep their order.
fn sort_sessions(sessions: &mut [SessionInfo]) {
    sessions.sort_by(|a, b| {
        (b.modified - a.modified)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

/// The sessions of one directory, files read in descending name order (`listSessionsFromDir`).
fn sessions_from_dir(dir: &str) -> Vec<SessionInfo> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".jsonl"))
        .collect();
    names.sort_by(|a, b| relay_tools::js::locale_compare(b, a));
    names
        .iter()
        .filter_map(|name| session_info(&paths::join(dir, name)))
        .collect()
}

/// A working directory's sessions, newest first (`SessionManager.list`). A directory other than
/// the default holds sessions of any project, so only those started in `cwd` are listed.
pub fn list(cwd: &str, session_dir: Option<&str>) -> Vec<SessionInfo> {
    let dir = match session_dir {
        Some(dir) => paths::normalize(dir),
        None => match default_session_dir(cwd, &agent_dir()) {
            Ok(dir) => dir,
            Err(_) => return Vec::new(),
        },
    };
    let filter_cwd = session_dir.is_some() && dir != default_session_dir_path(cwd, &agent_dir());
    let resolved_cwd = paths::resolve(cwd);
    let mut sessions: Vec<SessionInfo> = sessions_from_dir(&dir)
        .into_iter()
        .filter(|session| !filter_cwd || session_cwd_matches(Some(&session.cwd), &resolved_cwd))
        .collect();
    sort_sessions(&mut sessions);
    sessions
}

/// Every project's sessions, newest first (`SessionManager.listAll`); with a directory, that
/// directory's.
pub fn list_all(session_dir: Option<&str>) -> Vec<SessionInfo> {
    if let Some(dir) = session_dir {
        let mut sessions = sessions_from_dir(&paths::normalize(dir));
        sort_sessions(&mut sessions);
        return sessions;
    }
    let root = sessions_dir();
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut candidates: Vec<(String, Option<f64>)> = Vec::new();
    for entry in entries.flatten() {
        let is_dir = entry
            .file_type()
            .is_ok_and(|kind| kind.is_dir() || kind.is_symlink());
        if !is_dir {
            continue;
        }
        let dir = paths::join(&root, &entry.file_name().to_string_lossy());
        for file in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = file.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".jsonl") {
                continue;
            }
            let path = paths::join(&dir, &name);
            let modified = fs::metadata(&path)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| time.as_secs_f64() * 1000.0);
            candidates.push((path, modified));
        }
    }
    candidates.sort_by(|a, b| {
        let time = |candidate: &(String, Option<f64>)| candidate.1.unwrap_or(f64::NEG_INFINITY);
        time(b)
            .partial_cmp(&time(a))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                let name = |path: &str| relay_tools::paths::basename(path, cfg!(windows));
                relay_tools::js::locale_compare(&name(&b.0), &name(&a.0))
            })
    });
    let mut sessions: Vec<SessionInfo> = candidates
        .iter()
        .filter_map(|(path, _)| session_info(path))
        .collect();
    sort_sessions(&mut sessions);
    sessions
}
