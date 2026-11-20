//! Replays `crates/fixtures/settings/`, what the TypeScript settings manager did
//! (`packages/coding-agent/test/parity/settings-record.ts`): files loaded with every getter's
//! answer, and setter calls with the files they wrote. Outputs are compared as serialized JSON,
//! so key order counts.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

use relay_ai::json::js_number;
use relay_settings::{SettingsError, SettingsManager};
use serde_json::{json, Map, Value};

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/settings")
        .join(name);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn differences(label: &str, expected: &Value, actual: &Value, failures: &mut Vec<String>) {
    let expected = expected.to_string();
    let actual = actual.to_string();
    if expected != actual {
        failures.push(format!(
            "{label}\n    expected {expected}\n    actual   {actual}"
        ));
    }
}

/// The environment the recorder fixes: `VISUAL` set, the others unset.
fn environment() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        for name in ["EDITOR", "RELAY_CLEAR_ON_SHRINK", "RELAY_HARDWARE_CURSOR"] {
            std::env::remove_var(name);
        }
        std::env::set_var("VISUAL", "visual-editor");
    });
}

/// The recorder's directories: the root, the agent directory and the project.
struct Layout {
    root: PathBuf,
}

impl Layout {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "relay-settings-{}-{nanos}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(root.join("project")).unwrap();
        Layout { root }
    }

    fn agent_dir(&self) -> String {
        self.root.join("agent").to_string_lossy().into_owned()
    }

    fn cwd(&self) -> String {
        self.root.join("project").to_string_lossy().into_owned()
    }

    fn global_path(&self) -> PathBuf {
        self.root.join("agent").join("settings.json")
    }

    fn project_path(&self) -> PathBuf {
        self.root
            .join("project")
            .join(".relay")
            .join("settings.json")
    }

    fn path(&self, scope: &str) -> PathBuf {
        if scope == "global" {
            self.global_path()
        } else {
            self.project_path()
        }
    }

    fn write(&self, path: &Path, content: Option<&str>) {
        if let Some(content) = content {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
    }
}

impl Drop for Layout {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn is_uuid_v4(text: &[u8]) -> bool {
    let hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
    text.len() == 36
        && text.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => *byte == b'4',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => hex(*byte),
        })
}

