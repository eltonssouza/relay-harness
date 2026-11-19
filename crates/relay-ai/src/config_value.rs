//! Config values (`packages/coding-agent/src/core/resolve-config-value.ts`): API keys and headers
//! in `auth.json` and `models.json` written as a literal, a `$VAR` or `${VAR}` template, or a
//! `!command` whose output is the value.
//!
//! In a template, `$$` is a literal `$` and `$!` a literal `!`; a `$` not followed by a variable
//! name stays as written. A variable comes from the provider env, else the process environment;
//! an empty value counts as unset, and a template with an unset variable resolves to nothing.
//! A command runs once per process (its result is cached) with a 10 second limit, in Git Bash on
//! Windows when installed and the system shell otherwise; its trimmed output is the value.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Part {
    Literal(String),
    Env(String),
}

fn is_name_start(character: char) -> bool {
    character.is_ascii_alphabetic() || character == '_'
}

fn is_name_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

fn push_literal(parts: &mut Vec<Part>, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(Part::Literal(previous)) = parts.last_mut() {
        previous.push_str(text);
    } else {
        parts.push(Part::Literal(text.to_string()));
    }
}

/// `parseConfigValueTemplate`. Every boundary is an ASCII character, so byte indices work.
fn parse_template(config: &str) -> Vec<Part> {
    let mut parts = Vec::new();
    let mut index = 0;
    while index < config.len() {
        let Some(offset) = config[index..].find('$') else {
            push_literal(&mut parts, &config[index..]);
            break;
        };
        let dollar = index + offset;
        push_literal(&mut parts, &config[index..dollar]);
        let rest = &config[dollar + 1..];
        match rest.chars().next() {
            Some(escaped @ ('$' | '!')) => {
                push_literal(&mut parts, &escaped.to_string());
                index = dollar + 2;
            }
            Some('{') => match rest.find('}') {
                None => {
                    push_literal(&mut parts, "$");
                    index = dollar + 1;
                }
                Some(close) => {
                    let name = &rest[1..close];
                    let valid = name.chars().next().is_some_and(is_name_start)
                        && name.chars().all(is_name_character);
                    if valid {
                        parts.push(Part::Env(name.to_string()));
                    } else {
                        push_literal(&mut parts, &config[dollar..dollar + 1 + close + 1]);
                    }
                    index = dollar + 1 + close + 1;
                }
            },
            Some(first) if is_name_start(first) => {
                let length = rest
                    .find(|character: char| !is_name_character(character))
                    .unwrap_or(rest.len());
                parts.push(Part::Env(rest[..length].to_string()));
                index = dollar + 1 + length;
            }
            _ => {
                push_literal(&mut parts, "$");
                index = dollar + 1;
            }
        }
    }
    parts
}

/// Whether the value is a `!command`.
pub fn is_command(config: &str) -> bool {
    config.starts_with('!')
}

fn template(config: &str) -> Vec<Part> {
    if is_command(config) {
        Vec::new()
    } else {
        parse_template(config)
    }
}

/// The variables a template reads, each once, in order (`getConfigValueEnvVarNames`).
pub fn env_var_names(config: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for part in template(config) {
        if let Part::Env(name) = part {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
}

/// The variable a value is exactly, like `$OPENAI_API_KEY` (`getConfigValueEnvVarName`).
pub fn env_var_name(config: &str) -> Option<String> {
    match template(config).as_slice() {
        [Part::Env(name)] => Some(name.clone()),
        _ => None,
    }
}

fn env_value(name: &str, env: Option<&Map<String, Value>>) -> Option<String> {
    env.and_then(|env| env.get(name))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var(name).ok().filter(|value| !value.is_empty()))
}

/// The template's variables that are unset (`getMissingConfigValueEnvVarNames`).
pub fn missing_env_var_names(config: &str, env: Option<&Map<String, Value>>) -> Vec<String> {
    env_var_names(config)
        .into_iter()
        .filter(|name| env_value(name, env).is_none())
        .collect()
}

/// A value with every variable substituted, or nothing when one is unset; a command runs once
/// per process (`resolveConfigValue`).
pub fn resolve(config: &str, env: Option<&Map<String, Value>>) -> Option<String> {
    if is_command(config) {
        return run_cached(config);
    }
    let mut resolved = String::new();
    for part in parse_template(config) {
        match part {
            Part::Literal(text) => resolved.push_str(&text),
            Part::Env(name) => resolved.push_str(&env_value(&name, env)?),
        }
    }
    Some(resolved)
}

fn run_cached(config: &str) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Mutex::default);
    if let Some(result) = cache.lock().ok()?.get(config) {
        return result.clone();
    }
    let result = run_command(&config[1..]);
    cache
        .lock()
        .ok()?
        .insert(config.to_string(), result.clone());
    result
}

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

/// Git Bash in Program Files, as the coding agent's shell resolution finds it on Windows.
#[cfg(windows)]
fn windows_bash() -> Option<String> {
    ["ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(|variable| std::env::var(variable).ok())
        .map(|root| format!("{root}\\Git\\bin\\bash.exe"))
        .find(|path| std::path::Path::new(path).exists())
}

#[cfg(windows)]
fn shell_command(command: &str) -> Command {
    use std::os::windows::process::CommandExt;
    if let Some(bash) = windows_bash() {
        let mut process = Command::new(bash);
        process.args(["-c", command]);
        return process;
    }
    // `execSync`'s fallback: cmd.exe with the command quoted as one argument.
    let mut process = Command::new("cmd.exe");
    process.args(["/d", "/s", "/c"]);
    process.raw_arg(format!("\"{command}\""));
    process
}

#[cfg(not(windows))]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("/bin/sh");
    process.args(["-c", command]);
    process
}

/// Run a command and take its trimmed output; a failure, a timeout or empty output is nothing.
pub fn run_command(command: &str) -> Option<String> {
    let mut child = shell_command(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).ok().map(|_| output)
    });
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let output = reader.join().ok()??;
    if !status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output);
    let trimmed = crate::text::js_trim(&text);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}
