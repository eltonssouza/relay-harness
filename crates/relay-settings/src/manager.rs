//! `SettingsManager`: global settings from the agent directory and, for a trusted project, its
//! `.relay/settings.json` over them, with the getters' defaults and the setters' writes.
//!
//! A setter changes the global (or project) settings and writes only the fields it changed: the
//! file is read again under its lock and those fields, or for nested ones those keys, replace
//! what it holds, so edits other processes made since stay. A file that did not parse is never
//! written. The TypeScript manager queues its writes; here each write happens before the setter
//! returns, which a caller awaiting `flush` cannot tell apart.

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::merge::{deep_merge_settings, migrate_settings, resolve_default_tools, Settings};
use crate::storage::{
    FileSettingsStorage, InMemorySettingsStorage, SettingsScope, SettingsStorage, StorageError,
};

const CONFIG_DIR_NAME: &str = ".relay";
pub const DEFAULT_HTTP_IDLE_TIMEOUT_MS: f64 = 300_000.0;
pub const DEFAULT_MAX_AGENT_RETRY_DELAY_MS: f64 = 60_000.0;
const DEFAULT_RESERVE_TOKENS: f64 = 16_384.0;
const DEFAULT_KEEP_RECENT_TOKENS: f64 = 20_000.0;
const CACHE_WARMING_MODES: [&str; 3] = ["off", "streaming", "idle"];
const TREE_FILTER_MODES: [&str; 5] = ["default", "no-tools", "user-only", "labeled-only", "all"];
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A failure loading or saving one scope (`SettingsError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsError {
    pub scope: SettingsScope,
    pub path: Option<String>,
    pub message: String,
    /// A JSON syntax error, which V8 words differently.
    pub syntax: bool,
}

/// `String(value)`.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => {
            relay_ai::text::js_number_to_string(number.as_f64().unwrap_or_default())
        }
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JavaScript truthiness.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `value ?? fallback`.
fn or(value: Option<&Value>, fallback: Value) -> Value {
    value
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(fallback)
}

/// `value ?? fallback` as a condition.
fn flag(value: Option<&Value>, fallback: bool) -> bool {
    match value.filter(|value| !value.is_null()) {
        Some(value) => truthy(Some(value)),
        None => fallback,
    }
}

/// `[...(value ?? [])]`.
fn list(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text
            .chars()
            .map(|character| json!(character.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

/// Parses a settings file's text and migrates it (`JSON.parse(stripBom(content))`, then
/// `migrateSettings`).
pub fn parse_settings(text: &str) -> Result<Settings, StorageError> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let value: Value = serde_json::from_str(text).map_err(|error| StorageError {
        message: error.to_string(),
        syntax: true,
    })?;
    let mut settings = match value {
        Value::Object(settings) => settings,
        Value::Array(items) => items
            .into_iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item))
            .collect(),
        // `"queueMode" in settings` throws for anything else.
        other => {
            return Err(StorageError::new(format!(
                "Cannot use 'in' operator to search for 'queueMode' in {}",
                js_string(&other)
            )))
        }
    };
    migrate_settings(&mut settings);
    Ok(settings)
}

/// `parseHttpIdleTimeoutMs`: a non-negative number of milliseconds, floored; `"disabled"` is 0.
pub fn parse_http_idle_timeout_ms(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::String(text) => {
            let trimmed = relay_ai::text::js_trim(text);
            if trimmed.eq_ignore_ascii_case("disabled") {
                return Some(0.0);
            }
            if trimmed.is_empty() {
                return None;
            }
            let number = relay_ai::text::js_string_to_number(trimmed);
            parse_http_idle_timeout_ms(Some(&json!(number)))
        }
        Value::Number(number) => {
            let number = number.as_f64()?;
            (number.is_finite() && number >= 0.0).then(|| number.floor())
        }
        _ => None,
    }
}

/// `parseTimeoutSetting`: the timeout, nothing when unset, an error for anything else.
fn parse_timeout_setting(value: Option<&Value>, name: &str) -> Result<Option<f64>, String> {
    if let Some(timeout) = parse_http_idle_timeout_ms(value) {
        return Ok(Some(timeout));
    }
    match value {
        Some(value) => Err(format!("Invalid {name} setting: {}", js_string(value))),
        None => Ok(None),
    }
}

/// Why `value` cannot be the harness setting `key` (`harnessSettingProblem`).
pub fn harness_setting_problem(key: &str, value: &Value) -> Option<String> {
    let switches = [
        "alignment",
        "authorizationGate",
        "scopeGuard",
        "evidence",
        "context",
    ];
    if switches.contains(&key) {
        return (!value.is_boolean()).then(|| format!("harnessCore.{key} must be true or false"));
    }
    let minimum = match key {
        "contextKeepRecent" | "contextBatchSize" => Some(1.0),
        "maxChangedLines" | "maxFileLines" => Some(0.0),
        _ => None,
    };
    if let Some(minimum) = minimum {
        let valid = value
            .as_f64()
            .is_some_and(|number| number.fract() == 0.0 && number >= minimum);
        return (!valid)
            .then(|| format!("harnessCore.{key} must be an integer of at least {minimum}"));
    }
    if key == "verifyCommands" {
        let valid = value.as_array().is_some_and(|commands| {
            commands.iter().all(|command| {
                command
                    .as_str()
                    .is_some_and(|command| !relay_ai::text::js_trim(command).is_empty())
            })
        });
        return (!valid)
            .then(|| "harnessCore.verifyCommands must be a list of commands".to_string());
    }
    Some(format!("harnessCore.{key} is not a harness setting"))
}

/// The harness pillars and limits with their defaults (`getHarnessCoreSettings`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessCoreSettings {
    pub alignment: bool,
    pub authorization_gate: bool,
    pub scope_guard: bool,
    pub evidence: bool,
    pub context: bool,
    pub context_keep_recent: Value,
    pub context_batch_size: Value,
    pub verify_commands: Vec<String>,
    pub max_changed_lines: Value,
    pub max_file_lines: Value,
}

/// Compaction settings for a model (`getCompactionSettings`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionSettings {
    pub enabled: bool,
    #[serde(serialize_with = "relay_ai::json::serialize_js_f64")]
    pub reserve_tokens: f64,
    #[serde(serialize_with = "relay_ai::json::serialize_js_f64")]
    pub keep_recent_tokens: f64,
}

/// Fields changed in this session, in the order a `Set` keeps them, and the nested keys changed
/// in each.
#[derive(Debug, Clone, Default)]
struct Modified {
    fields: Vec<String>,
    nested: Vec<(String, Vec<String>)>,
}

impl Modified {
    fn mark(&mut self, field: &str, nested_key: Option<&str>) {
        if !self.fields.iter().any(|existing| existing == field) {
            self.fields.push(field.to_string());
        }
        if let Some(key) = nested_key {
            match self
                .nested
                .iter_mut()
                .find(|(existing, _)| existing == field)
            {
                Some((_, keys)) => {
                    if !keys.iter().any(|existing| existing == key) {
                        keys.push(key.to_string());
                    }
                }
                None => self.nested.push((field.to_string(), vec![key.to_string()])),
            }
        }
    }

    fn nested_keys(&self, field: &str) -> Option<&Vec<String>> {
        self.nested
            .iter()
            .find(|(existing, _)| existing == field)
            .map(|(_, keys)| keys)
    }

    fn clear(&mut self) {
        self.fields.clear();
        self.nested.clear();
    }
}

/// The settings of the agent and the project (`SettingsManager`).
pub struct SettingsManager {
    storage: Box<dyn SettingsStorage>,
    global: Settings,
    project: Settings,
    settings: Settings,
    project_trusted: bool,
    modified: Modified,
    modified_project: Modified,
    global_load_error: bool,
    project_load_error: bool,
    errors: Vec<SettingsError>,
    global_path: Option<String>,
    project_path: Option<String>,
}

fn load(
    storage: &dyn SettingsStorage,
    scope: SettingsScope,
    project_trusted: bool,
) -> Result<Settings, StorageError> {
    if scope == SettingsScope::Project && !project_trusted {
        return Ok(Settings::new());
    }
    let mut content: Option<String> = None;
    storage.with_lock(scope, &mut |current| {
        content = current.map(str::to_string);
        Ok(None)
    })?;
    match content.filter(|content| !content.is_empty()) {
        Some(content) => parse_settings(&content),
        None => Ok(Settings::new()),
    }
}

fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the operating system's random source");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// `resolvePath(path)` from the process's working directory.
pub(crate) fn resolve(path: &str) -> String {
    let home = relay_tools::paths::home_dir();
    let process = std::env::current_dir()
        .map(|cwd| cwd.to_string_lossy().into_owned())
        .unwrap_or_default();
    relay_tools::paths::resolve_path(
        path,
        &process,
        &relay_tools::paths::PathInput {
            home: home.as_deref(),
            windows: cfg!(windows),
            ..relay_tools::paths::PathInput::default()
        },
    )
}

fn normalize(path: &str) -> String {
    let home = relay_tools::paths::home_dir();
    relay_tools::paths::normalize_path(
        path,
        &relay_tools::paths::PathInput {
            home: home.as_deref(),
            windows: cfg!(windows),
            ..relay_tools::paths::PathInput::default()
        },
    )
}

/// A model for the per-model compaction settings: its provider and id.
pub type ModelKey<'a> = (&'a str, &'a str);

impl SettingsManager {
    fn new(
        storage: Box<dyn SettingsStorage>,
        project_trusted: bool,
        global_path: Option<String>,
        project_path: Option<String>,
    ) -> Self {
        let mut errors = Vec::new();
        let mut take =
            |scope, result: Result<Settings, StorageError>, path: &Option<String>| match result {
                Ok(settings) => (settings, false),
                Err(error) => {
                    errors.push(SettingsError {
                        scope,
                        path: path.clone(),
                        message: error.message,
                        syntax: error.syntax,
                    });
                    (Settings::new(), true)
                }
            };
        let (global, global_load_error) = take(
            SettingsScope::Global,
            load(storage.as_ref(), SettingsScope::Global, true),
            &global_path,
        );
        let (project, project_load_error) = take(
            SettingsScope::Project,
            load(storage.as_ref(), SettingsScope::Project, project_trusted),
            &project_path,
        );
        SettingsManager {
            settings: deep_merge_settings(&global, &project),
            storage,
            global,
            project,
            project_trusted,
            modified: Modified::default(),
            modified_project: Modified::default(),
            global_load_error,
            project_load_error,
            errors,
            global_path,
            project_path,
        }
    }

    /// Settings from `<agent dir>/settings.json` and `<cwd>/.relay/settings.json`
    /// (`SettingsManager.create`).
    pub fn create(cwd: &str, agent_dir: &str, project_trusted: bool) -> Self {
        let cwd = resolve(cwd);
        let agent_dir = resolve(agent_dir);
        let global = Path::new(&agent_dir).join("settings.json");
        let project = Path::new(&cwd).join(CONFIG_DIR_NAME).join("settings.json");
        let paths = (
            Some(global.to_string_lossy().into_owned()),
            Some(project.to_string_lossy().into_owned()),
        );
        SettingsManager::new(
            Box::new(FileSettingsStorage::new(global, project)),
            project_trusted,
            paths.0,
            paths.1,
        )
    }

    /// Settings from any storage (`SettingsManager.fromStorage`).
    pub fn from_storage(storage: Box<dyn SettingsStorage>, project_trusted: bool) -> Self {
        SettingsManager::new(storage, project_trusted, None, None)
    }

    /// Settings held in memory, starting from `settings` (`SettingsManager.inMemory`).
    pub fn in_memory(settings: Settings, project_trusted: bool) -> Self {
        let storage = InMemorySettingsStorage::default();
        let mut initial = settings;
        migrate_settings(&mut initial);
        let text = relay_ai::json::stringify_pretty(&Value::Object(initial));
        let _ = storage.with_lock(SettingsScope::Global, &mut |_| Ok(Some(text.clone())));
        SettingsManager::from_storage(Box::new(storage), project_trusted)
    }

    /// The effective settings: global, then project, then overrides (`getSettings`).
    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn global_settings(&self) -> &Settings {
        &self.global
    }

    pub fn project_settings(&self) -> &Settings {
        &self.project
    }

    pub fn is_project_trusted(&self) -> bool {
        self.project_trusted
    }

    fn record_error(&mut self, scope: SettingsScope, error: StorageError) {
        let path = match scope {
            SettingsScope::Global => self.global_path.clone(),
            SettingsScope::Project => self.project_path.clone(),
        };
        self.errors.push(SettingsError {
            scope,
            path,
            message: error.message,
            syntax: error.syntax,
        });
    }

    fn merge(&mut self) {
        self.settings = deep_merge_settings(&self.global, &self.project);
    }

    /// Trusts the project or stops trusting it, loading or dropping its settings
    /// (`setProjectTrusted`).
    pub fn set_project_trusted(&mut self, trusted: bool) {
        if self.project_trusted == trusted {
            return;
        }
        self.project_trusted = trusted;
        self.modified_project.clear();
        if !trusted {
            self.project = Settings::new();
            self.project_load_error = false;
            self.merge();
            return;
        }
        match load(self.storage.as_ref(), SettingsScope::Project, true) {
            Ok(settings) => {
                self.project = settings;
                self.project_load_error = false;
            }
            Err(error) => {
                self.project = Settings::new();
                self.project_load_error = true;
                self.record_error(SettingsScope::Project, error);
            }
        }
        self.merge();
    }

    /// Reads both files again; a file that fails keeps the settings it had (`reload`).
    pub fn reload(&mut self) {
        match load(self.storage.as_ref(), SettingsScope::Global, true) {
            Ok(settings) => {
                self.global = settings;
                self.global_load_error = false;
            }
            Err(error) => {
                self.global_load_error = true;
                self.record_error(SettingsScope::Global, error);
            }
        }
        self.modified.clear();
        self.modified_project.clear();
        match load(
            self.storage.as_ref(),
            SettingsScope::Project,
            self.project_trusted,
        ) {
            Ok(settings) => {
                self.project = settings;
                self.project_load_error = false;
            }
            Err(error) => {
                self.project_load_error = true;
                self.record_error(SettingsScope::Project, error);
            }
        }
        self.merge();
    }

    /// Overrides on top of the effective settings, until the next save or reload
    /// (`applyOverrides`).
    pub fn apply_overrides(&mut self, overrides: &Settings) {
        self.settings = deep_merge_settings(&self.settings, overrides);
    }

    /// The errors since the last call (`drainErrors`).
    pub fn drain_errors(&mut self) -> Vec<SettingsError> {
        std::mem::take(&mut self.errors)
    }

    /// Writes the changed fields of `snapshot` into the scope's file (`persistScopedSettings`).
    fn persist(
        &self,
        scope: SettingsScope,
        snapshot: &Settings,
        modified: &Modified,
    ) -> Result<(), StorageError> {
        self.storage.with_lock(scope, &mut |current| {
            let file = match current.filter(|current| !current.is_empty()) {
                Some(current) => parse_settings(current)?,
                None => Settings::new(),
            };
            let mut merged = file.clone();
            for field in &modified.fields {
                let value = snapshot.get(field);
                match (modified.nested_keys(field), value) {
                    (Some(keys), Some(Value::Object(in_memory))) => {
                        let mut nested = match file.get(field) {
                            Some(Value::Object(base)) => base.clone(),
                            _ => Map::new(),
                        };
                        for key in keys {
                            match in_memory.get(key) {
                                Some(value) => {
                                    nested.insert(key.clone(), value.clone());
                                }
                                None => {
                                    nested.shift_remove(key);
                                }
                            }
                        }
                        merged.insert(field.clone(), Value::Object(nested));
                    }
                    (_, Some(value)) => {
                        merged.insert(field.clone(), value.clone());
                    }
                    (_, None) => {
                        merged.shift_remove(field);
                    }
                }
            }
            Ok(Some(relay_ai::json::stringify_pretty(&Value::Object(
                merged,
            ))))
        })
    }

    fn save(&mut self) {
        self.merge();
        if self.global_load_error {
            return;
        }
        let snapshot = self.global.clone();
        let modified = self.modified.clone();
        match self.persist(SettingsScope::Global, &snapshot, &modified) {
            Ok(()) => self.modified.clear(),
            Err(error) => self.record_error(SettingsScope::Global, error),
        }
    }

    fn assert_project_trusted(&self) -> Result<(), String> {
        if self.project_trusted {
            Ok(())
        } else {
            Err("Project is not trusted; refusing to write project settings".to_string())
        }
    }

    fn update_project(&mut self, field: &str, value: Value) -> Result<(), String> {
        self.assert_project_trusted()?;
        let mut project = self.project.clone();
        project.insert(field.to_string(), value);
        self.modified_project.mark(field, None);
        self.project = project;
        self.merge();
        if self.project_load_error {
            return Ok(());
        }
        let snapshot = self.project.clone();
        let modified = self.modified_project.clone();
        match self.persist(SettingsScope::Project, &snapshot, &modified) {
            Ok(()) => self.modified_project.clear(),
            Err(error) => self.record_error(SettingsScope::Project, error),
        }
        Ok(())
    }

    /// Sets (or, with `None`, removes) a global field and saves it.
    fn set(&mut self, field: &str, value: Option<Value>) {
        match value {
            Some(value) => {
                self.global.insert(field.to_string(), value);
            }
            None => {
                self.global.shift_remove(field);
            }
        }
        self.modified.mark(field, None);
        self.save();
    }

    /// Sets a key of a global object field, creating the object, and saves it.
    fn set_nested(&mut self, field: &str, key: &str, value: Value) {
        let object = self
            .global
            .entry(field.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !object.is_object() {
            *object = Value::Object(Map::new());
        }
        object
            .as_object_mut()
            .expect("an object")
            .insert(key.to_string(), value);
        self.modified.mark(field, Some(key));
        self.save();
    }

    fn top(&self, key: &str) -> Option<&Value> {
        self.settings.get(key)
    }

    fn nested(&self, key: &str, inner: &str) -> Option<&Value> {
        self.top(key)?.as_object()?.get(inner)
    }

    /// A path setting, `~` expanded when set (`getSessionDir`, `getShellPath`).
    fn path_setting(&self, key: &str) -> Option<Value> {
        let value = self.top(key)?;
        match value {
            Value::String(path) if !path.is_empty() => Some(json!(normalize(path))),
            other => Some(other.clone()),
        }
    }

    pub fn last_changelog_version(&self) -> Option<Value> {
        self.top("lastChangelogVersion").cloned()
    }

    pub fn set_last_changelog_version(&mut self, version: &str) {
        self.set("lastChangelogVersion", Some(json!(version)));
    }

    pub fn session_dir(&self) -> Option<Value> {
        self.path_setting("sessionDir")
    }

    pub fn default_provider(&self) -> Option<Value> {
        self.top("defaultProvider").cloned()
    }

    pub fn default_model(&self) -> Option<Value> {
        self.top("defaultModel").cloned()
    }

    pub fn set_default_provider(&mut self, provider: &str) {
        self.set("defaultProvider", Some(json!(provider)));
    }

    pub fn set_default_model(&mut self, model: &str) {
        self.set("defaultModel", Some(json!(model)));
    }

    pub fn set_default_model_and_provider(&mut self, provider: &str, model: &str) {
        self.global
            .insert("defaultProvider".into(), json!(provider));
        self.global.insert("defaultModel".into(), json!(model));
        self.modified.mark("defaultProvider", None);
        self.modified.mark("defaultModel", None);
        self.save();
    }

    fn mode(&self, key: &str) -> Value {
        match self.top(key) {
            value if truthy(value) => value.cloned().unwrap_or_default(),
            _ => json!("one-at-a-time"),
        }
    }

    pub fn steering_mode(&self) -> Value {
        self.mode("steeringMode")
    }

    pub fn set_steering_mode(&mut self, mode: &str) {
        self.set("steeringMode", Some(json!(mode)));
    }

    pub fn follow_up_mode(&self) -> Value {
        self.mode("followUpMode")
    }

    pub fn set_follow_up_mode(&mut self, mode: &str) {
        self.set("followUpMode", Some(json!(mode)));
    }

    /// The theme as set, a name or a path (`getThemeSetting`).
    pub fn theme_setting(&self) -> Option<String> {
        self.top("theme")
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// The theme's name; a path is not one (`getTheme`).
    pub fn theme(&self) -> Option<String> {
        self.theme_setting().filter(|theme| !theme.contains('/'))
    }

    pub fn set_theme(&mut self, theme: &str) {
        self.set("theme", Some(json!(theme)));
    }

    pub fn default_thinking_level(&self) -> Option<Value> {
        self.top("defaultThinkingLevel").cloned()
    }

    pub fn set_default_thinking_level(&mut self, level: &str) {
        self.set("defaultThinkingLevel", Some(json!(level)));
    }

    pub fn model_thinking_level(&self, provider: &str, model: &str) -> Option<Value> {
        self.nested("modelThinkingLevels", &format!("{provider}/{model}"))
            .cloned()
    }

    pub fn all_model_thinking_levels(&self) -> Map<String, Value> {
        match self.top("modelThinkingLevels") {
            Some(Value::Object(levels)) => levels.clone(),
            _ => Map::new(),
        }
    }

    pub fn set_model_thinking_level(&mut self, provider: &str, model: &str, level: &str) {
        let levels = self
            .global
            .entry("modelThinkingLevels")
            .or_insert_with(|| Value::Object(Map::new()));
        if !truthy(Some(levels)) || !levels.is_object() {
            *levels = Value::Object(Map::new());
        }
        levels
            .as_object_mut()
            .expect("an object")
            .insert(format!("{provider}/{model}"), json!(level));
        self.modified.mark("modelThinkingLevels", None);
        self.save();
    }

    pub fn remove_model_thinking_level(&mut self, provider: &str, model: &str) {
        let Some(Value::Object(levels)) = self.global.get_mut("modelThinkingLevels") else {
            return;
        };
        levels.shift_remove(&format!("{provider}/{model}"));
        if levels.is_empty() {
            self.global.shift_remove("modelThinkingLevels");
        }
        self.modified.mark("modelThinkingLevels", None);
        self.save();
    }

    pub fn transport(&self) -> Value {
        or(self.top("transport"), json!("auto"))
    }

    pub fn set_transport(&mut self, transport: &str) {
        self.set("transport", Some(json!(transport)));
    }

    pub fn compaction_enabled(&self) -> bool {
        flag(self.nested("compaction", "enabled"), true)
    }

    pub fn harness_core_settings(&self) -> HarnessCoreSettings {
        let get = |key: &str| self.nested("harnessCore", key);
        HarnessCoreSettings {
            alignment: flag(get("alignment"), true),
            authorization_gate: flag(get("authorizationGate"), true),
            scope_guard: flag(get("scopeGuard"), true),
            evidence: flag(get("evidence"), true),
            context: flag(get("context"), true),
            context_keep_recent: or(get("contextKeepRecent"), json!(6)),
            context_batch_size: or(get("contextBatchSize"), json!(6)),
            verify_commands: list(get("verifyCommands"))
                .into_iter()
                .filter_map(|command| command.as_str().map(str::to_string))
                .collect(),
            max_changed_lines: or(get("maxChangedLines"), json!(500)),
            max_file_lines: or(get("maxFileLines"), json!(1000)),
        }
    }

    /// Changes one harness setting after checking it (`setHarnessCoreSetting`).
    pub fn set_harness_core_setting(&mut self, key: &str, value: Value) -> Result<(), String> {
        if let Some(problem) = harness_setting_problem(key, &value) {
            return Err(problem);
        }
        let mut harness = match self.global.get("harnessCore") {
            Some(Value::Object(harness)) => harness.clone(),
            _ => Map::new(),
        };
        harness.insert(key.to_string(), value);
        self.global
            .insert("harnessCore".into(), Value::Object(harness));
        self.modified.mark("harnessCore", Some(key));
        self.save();
        Ok(())
    }

    pub fn set_compaction_enabled(&mut self, enabled: bool) {
        self.set_nested("compaction", "enabled", json!(enabled));
    }

    /// A compaction token setting: the model's override, the ordinary setting, the default
    /// (`getCompactionTokenSetting`).
    fn compaction_token_setting(
        &self,
        field: &str,
        model: Option<ModelKey<'_>>,
        fallback: f64,
    ) -> Result<f64, String> {
        let valid = |value: &Value| {
            value.as_f64().is_some_and(|number| {
                number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER && number >= 0.0
            })
        };
        let ordinary = self.nested("compaction", field);
        if let Some(value) = ordinary {
            if !valid(value) {
                return Err(format!(
                    "Invalid compaction.{field} setting: {}. Expected a non-negative safe integer.",
                    js_string(value)
                ));
            }
        }
        let key = model.map(|(provider, id)| format!("{provider}/{id}"));
        let entry = key.as_ref().and_then(|key| {
            self.nested("compaction", "modelOverrides")?
                .as_object()?
                .get(key)
        });
        let key = key.unwrap_or_default();
        if let Some(entry) = entry {
            if !entry.is_object() {
                return Err(format!(
                    "Invalid compaction.modelOverrides[\"{key}\"] setting: {}. Expected an object.",
                    js_string(entry)
                ));
            }
        }
        let override_value = entry.and_then(|entry| entry.get(field));
        if let Some(value) = override_value {
            if !valid(value) {
                return Err(format!(
                    "Invalid compaction.modelOverrides[\"{key}\"].{field} setting: {}. Expected a non-negative safe integer.",
                    js_string(value)
                ));
            }
        }
        Ok(override_value
            .or(ordinary)
            .and_then(Value::as_f64)
            .unwrap_or(fallback))
    }

    pub fn compaction_reserve_tokens(&self, model: Option<ModelKey<'_>>) -> Result<f64, String> {
        self.compaction_token_setting("reserveTokens", model, DEFAULT_RESERVE_TOKENS)
    }

    pub fn compaction_keep_recent_tokens(
        &self,
        model: Option<ModelKey<'_>>,
    ) -> Result<f64, String> {
        self.compaction_token_setting("keepRecentTokens", model, DEFAULT_KEEP_RECENT_TOKENS)
    }

    pub fn compaction_settings(
        &self,
        model: Option<ModelKey<'_>>,
    ) -> Result<CompactionSettings, String> {
        Ok(CompactionSettings {
            enabled: self.compaction_enabled(),
            reserve_tokens: self.compaction_reserve_tokens(model)?,
            keep_recent_tokens: self.compaction_keep_recent_tokens(model)?,
        })
    }

    /// `{ reserveTokens, skipPrompt }` (`getBranchSummarySettings`).
    pub fn branch_summary_settings(&self) -> Value {
        json!({
            "reserveTokens": or(self.nested("branchSummary", "reserveTokens"), json!(16384)),
            "skipPrompt": flag(self.nested("branchSummary", "skipPrompt"), false),
        })
    }

    pub fn branch_summary_skip_prompt(&self) -> bool {
        flag(self.nested("branchSummary", "skipPrompt"), false)
    }

    pub fn retry_enabled(&self) -> bool {
        flag(self.nested("retry", "enabled"), true)
    }

    pub fn set_retry_enabled(&mut self, enabled: bool) {
        self.set_nested("retry", "enabled", json!(enabled));
    }

    /// `{ enabled, maxRetries, baseDelayMs, maxAgentDelayMs }` (`getRetrySettings`).
    pub fn retry_settings(&self) -> Value {
        json!({
            "enabled": self.retry_enabled(),
            "maxRetries": or(self.nested("retry", "maxRetries"), json!(3)),
            "baseDelayMs": or(self.nested("retry", "baseDelayMs"), json!(2000)),
            "maxAgentDelayMs": or(
                self.nested("retry", "maxAgentDelayMs"),
                relay_ai::json::js_number(DEFAULT_MAX_AGENT_RETRY_DELAY_MS),
            ),
        })
    }

    pub fn http_idle_timeout_ms(&self) -> Result<f64, String> {
        Ok(
            parse_timeout_setting(self.top("httpIdleTimeoutMs"), "httpIdleTimeoutMs")?
                .unwrap_or(DEFAULT_HTTP_IDLE_TIMEOUT_MS),
        )
    }

    pub fn set_http_idle_timeout_ms(&mut self, timeout_ms: f64) -> Result<(), String> {
        if !timeout_ms.is_finite() || timeout_ms < 0.0 {
            return Err(format!(
                "Invalid httpIdleTimeoutMs setting: {}",
                relay_ai::text::js_number_to_string(timeout_ms)
            ));
        }
        self.set(
            "httpIdleTimeoutMs",
            Some(relay_ai::json::js_number(timeout_ms.floor())),
        );
        Ok(())
    }

    /// The cache warming mode, from the global settings only: warming costs money
    /// (`getCacheWarmingMode`).
    pub fn cache_warming_mode(&self) -> &'static str {
        let mode = self.global.get("cacheWarming").and_then(Value::as_str);
        CACHE_WARMING_MODES
            .into_iter()
            .find(|candidate| Some(*candidate) == mode)
            .unwrap_or("streaming")
    }

    pub fn set_cache_warming_mode(&mut self, mode: &str) {
        self.set("cacheWarming", Some(json!(mode)));
    }

    /// `{ timeoutMs?, maxRetries?, maxRetryDelayMs }` (`getProviderRetrySettings`).
    pub fn provider_retry_settings(&self) -> Value {
        let provider = self.nested("retry", "provider").and_then(Value::as_object);
        let get = |key: &str| provider.and_then(|provider| provider.get(key));
        let mut settings = Map::new();
        if let Some(timeout) = get("timeoutMs") {
            settings.insert("timeoutMs".into(), timeout.clone());
        }
        if let Some(retries) = get("maxRetries") {
            settings.insert("maxRetries".into(), retries.clone());
        }
        settings.insert(
            "maxRetryDelayMs".into(),
            or(get("maxRetryDelayMs"), json!(60000)),
        );
        Value::Object(settings)
    }

    pub fn websocket_connect_timeout_ms(&self) -> Result<Option<f64>, String> {
        parse_timeout_setting(
            self.top("websocketConnectTimeoutMs"),
            "websocketConnectTimeoutMs",
        )
    }

    pub fn hide_thinking_block(&self) -> bool {
        flag(self.top("hideThinkingBlock"), false)
    }

    pub fn set_hide_thinking_block(&mut self, hide: bool) {
        self.set("hideThinkingBlock", Some(json!(hide)));
    }

    pub fn show_cache_miss_notices(&self) -> bool {
        flag(self.top("showCacheMissNotices"), false)
    }

    pub fn set_show_cache_miss_notices(&mut self, show: bool) {
        self.set("showCacheMissNotices", Some(json!(show)));
    }

    /// The external editor: the setting, then `VISUAL` or `EDITOR`, then the platform's
    /// (`getExternalEditorCommand`).
    pub fn external_editor_command(&self) -> String {
        if let Some(editor) = self.top("externalEditor").and_then(Value::as_str) {
            if !relay_ai::text::js_trim(editor).is_empty() {
                return editor.to_string();
            }
        }
        let variable = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        if let Some(editor) = variable("VISUAL").or_else(|| variable("EDITOR")) {
            return editor;
        }
        if cfg!(windows) { "notepad" } else { "nano" }.to_string()
    }

    pub fn shell_path(&self) -> Option<Value> {
        self.path_setting("shellPath")
    }

    pub fn set_shell_path(&mut self, path: Option<&str>) {
        self.set("shellPath", path.map(|path| json!(path)));
    }

    /// `true`, `"header"` or `false` (`getQuietStartup`).
    pub fn quiet_startup(&self) -> Value {
        match self.top("quietStartup") {
            Some(Value::Bool(true)) => json!(true),
            Some(Value::String(text)) if text == "header" => json!("header"),
            _ => json!(false),
        }
    }

    pub fn set_quiet_startup(&mut self, quiet: Value) {
        self.set("quietStartup", Some(quiet));
    }

    /// From the global settings only (`getDefaultProjectTrust`).
    pub fn default_project_trust(&self) -> &'static str {
        match self
            .global
            .get("defaultProjectTrust")
            .and_then(Value::as_str)
        {
            Some("always") => "always",
            Some("never") => "never",
            _ => "ask",
        }
    }

    pub fn set_default_project_trust(&mut self, trust: &str) {
        self.set("defaultProjectTrust", Some(json!(trust)));
    }

    pub fn shell_command_prefix(&self) -> Option<Value> {
        self.top("shellCommandPrefix").cloned()
    }

    pub fn set_shell_command_prefix(&mut self, prefix: Option<&str>) {
        self.set("shellCommandPrefix", prefix.map(|prefix| json!(prefix)));
    }

    pub fn npm_command(&self) -> Option<Vec<Value>> {
        let value = self.top("npmCommand");
        truthy(value).then(|| list(value))
    }

    pub fn set_npm_command(&mut self, command: Option<Vec<String>>) {
        self.set("npmCommand", command.map(|command| json!(command)));
    }

    pub fn collapse_changelog(&self) -> bool {
        flag(self.top("collapseChangelog"), false)
    }

    pub fn set_collapse_changelog(&mut self, collapse: bool) {
        self.set("collapseChangelog", Some(json!(collapse)));
    }

    pub fn enable_install_telemetry(&self) -> bool {
        flag(self.top("enableInstallTelemetry"), true)
    }

    pub fn set_enable_install_telemetry(&mut self, enabled: bool) {
        self.set("enableInstallTelemetry", Some(json!(enabled)));
    }

    pub fn enable_analytics(&self) -> bool {
        flag(self.top("enableAnalytics"), false)
    }

    pub fn tracking_id(&self) -> Option<Value> {
        self.top("trackingId").cloned()
    }

    /// Sets the analytics opt-in; the first opt-in creates a tracking id (`setEnableAnalytics`).
    pub fn set_enable_analytics(&mut self, enabled: bool) {
        self.global.insert("enableAnalytics".into(), json!(enabled));
        self.modified.mark("enableAnalytics", None);
        if enabled && !truthy(self.global.get("trackingId")) {
            self.global
                .insert("trackingId".into(), json!(random_uuid()));
            self.modified.mark("trackingId", None);
        }
        self.save();
    }

    /// This installation's id, created on first use in the global settings only
    /// (`getOrCreateDeviceId`).
    pub fn get_or_create_device_id(&mut self) -> Value {
        if !truthy(self.global.get("deviceId")) {
            self.global.insert("deviceId".into(), json!(random_uuid()));
            self.modified.mark("deviceId", None);
            self.save();
        }
        self.global.get("deviceId").cloned().unwrap_or_default()
    }

    pub fn packages(&self) -> Vec<Value> {
        list(self.top("packages"))
    }

    pub fn set_packages(&mut self, packages: Vec<Value>) {
        self.set("packages", Some(Value::Array(packages)));
    }

    pub fn set_project_packages(&mut self, packages: Vec<Value>) -> Result<(), String> {
        self.update_project("packages", Value::Array(packages))
    }

    pub fn extension_paths(&self) -> Vec<Value> {
        list(self.top("extensions"))
    }

    pub fn set_extension_paths(&mut self, paths: Vec<String>) {
        self.set("extensions", Some(json!(paths)));
    }

    pub fn set_project_extension_paths(&mut self, paths: Vec<String>) -> Result<(), String> {
        self.update_project("extensions", json!(paths))
    }

    pub fn skill_paths(&self) -> Vec<Value> {
        list(self.top("skills"))
    }

    pub fn set_skill_paths(&mut self, paths: Vec<String>) {
        self.set("skills", Some(json!(paths)));
    }

    pub fn set_project_skill_paths(&mut self, paths: Vec<String>) -> Result<(), String> {
        self.update_project("skills", json!(paths))
    }

    pub fn prompt_template_paths(&self) -> Vec<Value> {
        list(self.top("prompts"))
    }

    pub fn set_prompt_template_paths(&mut self, paths: Vec<String>) {
        self.set("prompts", Some(json!(paths)));
    }

    pub fn set_project_prompt_template_paths(&mut self, paths: Vec<String>) -> Result<(), String> {
        self.update_project("prompts", json!(paths))
    }

    pub fn theme_paths(&self) -> Vec<Value> {
        list(self.top("themes"))
    }

    pub fn set_theme_paths(&mut self, paths: Vec<String>) {
        self.set("themes", Some(json!(paths)));
    }

    pub fn set_project_theme_paths(&mut self, paths: Vec<String>) -> Result<(), String> {
        self.update_project("themes", json!(paths))
    }

    pub fn enable_skill_commands(&self) -> bool {
        flag(self.top("enableSkillCommands"), true)
    }

    pub fn set_enable_skill_commands(&mut self, enabled: bool) {
        self.set("enableSkillCommands", Some(json!(enabled)));
    }

    pub fn thinking_budgets(&self) -> Option<Value> {
        self.top("thinkingBudgets").cloned()
    }

    /// The terminal capabilities the settings force (`getTerminalCapabilityOverrides`).
    pub fn terminal_capability_overrides(&self) -> Value {
        let mut overrides = Map::new();
        match self.nested("terminal", "images") {
            Some(Value::String(images)) if images == "kitty" || images == "iterm2" => {
                overrides.insert("images".into(), json!(images));
            }
            Some(Value::Bool(false)) => {
                overrides.insert("images".into(), Value::Null);
            }
            _ => {}
        }
        if let Some(Value::Bool(true_color)) = self.nested("terminal", "trueColor") {
            overrides.insert("trueColor".into(), json!(true_color));
        }
        if let Some(Value::Bool(hyperlinks)) = self.nested("terminal", "hyperlinks") {
            overrides.insert("hyperlinks".into(), json!(hyperlinks));
        }
        Value::Object(overrides)
    }

    pub fn show_images(&self) -> bool {
        flag(self.nested("terminal", "showImages"), true)
    }

    pub fn set_show_images(&mut self, show: bool) {
        self.set_nested("terminal", "showImages", json!(show));
    }

    pub fn image_width_cells(&self) -> f64 {
        match self
            .nested("terminal", "imageWidthCells")
            .and_then(Value::as_f64)
        {
            Some(width) if width.is_finite() => width.floor().max(1.0),
            _ => 60.0,
        }
    }

    pub fn set_image_width_cells(&mut self, width: f64) {
        self.set_nested(
            "terminal",
            "imageWidthCells",
            relay_ai::json::js_number(width.floor().max(1.0)),
        );
    }

    /// The setting, else `RELAY_CLEAR_ON_SHRINK=1` (`getClearOnShrink`).
    pub fn clear_on_shrink(&self) -> bool {
        match self.nested("terminal", "clearOnShrink") {
            Some(value) => truthy(Some(value)),
            None => std::env::var("RELAY_CLEAR_ON_SHRINK").is_ok_and(|value| value == "1"),
        }
    }

    pub fn set_clear_on_shrink(&mut self, enabled: bool) {
        self.set_nested("terminal", "clearOnShrink", json!(enabled));
    }

    pub fn show_terminal_progress(&self) -> bool {
        flag(self.nested("terminal", "showTerminalProgress"), false)
    }

    pub fn set_show_terminal_progress(&mut self, enabled: bool) {
        self.set_nested("terminal", "showTerminalProgress", json!(enabled));
    }

    pub fn tui_mode(&self) -> &'static str {
        if self.top("tuiMode").and_then(Value::as_str) == Some("regular") {
            "regular"
        } else {
            "fullscreen"
        }
    }

    pub fn set_tui_mode(&mut self, mode: &str) {
        self.set("tuiMode", Some(json!(mode)));
    }

    pub fn fullscreen_exit_output(&self) -> &'static str {
        if self.top("fullscreenExitOutput").and_then(Value::as_str) == Some("resume-hint") {
            "resume-hint"
        } else {
            "transcript"
        }
    }

    pub fn set_fullscreen_exit_output(&mut self, output: &str) {
        self.set("fullscreenExitOutput", Some(json!(output)));
    }

    pub fn fullscreen_scrollbar(&self) -> &'static str {
        match self.top("fullscreenScrollbar").and_then(Value::as_str) {
            Some("always") => "always",
            Some("hidden") => "hidden",
            _ => "auto",
        }
    }

    pub fn set_fullscreen_scrollbar(&mut self, mode: &str) {
        self.set("fullscreenScrollbar", Some(json!(mode)));
    }

    pub fn fullscreen_copy_on_select(&self) -> bool {
        flag(self.top("fullscreenCopyOnSelect"), true)
    }

    pub fn set_fullscreen_copy_on_select(&mut self, enabled: bool) {
        self.set("fullscreenCopyOnSelect", Some(json!(enabled)));
    }

    /// Lines per wheel event, 1 to 100, or `"auto"` (`getFullscreenWheelScrollLines`).
    pub fn fullscreen_wheel_scroll_lines(&self) -> Value {
        match self
            .top("fullscreenWheelScrollLines")
            .and_then(Value::as_f64)
        {
            Some(lines) if lines.is_finite() => {
                relay_ai::json::js_number(lines.floor().clamp(1.0, 100.0))
            }
            _ => json!("auto"),
        }
    }

    pub fn set_fullscreen_wheel_scroll_lines(&mut self, lines: Value) {
        let value = match lines.as_f64() {
            Some(lines) => relay_ai::json::js_number(lines.floor().clamp(1.0, 100.0)),
            None => json!("auto"),
        };
        self.set("fullscreenWheelScrollLines", Some(value));
    }

    pub fn image_auto_resize(&self) -> bool {
        flag(self.nested("images", "autoResize"), true)
    }

    pub fn set_image_auto_resize(&mut self, enabled: bool) {
        self.set_nested("images", "autoResize", json!(enabled));
    }

    pub fn block_images(&self) -> bool {
        flag(self.nested("images", "blockImages"), false)
    }

    pub fn set_block_images(&mut self, blocked: bool) {
        self.set_nested("images", "blockImages", json!(blocked));
    }

    pub fn enabled_models(&self) -> Option<Value> {
        self.top("enabledModels").cloned()
    }

    pub fn set_enabled_models(&mut self, patterns: Option<Vec<String>>) {
        self.set("enabledModels", patterns.map(|patterns| json!(patterns)));
    }

    /// The resolved `defaultTools` selection, or `None` when no layer sets it (`getDefaultTools`).
    pub fn default_tools(&self) -> Option<Vec<String>> {
        let tools = self.top("defaultTools")?;
        let entries: Vec<String> = match tools {
            Value::Array(items) => items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect(),
            _ => Vec::new(),
        };
        Some(resolve_default_tools(&entries))
    }

    pub fn double_escape_action(&self) -> Value {
        or(self.top("doubleEscapeAction"), json!("tree"))
    }

    pub fn set_double_escape_action(&mut self, action: &str) {
        self.set("doubleEscapeAction", Some(json!(action)));
    }

    pub fn tree_filter_mode(&self) -> &'static str {
        let mode = self.top("treeFilterMode").and_then(Value::as_str);
        TREE_FILTER_MODES
            .into_iter()
            .find(|candidate| Some(*candidate) == mode)
            .unwrap_or("default")
    }

    pub fn set_tree_filter_mode(&mut self, mode: &str) {
        self.set("treeFilterMode", Some(json!(mode)));
    }

    /// The setting, else `RELAY_HARDWARE_CURSOR=1` (`getShowHardwareCursor`).
    pub fn show_hardware_cursor(&self) -> bool {
        match self
            .top("showHardwareCursor")
            .filter(|value| !value.is_null())
        {
            Some(value) => truthy(Some(value)),
            None => std::env::var("RELAY_HARDWARE_CURSOR").is_ok_and(|value| value == "1"),
        }
    }

    pub fn set_show_hardware_cursor(&mut self, enabled: bool) {
        self.set("showHardwareCursor", Some(json!(enabled)));
    }

    pub fn editor_padding_x(&self) -> Value {
        or(self.top("editorPaddingX"), json!(0))
    }

    pub fn set_editor_padding_x(&mut self, padding: f64) {
        self.set(
            "editorPaddingX",
            Some(relay_ai::json::js_number(padding.floor().clamp(0.0, 3.0))),
        );
    }

    pub fn output_pad(&self) -> u8 {
        u8::from(self.top("outputPad").and_then(Value::as_f64) != Some(0.0))
    }

    pub fn set_output_pad(&mut self, padding: u8) {
        self.set("outputPad", Some(json!(padding)));
    }

    pub fn autocomplete_max_visible(&self) -> Value {
        or(self.top("autocompleteMaxVisible"), json!(5))
    }

    pub fn set_autocomplete_max_visible(&mut self, max_visible: f64) {
        self.set(
            "autocompleteMaxVisible",
            Some(relay_ai::json::js_number(
                max_visible.floor().clamp(3.0, 20.0),
            )),
        );
    }

    pub fn code_block_indent(&self) -> Value {
        or(self.nested("markdown", "codeBlockIndent"), json!("  "))
    }

    pub fn mermaid_rendering_mode(&self) -> &'static str {
        match self.nested("markdown", "mermaid").and_then(Value::as_str) {
            Some("off") => "off",
            Some("final") => "final",
            _ => "streaming",
        }
    }

    pub fn set_mermaid_rendering_mode(&mut self, mode: &str) {
        self.set_nested("markdown", "mermaid", json!(mode));
    }

    pub fn warnings(&self) -> Map<String, Value> {
        match self.top("warnings") {
            Some(Value::Object(warnings)) => warnings.clone(),
            _ => Map::new(),
        }
    }

    pub fn set_warnings(&mut self, warnings: Map<String, Value>) {
        self.set("warnings", Some(Value::Object(warnings)));
    }
}
