//! Merging settings layers and migrating old settings (`settings-manager.ts`): later layers win,
//! nested objects merge key by key, and a `defaultTools` list of only `+name` and `-name` entries
//! extends the inherited one instead of replacing it.

use serde_json::{json, Map, Value};

/// Tools enabled at startup when `defaultTools` does not change them (`DEFAULT_TOOL_NAMES`).
pub const DEFAULT_TOOL_NAMES: [&str; 4] = ["read", "bash", "edit", "write"];

pub type Settings = Map<String, Value>;

/// `{ ...base }` with each override key replacing or, for two objects, merging into the base
/// (`deepMergeObjects`).
pub fn deep_merge_objects(base: &Settings, overrides: &Settings) -> Settings {
    let mut result = base.clone();
    for (key, value) in overrides {
        let merged = match (base.get(key), value) {
            (Some(Value::Object(base)), Value::Object(value)) => {
                Value::Object(deep_merge_objects(base, value))
            }
            _ => value.clone(),
        };
        result.insert(key.clone(), merged);
    }
    result
}

fn is_tool_modifier(entry: &Value) -> bool {
    entry
        .as_str()
        .is_some_and(|entry| entry.starts_with('+') || entry.starts_with('-'))
}

/// `defaultTools` of two layers (`mergeDefaultTools`): a list of only modifiers is appended,
/// anything else replaces.
fn merge_default_tools(base: Option<&Value>, overrides: Option<&Value>) -> Option<Value> {
    let Some(overrides) = overrides else {
        return base.cloned();
    };
    match (base, overrides) {
        (Some(Value::Array(base)), Value::Array(items)) if items.iter().all(is_tool_modifier) => {
            Some(Value::Array(base.iter().chain(items).cloned().collect()))
        }
        _ => Some(overrides.clone()),
    }
}

/// The merged settings (`deepMergeSettings`).
pub fn deep_merge_settings(base: &Settings, overrides: &Settings) -> Settings {
    let mut merged = deep_merge_objects(base, overrides);
    if let Some(tools) =
        merge_default_tools(base.get("defaultTools"), overrides.get("defaultTools"))
    {
        merged.insert("defaultTools".into(), tools);
    }
    merged
}

/// A merged `defaultTools` list as a selection (`resolveDefaultTools`): plain names replace the
/// defaults, then `+name` adds and `-name` removes a tool in list order.
pub fn resolve_default_tools(entries: &[String]) -> Vec<String> {
    let is_modifier = |entry: &str| entry.starts_with('+') || entry.starts_with('-');
    let plain: Vec<String> = entries
        .iter()
        .filter(|entry| !is_modifier(entry))
        .cloned()
        .collect();
    let mut tools = if !plain.is_empty() || entries.is_empty() {
        plain
    } else {
        DEFAULT_TOOL_NAMES
            .iter()
            .map(|name| name.to_string())
            .collect()
    };
    for entry in entries.iter().filter(|entry| is_modifier(entry)) {
        let name = &entry[1..];
        let index = tools.iter().position(|tool| tool == name);
        match (entry.starts_with('+'), index) {
            (true, None) if !name.is_empty() => tools.push(name.to_string()),
            (false, Some(index)) => {
                tools.remove(index);
            }
            _ => {}
        }
    }
    tools
}

/// Old settings in today's form (`migrateSettings`): `queueMode` is `steeringMode`, the
/// `websockets` switch is `transport`, the `skills` object is a list and `enableSkillCommands`,
/// and `retry.maxDelayMs` is `retry.provider.maxRetryDelayMs`.
pub fn migrate_settings(settings: &mut Settings) {
    if settings.contains_key("queueMode") && !settings.contains_key("steeringMode") {
        let mode = settings.get("queueMode").cloned().unwrap_or(Value::Null);
        settings.insert("steeringMode".into(), mode);
        settings.shift_remove("queueMode");
    }
    if !settings.contains_key("transport") {
        if let Some(Value::Bool(websockets)) = settings.get("websockets") {
            let transport = if *websockets { "websocket" } else { "sse" };
            settings.insert("transport".into(), json!(transport));
            settings.shift_remove("websockets");
        }
    }
    if let Some(Value::Object(skills)) = settings.get("skills").cloned() {
        let enable = skills.get("enableSkillCommands");
        if enable.is_some() && settings.get("enableSkillCommands").is_none() {
            settings.insert(
                "enableSkillCommands".into(),
                enable.cloned().unwrap_or(Value::Null),
            );
        }
        match skills.get("customDirectories") {
            Some(Value::Array(directories)) if !directories.is_empty() => {
                settings.insert("skills".into(), Value::Array(directories.clone()));
            }
            _ => {
                settings.shift_remove("skills");
            }
        }
    }
    if let Some(Value::Object(retry)) = settings.get_mut("retry") {
        let provider = match retry.get("provider") {
            Some(Value::Object(provider)) => Some(provider.clone()),
            _ => None,
        };
        let delay_unset = provider
            .as_ref()
            .and_then(|provider| provider.get("maxRetryDelayMs"))
            .is_none_or(Value::is_null);
        if let (Some(Value::Number(delay)), true) = (retry.get("maxDelayMs").cloned(), delay_unset)
        {
            let mut provider = provider.unwrap_or_default();
            provider.insert("maxRetryDelayMs".into(), Value::Number(delay));
            retry.insert("provider".into(), Value::Object(provider));
        }
        retry.shift_remove("maxDelayMs");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn modifiers_change_the_defaults() {
        assert_eq!(
            resolve_default_tools(&strings(&["+ls", "-bash"])),
            strings(&["read", "edit", "write", "ls"])
        );
        assert_eq!(
            resolve_default_tools(&strings(&["grep", "+ls"])),
            strings(&["grep", "ls"])
        );
        assert!(resolve_default_tools(&[]).is_empty());
    }
}
