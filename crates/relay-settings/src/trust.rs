//! Project trust (`trust-manager.ts`, `project-trust.ts`): whether a folder's own settings and
//! resources (`.relay/settings.json`, extensions, skills, prompts, `SYSTEM.md`, `.agents/skills`)
//! may load. Decisions are kept in `<agent dir>/trust.json`, keyed by folder; the nearest folder
//! with a decision, walking up, answers for the ones below it.

use std::fs;
use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::manager::resolve;

const CONFIG_DIR_NAME: &str = ".relay";
const APP_NAME: &str = "relay";
/// Resources in `.relay` that only load in a trusted project.
const TRUST_REQUIRING_RESOURCES: [&str; 8] = [
    "settings.json",
    "mcp.json",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
];

fn windows() -> bool {
    cfg!(windows)
}

fn separator() -> &'static str {
    if windows() {
        "\\"
    } else {
        "/"
    }
}

fn dirname(path: &str) -> String {
    relay_tools::paths::dirname(path, windows())
}

fn join(dir: &str, name: &str) -> String {
    relay_tools::paths::node_join(dir, name, windows())
}

/// The root of an absolute path (`/`, `C:\`, `\\server\share\`) and the rest.
fn split_root(path: &str) -> (String, &str) {
    if !windows() {
        return ("/".to_string(), path.trim_start_matches('/'));
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        let root = format!("{}\\", &path[..2]);
        return (root, path[2..].trim_start_matches(['\\', '/']));
    }
    if let Some(unc) = path.strip_prefix("\\\\") {
        let parts: Vec<&str> = unc.splitn(3, ['\\', '/']).collect();
        if parts.len() >= 2 {
            let root = format!("\\\\{}\\{}\\", parts[0], parts[1]);
            return (root, parts.get(2).copied().unwrap_or(""));
        }
    }
    ("\\".to_string(), path.trim_start_matches(['\\', '/']))
}

/// Node's `fs.realpathSync`: the path resolved, then every symbolic link in it followed, keeping
/// the spelling of the parts that are not links; `None` when a part does not exist.
fn realpath(path: &str) -> Option<String> {
    let mut current_path = relay_tools::paths::node_resolve(&[path], windows());
    'restart: for _ in 0..64 {
        let (root, rest) = split_root(&current_path);
        fs::symlink_metadata(&root).ok()?;
        let parts: Vec<&str> = rest
            .split(['\\', '/'])
            .filter(|part| !part.is_empty())
            .collect();
        let mut resolved = root.clone();
        for (index, part) in parts.iter().enumerate() {
            let base = if resolved.ends_with(separator()) {
                format!("{resolved}{part}")
            } else {
                format!("{resolved}{}{part}", separator())
            };
            let metadata = fs::symlink_metadata(&base).ok()?;
            if metadata.file_type().is_symlink() {
                let target = fs::read_link(&base).ok()?;
                let target = target.to_string_lossy();
                let target = target.strip_prefix("\\\\?\\").unwrap_or(&target);
                let link = relay_tools::paths::node_resolve(&[&resolved, target], windows());
                let remaining = parts[index + 1..].join(separator());
                current_path = relay_tools::paths::node_resolve(&[&link, &remaining], windows());
                continue 'restart;
            }
            resolved = base;
        }
        return Some(resolved);
    }
    None
}

/// The path with its links followed, or as given when that fails (`canonicalizePath`).
pub fn canonicalize_path(path: &str) -> String {
    realpath(path).unwrap_or_else(|| path.to_string())
}

/// The folder a decision is stored under (`normalizeCwd`).
fn normalize_cwd(cwd: &str) -> String {
    canonicalize_path(&resolve(cwd))
}

/// A stored decision and the folder it is stored for (`ProjectTrustStoreEntry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustEntry {
    pub path: String,
    pub decision: bool,
}

/// A change to the store; `None` removes the folder's decision (`ProjectTrustUpdate`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustUpdate {
    pub path: String,
    pub decision: Option<bool>,
}

/// An answer the trust prompt offers (`ProjectTrustOption`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustOption {
    pub label: String,
    pub trusted: bool,
    /// What choosing it stores; none for a decision that lasts only this session.
    pub updates: Vec<TrustUpdate>,
    pub saved_path: Option<String>,
}

/// The nearest stored decision for `cwd` or a folder above it (`findNearestTrustEntry`).
fn find_nearest(data: &Map<String, Value>, cwd: &str) -> Option<TrustEntry> {
    let mut current = normalize_cwd(cwd);
    loop {
        if let Some(Value::Bool(decision)) = data.get(&current) {
            return Some(TrustEntry {
                path: current,
                decision: *decision,
            });
        }
        let parent = dirname(&current);
        if parent == current {
            return None;
        }
        current = parent;
    }
}

/// The folder above `cwd`, unless it is a root (`getProjectTrustParentPath`).
pub fn project_trust_parent_path(cwd: &str) -> Option<String> {
    let path = normalize_cwd(cwd);
    let parent = dirname(&path);
    (parent != path).then_some(parent)
}