/// The recorder's `portable`: `<root>`, `<home>`, `/` after them, `<uuid>`.
fn portable(value: &Value, root: &str) -> Value {
    match value {
        Value::String(text) => {
            let home = relay_tools::paths::home_dir().unwrap_or_default();
            let replaced = text.replace(root, "<root>").replace(&home, "<home>");
            let mut out = String::new();
            let mut rest = replaced.as_str();
            while let Some(index) = rest.find('<') {
                let tail = &rest[index..];
                out.push_str(&rest[..index]);
                match ["<root>", "<home>"]
                    .into_iter()
                    .find(|tag| tail.starts_with(tag))
                {
                    Some(tag) => {
                        let end = tail
                            .find(|character: char| {
                                matches!(character, '"' | '\'') || character.is_whitespace()
                            })
                            .unwrap_or(tail.len())
                            .max(tag.len());
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
            let bytes = out.as_bytes();
            let mut result = String::new();
            let mut at = 0;
            let mut copied = 0;
            while at + 36 <= bytes.len() {
                if is_uuid_v4(&bytes[at..at + 36]) {
                    result.push_str(&out[copied..at]);
                    result.push_str("<uuid>");
                    at += 36;
                    copied = at;
                } else {
                    at += 1;
                }
            }
            result.push_str(&out[copied..]);
            Value::String(result)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| portable(item, root)).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(name, item)| (name.clone(), portable(item, root)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn errors_json(errors: &[SettingsError]) -> Value {
    Value::Array(
        errors
            .iter()
            .map(|error| {
                let mut object = Map::new();
                object.insert("scope".into(), json!(error.scope.name()));
                if let Some(path) = &error.path {
                    object.insert("path".into(), json!(path));
                }
                if error.syntax {
                    object.insert("syntaxError".into(), json!(true));
                } else {
                    object.insert("message".into(), json!(error.message));
                }
                Value::Object(object)
            })
            .collect(),
    )
}

fn undefined() -> Value {
    json!("<undefined>")
}

fn optional(value: Option<Value>) -> Value {
    value.unwrap_or_else(undefined)
}

fn text_arg(args: &[Value], index: usize) -> String {
    args[index].as_str().unwrap().to_string()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_string())
        .collect()
}

/// A getter's answer by its TypeScript name.
fn get(manager: &SettingsManager, name: &str, args: &[Value]) -> Result<Value, String> {
    let model = args.first().filter(|model| model.is_object()).map(|model| {
        (
            model["provider"].as_str().unwrap().to_string(),
            model["id"].as_str().unwrap().to_string(),
        )
    });
    let model = model
        .as_ref()
        .map(|(provider, id)| (provider.as_str(), id.as_str()));
    Ok(match name {
        "getLastChangelogVersion" => optional(manager.last_changelog_version()),
        "getSessionDir" => optional(manager.session_dir()),
        "getDefaultProvider" => optional(manager.default_provider()),
        "getDefaultModel" => optional(manager.default_model()),
        "getSteeringMode" => manager.steering_mode(),
        "getFollowUpMode" => manager.follow_up_mode(),
        "getThemeSetting" => optional(manager.theme_setting().map(Value::String)),
        "getTheme" => optional(manager.theme().map(Value::String)),
        "getDefaultThinkingLevel" => optional(manager.default_thinking_level()),
        "getModelThinkingLevel" => {
            optional(manager.model_thinking_level(&text_arg(args, 0), &text_arg(args, 1)))
        }
        "getAllModelThinkingLevels" => Value::Object(manager.all_model_thinking_levels()),
        "getTransport" => manager.transport(),
        "getCompactionEnabled" => json!(manager.compaction_enabled()),
        "getHarnessCoreSettings" => json!(manager.harness_core_settings()),
        "getCompactionReserveTokens" => js_number(manager.compaction_reserve_tokens(model)?),
        "getCompactionKeepRecentTokens" => js_number(manager.compaction_keep_recent_tokens(model)?),
        "getCompactionSettings" => json!(manager.compaction_settings(model)?),
        "getBranchSummarySettings" => manager.branch_summary_settings(),
        "getBranchSummarySkipPrompt" => json!(manager.branch_summary_skip_prompt()),
        "getRetryEnabled" => json!(manager.retry_enabled()),
        "getRetrySettings" => manager.retry_settings(),
        "getHttpIdleTimeoutMs" => js_number(manager.http_idle_timeout_ms()?),
        "getCacheWarmingMode" => json!(manager.cache_warming_mode()),
        "getProviderRetrySettings" => manager.provider_retry_settings(),
        "getWebSocketConnectTimeoutMs" => {
            optional(manager.websocket_connect_timeout_ms()?.map(js_number))
        }
        "getHideThinkingBlock" => json!(manager.hide_thinking_block()),
        "getShowCacheMissNotices" => json!(manager.show_cache_miss_notices()),
        "getExternalEditorCommand" => json!(manager.external_editor_command()),
        "getShellPath" => optional(manager.shell_path()),
        "getQuietStartup" => manager.quiet_startup(),
        "getDefaultProjectTrust" => json!(manager.default_project_trust()),
        "getShellCommandPrefix" => optional(manager.shell_command_prefix()),
        "getNpmCommand" => optional(manager.npm_command().map(Value::Array)),
        "getCollapseChangelog" => json!(manager.collapse_changelog()),
        "getEnableInstallTelemetry" => json!(manager.enable_install_telemetry()),
        "getEnableAnalytics" => json!(manager.enable_analytics()),
        "getTrackingId" => optional(manager.tracking_id()),
        "getPackages" => Value::Array(manager.packages()),
        "getExtensionPaths" => Value::Array(manager.extension_paths()),
        "getSkillPaths" => Value::Array(manager.skill_paths()),
        "getPromptTemplatePaths" => Value::Array(manager.prompt_template_paths()),
        "getThemePaths" => Value::Array(manager.theme_paths()),
        "getEnableSkillCommands" => json!(manager.enable_skill_commands()),
        "getThinkingBudgets" => optional(manager.thinking_budgets()),
        "getTerminalCapabilityOverrides" => manager.terminal_capability_overrides(),
        "getShowImages" => json!(manager.show_images()),
        "getImageWidthCells" => js_number(manager.image_width_cells()),
        "getClearOnShrink" => json!(manager.clear_on_shrink()),
        "getShowTerminalProgress" => json!(manager.show_terminal_progress()),
        "getTuiMode" => json!(manager.tui_mode()),
        "getFullscreenExitOutput" => json!(manager.fullscreen_exit_output()),
        "getFullscreenScrollbar" => json!(manager.fullscreen_scrollbar()),
        "getFullscreenCopyOnSelect" => json!(manager.fullscreen_copy_on_select()),
        "getFullscreenWheelScrollLines" => manager.fullscreen_wheel_scroll_lines(),
        "getImageAutoResize" => json!(manager.image_auto_resize()),
        "getBlockImages" => json!(manager.block_images()),
        "getEnabledModels" => optional(manager.enabled_models()),
        "getDefaultTools" => optional(manager.default_tools().map(|tools| json!(tools))),
        "getDoubleEscapeAction" => manager.double_escape_action(),
        "getTreeFilterMode" => json!(manager.tree_filter_mode()),
        "getShowHardwareCursor" => json!(manager.show_hardware_cursor()),
        "getEditorPaddingX" => manager.editor_padding_x(),
        "getOutputPad" => json!(manager.output_pad()),
        "getAutocompleteMaxVisible" => manager.autocomplete_max_visible(),
        "getCodeBlockIndent" => manager.code_block_indent(),
        "getMermaidRenderingMode" => json!(manager.mermaid_rendering_mode()),
        "getWarnings" => Value::Object(manager.warnings()),
        "isProjectTrusted" => json!(manager.is_project_trusted()),
        "getSettings" => Value::Object(manager.settings().clone()),
        other => panic!("unknown getter {other}"),
    })
}

#[test]
fn files_load_as_the_typescript_manager_loads_them() {
    environment();
    let mut failures = Vec::new();
    for case in fixture("load.json").as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let layout = Layout::new();
        layout.write(&layout.global_path(), case["global"].as_str());
        layout.write(&layout.project_path(), case["project"].as_str());
        let mut manager = SettingsManager::create(
            &layout.cwd(),
            &layout.agent_dir(),
            case["untrusted"] != true,
        );
        let root = layout.root.to_string_lossy().into_owned();
        let check = |field: &str, actual: Value, failures: &mut Vec<String>| {
            differences(
                &format!("{name}: {field}"),
                &case[field],
                &portable(&actual, &root),
                failures,
            );
        };
        check(
            "settings",
            Value::Object(manager.settings().clone()),
            &mut failures,
        );
        check(
            "globalSettings",
            Value::Object(manager.global_settings().clone()),
            &mut failures,
        );
        check(
            "projectSettings",
            Value::Object(manager.project_settings().clone()),
            &mut failures,
        );
        check(
            "errors",
            errors_json(&manager.drain_errors()),
            &mut failures,
        );
        for getter in case["getters"].as_array().unwrap() {
            let call = getter["getter"].as_array().unwrap();
            let getter_name = call[0].as_str().unwrap();
            let mut expected = getter.as_object().unwrap().clone();
            expected.shift_remove("getter");
            let actual = match get(&manager, getter_name, &call[1..]) {
                Ok(value) => json!({"value": value}),
                Err(error) => json!({"error": error}),
            };
            differences(
                &format!("{name}: {getter_name}{}", Value::Array(call[1..].to_vec())),
                &Value::Object(expected),
                &portable(&actual, &root),
                &mut failures,
            );
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A setter call by its TypeScript name; its result, as the recorder writes it.
fn call(
    manager: &mut SettingsManager,
    layout: &Layout,
    name: &str,
    args: &[Value],
) -> Result<Value, String> {
    let flag = |index: usize| args[index].as_bool().unwrap();
    let number = |index: usize| args[index].as_f64().unwrap();
    let text = |index: usize| text_arg(args, index);
    let optional_strings = |index: usize| (!args[index].is_null()).then(|| strings(&args[index]));
    match name {
        "externalEdit" => {
            let content = match &args[1] {
                Value::String(text) => text.clone(),
                other => relay_ai::json::stringify_pretty(other),
            };
            layout.write(&layout.path(args[0].as_str().unwrap()), Some(&content));
        }
        "holdLock" => {
            let mut lock = layout.path(args[0].as_str().unwrap()).into_os_string();
            lock.push(".lock");
            fs::create_dir_all(PathBuf::from(lock)).unwrap();
        }
        "setDefaultModelAndProvider" => manager.set_default_model_and_provider(&text(0), &text(1)),
        "setDefaultProvider" => manager.set_default_provider(&text(0)),
        "setDefaultModel" => manager.set_default_model(&text(0)),
        "setTheme" => manager.set_theme(&text(0)),
        "setSteeringMode" => manager.set_steering_mode(&text(0)),
        "setFollowUpMode" => manager.set_follow_up_mode(&text(0)),
        "setDefaultThinkingLevel" => manager.set_default_thinking_level(&text(0)),
        "setTransport" => manager.set_transport(&text(0)),
        "setLastChangelogVersion" => manager.set_last_changelog_version(&text(0)),
        "setCompactionEnabled" => manager.set_compaction_enabled(flag(0)),
        "setRetryEnabled" => manager.set_retry_enabled(flag(0)),
        "setShowImages" => manager.set_show_images(flag(0)),
        "setImageWidthCells" => manager.set_image_width_cells(number(0)),
        "setClearOnShrink" => manager.set_clear_on_shrink(flag(0)),
        "setShowTerminalProgress" => manager.set_show_terminal_progress(flag(0)),
        "setImageAutoResize" => manager.set_image_auto_resize(flag(0)),
        "setBlockImages" => manager.set_block_images(flag(0)),
        "setMermaidRenderingMode" => manager.set_mermaid_rendering_mode(&text(0)),
        "setProjectPackages" => {
            manager.set_project_packages(args[0].as_array().unwrap().clone())?
        }
        "setProjectExtensionPaths" => manager.set_project_extension_paths(strings(&args[0]))?,
        "setProjectSkillPaths" => manager.set_project_skill_paths(strings(&args[0]))?,
        "setProjectPromptTemplatePaths" => {
            manager.set_project_prompt_template_paths(strings(&args[0]))?
        }
        "setProjectThemePaths" => manager.set_project_theme_paths(strings(&args[0]))?,
        "setPackages" => manager.set_packages(args[0].as_array().unwrap().clone()),
        "setExtensionPaths" => manager.set_extension_paths(strings(&args[0])),
        "setSkillPaths" => manager.set_skill_paths(strings(&args[0])),
        "setPromptTemplatePaths" => manager.set_prompt_template_paths(strings(&args[0])),
        "setThemePaths" => manager.set_theme_paths(strings(&args[0])),
        "setProjectTrusted" => manager.set_project_trusted(flag(0)),
        "setModelThinkingLevel" => manager.set_model_thinking_level(&text(0), &text(1), &text(2)),
        "removeModelThinkingLevel" => manager.remove_model_thinking_level(&text(0), &text(1)),
        "setShellPath" => manager.set_shell_path(args[0].as_str()),
        "setNpmCommand" => manager.set_npm_command(optional_strings(0)),
        "setShellCommandPrefix" => manager.set_shell_command_prefix(args[0].as_str()),
        "setEnabledModels" => manager.set_enabled_models(optional_strings(0)),
        "setHarnessCoreSetting" => manager.set_harness_core_setting(&text(0), args[1].clone())?,
        "setEnableAnalytics" => manager.set_enable_analytics(flag(0)),
        "getTrackingId" => return Ok(manager.tracking_id().unwrap_or(Value::Null)),
        "getOrCreateDeviceId" => return Ok(manager.get_or_create_device_id()),
        "setEditorPaddingX" => manager.set_editor_padding_x(number(0)),
        "setAutocompleteMaxVisible" => manager.set_autocomplete_max_visible(number(0)),
        "setFullscreenWheelScrollLines" => {
            manager.set_fullscreen_wheel_scroll_lines(args[0].clone())
        }
        "setHttpIdleTimeoutMs" => manager.set_http_idle_timeout_ms(number(0))?,
        "setOutputPad" => manager.set_output_pad(args[0].as_u64().unwrap() as u8),
        "setTuiMode" => manager.set_tui_mode(&text(0)),
        "setFullscreenExitOutput" => manager.set_fullscreen_exit_output(&text(0)),
        "setFullscreenScrollbar" => manager.set_fullscreen_scrollbar(&text(0)),
        "setFullscreenCopyOnSelect" => manager.set_fullscreen_copy_on_select(flag(0)),
        "setDoubleEscapeAction" => manager.set_double_escape_action(&text(0)),
        "setTreeFilterMode" => manager.set_tree_filter_mode(&text(0)),
        "setShowHardwareCursor" => manager.set_show_hardware_cursor(flag(0)),
        "setCacheWarmingMode" => manager.set_cache_warming_mode(&text(0)),
        "setHideThinkingBlock" => manager.set_hide_thinking_block(flag(0)),
        "setShowCacheMissNotices" => manager.set_show_cache_miss_notices(flag(0)),
        "setQuietStartup" => manager.set_quiet_startup(args[0].clone()),
        "setDefaultProjectTrust" => manager.set_default_project_trust(&text(0)),
        "setCollapseChangelog" => manager.set_collapse_changelog(flag(0)),
        "setEnableInstallTelemetry" => manager.set_enable_install_telemetry(flag(0)),
        "setEnableSkillCommands" => manager.set_enable_skill_commands(flag(0)),
        "setWarnings" => manager.set_warnings(args[0].as_object().unwrap().clone()),
        "applyOverrides" => manager.apply_overrides(args[0].as_object().unwrap()),
        "getSettings" => return Ok(Value::Object(manager.settings().clone())),
        "reload" => manager.reload(),
        other => panic!("unknown call {other}"),
    }
    Ok(Value::Null)
}

fn file_text(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(text) => json!(text),
        Err(_) => json!("<absent>"),
    }
}

#[test]
fn setters_write_as_the_typescript_manager_writes() {
    environment();
    let mut failures = Vec::new();
    for case in fixture("writes.json").as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let layout = Layout::new();
        layout.write(&layout.global_path(), case["global"].as_str());
        layout.write(&layout.project_path(), case["project"].as_str());
        let mut manager = SettingsManager::create(
            &layout.cwd(),
            &layout.agent_dir(),
            case["untrusted"] != true,
        );
        let outcomes: Vec<Value> = case["calls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                let entry = entry.as_array().unwrap();
                match call(
                    &mut manager,
                    &layout,
                    entry[0].as_str().unwrap(),
                    &entry[1..],
                ) {
                    Ok(value) => json!({"result": value}),
                    Err(error) => json!({"error": error}),
                }
            })
            .collect();
        let root = layout.root.to_string_lossy().into_owned();
        let actual = json!({
            "outcomes": outcomes,
            "globalFile": file_text(&layout.global_path()),
            "projectFile": file_text(&layout.project_path()),
            "settings": manager.settings(),
            "errors": errors_json(&manager.drain_errors()),
        });
        for field in [
            "outcomes",
            "globalFile",
            "projectFile",
            "settings",
            "errors",
        ] {
            differences(
                &format!("{name}: {field}"),
                &case[field],
                &portable(&actual[field], &root),
                &mut failures,
            );
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