/// The answers the trust prompt offers for `cwd` (`getProjectTrustOptions`).
pub fn project_trust_options(cwd: &str, include_session_only: bool) -> Vec<TrustOption> {
    let path = normalize_cwd(cwd);
    let mut options = vec![TrustOption {
        label: "Trust".into(),
        trusted: true,
        updates: vec![TrustUpdate {
            path: path.clone(),
            decision: Some(true),
        }],
        saved_path: Some(path.clone()),
    }];
    if let Some(parent) = project_trust_parent_path(cwd) {
        options.push(TrustOption {
            label: format!("Trust parent folder ({parent})"),
            trusted: true,
            updates: vec![
                TrustUpdate {
                    path: parent.clone(),
                    decision: Some(true),
                },
                TrustUpdate {
                    path: path.clone(),
                    decision: None,
                },
            ],
            saved_path: Some(parent),
        });
    }
    if include_session_only {
        options.push(TrustOption {
            label: "Trust (this session only)".into(),
            trusted: true,
            updates: Vec::new(),
            saved_path: None,
        });
    }
    options.push(TrustOption {
        label: "Do not trust".into(),
        trusted: false,
        updates: vec![TrustUpdate {
            path: path.clone(),
            decision: Some(false),
        }],
        saved_path: Some(path),
    });
    if include_session_only {
        options.push(TrustOption {
            label: "Do not trust (this session only)".into(),
            trusted: false,
            updates: Vec::new(),
            saved_path: None,
        });
    }
    options
}

/// Why the trust store could not be read or written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustError {
    pub message: String,
    /// A JSON syntax error, which V8 words differently; `message` keeps the store's prefix.
    pub syntax: bool,
}

impl TrustError {
    fn new(message: String) -> Self {
        TrustError {
            message,
            syntax: false,
        }
    }
}

fn read_trust_file(path: &str) -> Result<Map<String, Value>, TrustError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => {
            return Err(TrustError::new(format!(
                "Failed to read trust store {path}: {}",
                relay_tools::js::fs_error(&error, "open", path)
            )))
        }
    };
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    let parsed: Value = serde_json::from_str(text).map_err(|error| TrustError {
        message: format!("Failed to read trust store {path}: {error}"),
        syntax: true,
    })?;
    let Value::Object(entries) = parsed else {
        return Err(TrustError::new(format!(
            "Invalid trust store {path}: expected an object"
        )));
    };
    for (key, value) in &entries {
        if !matches!(value, Value::Bool(_) | Value::Null) {
            return Err(TrustError::new(format!(
                "Invalid trust store {path}: value for {} must be true, false, or null",
                Value::String(key.clone())
            )));
        }
    }
    Ok(entries)
}

/// Writes the decisions sorted by folder, as `JSON.stringify(sorted, null, 2)` and a newline.
fn write_trust_file(path: &str, data: &Map<String, Value>) -> Result<(), TrustError> {
    let mut keys: Vec<&String> = data.keys().collect();
    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let sorted: Map<String, Value> = keys
        .into_iter()
        .filter(|key| matches!(data[*key], Value::Bool(_) | Value::Null))
        .map(|key| (key.clone(), data[key].clone()))
        .collect();
    let dir = dirname(path);
    fs::create_dir_all(&dir)
        .map_err(|error| TrustError::new(relay_tools::js::fs_error(&error, "mkdir", &dir)))?;
    let text = format!(
        "{}\n",
        relay_ai::json::stringify_pretty(&Value::Object(sorted))
    );
    fs::write(path, text)
        .map_err(|error| TrustError::new(relay_tools::js::fs_error(&error, "open", path)))
}

/// Runs `change` under the store's `trust.json.lock`, retried as the TypeScript store retries.
fn with_lock<T>(
    path: &str,
    change: impl FnOnce() -> Result<T, TrustError>,
) -> Result<T, TrustError> {
    let dir = dirname(path);
    fs::create_dir_all(&dir)
        .map_err(|error| TrustError::new(relay_tools::js::fs_error(&error, "mkdir", &dir)))?;
    let _lock = relay_ai::auth_file::lock_file(
        Path::new(path),
        Duration::from_secs(10),
        10,
        Duration::from_millis(20),
    )
    .map_err(|error| {
        TrustError::new(if error.starts_with("Lock file is already being held") {
            "Lock file is already being held".to_string()
        } else {
            error
        })
    })?;
    change()
}

/// Whether `cwd` holds resources that need trust: one of `.relay`'s, or `.agents/skills` in it or
/// a folder above it other than the user's own `~/.agents/skills`
/// (`hasTrustRequiringProjectResources`).
pub fn has_trust_requiring_project_resources(cwd: &str) -> bool {
    let home = std::env::var("HOME")
        .ok()
        .filter(|home| !home.is_empty())
        .or_else(relay_tools::paths::home_dir)
        .unwrap_or_default();
    let home = canonicalize_path(&resolve(&home));
    let user_skills = join(&join(&home, ".agents"), "skills");
    let mut current = canonicalize_path(&resolve(cwd));
    let config = join(&current, CONFIG_DIR_NAME);
    if TRUST_REQUIRING_RESOURCES
        .iter()
        .any(|entry| Path::new(&join(&config, entry)).exists())
    {
        return true;
    }
    loop {
        let skills = join(&join(&current, ".agents"), "skills");
        if skills != user_skills && Path::new(&skills).exists() {
            return true;
        }
        let parent = dirname(&current);
        if parent == current {
            return false;
        }
        current = parent;
    }
}

/// The stored decisions in `<agent dir>/trust.json` (`ProjectTrustStore`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectTrustStore {
    trust_path: String,
}

impl ProjectTrustStore {
    pub fn new(agent_dir: &str) -> Self {
        ProjectTrustStore {
            trust_path: join(&resolve(agent_dir), "trust.json"),
        }
    }

    pub fn path(&self) -> &str {
        &self.trust_path
    }

    /// The decision for `cwd`, from it or the nearest folder above with one.
    pub fn get(&self, cwd: &str) -> Result<Option<bool>, TrustError> {
        Ok(self.get_entry(cwd)?.map(|entry| entry.decision))
    }

    pub fn get_entry(&self, cwd: &str) -> Result<Option<TrustEntry>, TrustError> {
        with_lock(&self.trust_path, || {
            let data = read_trust_file(&self.trust_path)?;
            Ok(find_nearest(&data, cwd))
        })
    }

    pub fn set(&self, cwd: &str, decision: Option<bool>) -> Result<(), TrustError> {
        self.set_many(&[TrustUpdate {
            path: cwd.to_string(),
            decision,
        }])
    }

    /// Applies the updates in order and writes the store sorted by folder (`setMany`).
    pub fn set_many(&self, updates: &[TrustUpdate]) -> Result<(), TrustError> {
        with_lock(&self.trust_path, || {
            let mut data = read_trust_file(&self.trust_path)?;
            for update in updates {
                let key = normalize_cwd(&update.path);
                match update.decision {
                    None => {
                        data.shift_remove(&key);
                    }
                    Some(decision) => {
                        data.insert(key, Value::Bool(decision));
                    }
                }
            }
            write_trust_file(&self.trust_path, &data)
        })
    }
}

/// What an extension's `project_trust` handler decided (`ProjectTrustEventResult`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtensionTrust {
    pub trusted: bool,
    /// Store the decision.
    pub remember: bool,
}

/// How `resolve_project_trusted` decides (`ResolveProjectTrustedOptions`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectTrustInput<'a> {
    pub cwd: &'a str,
    pub store: &'a ProjectTrustStore,
    /// `--trust` or `--no-trust`.
    pub trust_override: Option<bool>,
    /// `defaultProjectTrust`: `ask`, `always` or `never`.
    pub default_project_trust: &'a str,
    pub extension: Option<ExtensionTrust>,
    pub has_ui: bool,
}

/// The decision, or the question to ask when only the user can make it.
#[derive(Debug, Clone, PartialEq)]
pub enum TrustResolution {
    Decided(bool),
    /// Ask with `title` and the options' labels, then apply the answer with `answer_trust_prompt`.
    Ask {
        title: String,
        options: Vec<TrustOption>,
    },
}

/// Whether the project in `input.cwd` is trusted (`resolveProjectTrusted`): an override, then no
/// resources needing trust, then an extension, then a stored decision, then the default, else the
/// user. Without a UI the answer is no.
pub fn resolve_project_trusted(
    input: &ProjectTrustInput<'_>,
) -> Result<TrustResolution, TrustError> {
    if let Some(trusted) = input.trust_override {
        return Ok(TrustResolution::Decided(trusted));
    }
    if !has_trust_requiring_project_resources(input.cwd) {
        return Ok(TrustResolution::Decided(true));
    }
    if let Some(extension) = input.extension {
        if extension.remember {
            input.store.set(input.cwd, Some(extension.trusted))?;
        }
        return Ok(TrustResolution::Decided(extension.trusted));
    }
    if let Some(decision) = input.store.get(input.cwd)? {
        return Ok(TrustResolution::Decided(decision));
    }
    match input.default_project_trust {
        "always" => return Ok(TrustResolution::Decided(true)),
        "never" => return Ok(TrustResolution::Decided(false)),
        _ => {}
    }
    if !input.has_ui {
        return Ok(TrustResolution::Decided(false));
    }
    Ok(TrustResolution::Ask {
        title: format!(
            "Trust project folder?\n{}\n\nThis allows {APP_NAME} to load {CONFIG_DIR_NAME} settings and resources, install missing project packages, and execute project extensions.",
            input.cwd
        ),
        options: project_trust_options(input.cwd, true),
    })
}

/// Applies the user's answer to the trust prompt: the chosen option's updates are stored and its
/// decision returned; no answer, or one not offered, is no.
pub fn answer_trust_prompt(
    store: &ProjectTrustStore,
    options: &[TrustOption],
    answer: Option<&str>,
) -> Result<bool, TrustError> {
    let Some(option) =
        answer.and_then(|answer| options.iter().find(|option| option.label == answer))
    else {
        return Ok(false);
    };
    if !option.updates.is_empty() {
        store.set_many(&option.updates)?;
    }
    Ok(option.trusted)
}
