//! The harness's values as the TypeScript harness writes them in JSON: tool calls, effects,
//! alignment decisions, completion reports and constraints. The WebAssembly module speaks it,
//! and runtimes report harness events in it.

use serde_json::{json, Map, Value};

use crate::alignment::{AlignmentDecision, ConstraintSource, DeveloperConstraint};
use crate::context::ContextStats;
use crate::effects::{ClassifyContext, ToolCall, ToolEffect, ToolEffectKind};
use crate::evidence::CompletionReport;

type Result<T> = std::result::Result<T, String>;

/// A number as JavaScript writes it: an integral value without a fraction.
fn js_number(value: f64) -> Value {
    const SAFE: f64 = 9_007_199_254_740_991.0;
    if value.fract() == 0.0 && value.abs() <= SAFE {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// The strings of a JSON array, none when it is not one.
pub fn optional_strings(value: &Value) -> Option<Vec<String>> {
    value.as_array().map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

/// The strings of a JSON array, empty when it is not one.
pub fn strings(value: &Value) -> Vec<String> {
    optional_strings(value).unwrap_or_default()
}

/// A workspace (`cwd`, `home`, `tempDir`).
pub fn classify_context(value: &Value) -> ClassifyContext {
    ClassifyContext {
        cwd: value["cwd"].as_str().map(str::to_string),
        home: value["home"].as_str().map(str::to_string),
        temp_dir: value["tempDir"].as_str().map(str::to_string),
    }
}

/// A tool call (`name`, `arguments`); only string arguments count for classification.
pub fn tool_call(value: &Value) -> Result<ToolCall> {
    let name = value["name"]
        .as_str()
        .ok_or("missing tool call `name`")?
        .to_string();
    let arguments = value["arguments"]
        .as_object()
        .map(|fields| {
            fields
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ToolCall { name, arguments })
}

/// An effect kind by its name.
pub fn kind(name: &str) -> Result<ToolEffectKind> {
    Ok(match name {
        "read" => ToolEffectKind::Read,
        "write" => ToolEffectKind::Write,
        "execute" => ToolEffectKind::Execute,
        "verify" => ToolEffectKind::Verify,
        "destructive" => ToolEffectKind::Destructive,
        "external" => ToolEffectKind::External,
        other => return Err(format!("unknown effect kind `{other}`")),
    })
}

/// A `ToolEffect` as the TypeScript harness writes it.
pub fn effect_from_json(value: &Value) -> Result<ToolEffect> {
    Ok(ToolEffect {
        kind: kind(value["kind"].as_str().ok_or("missing effect `kind`")?)?,
        paths: strings(&value["paths"]),
        command: value["command"].as_str().map(str::to_string),
        reason: value["reason"].as_str().map(str::to_string),
        scope: optional_strings(&value["scope"]),
        files: optional_strings(&value["files"]),
        writes: optional_strings(&value["writes"]),
    })
}

/// A `ToolEffect` as the TypeScript harness writes it.
pub fn effect_to_json(effect: &ToolEffect) -> Value {
    let mut object = Map::new();
    object.insert("kind".into(), json!(effect.kind.as_str()));
    object.insert("paths".into(), json!(effect.paths));
    if let Some(command) = &effect.command {
        object.insert("command".into(), json!(command));
    }
    if let Some(reason) = &effect.reason {
        object.insert("reason".into(), json!(reason));
    }
    if let Some(scope) = &effect.scope {
        object.insert("scope".into(), json!(scope));
    }
    if let Some(files) = &effect.files {
        object.insert("files".into(), json!(files));
    }
    if let Some(writes) = &effect.writes {
        object.insert("writes".into(), json!(writes));
    }
    Value::Object(object)
}

/// An alignment decision; `ask` is the authorizer request the TypeScript engine answers inline.
pub fn decision_to_json(decision: &AlignmentDecision) -> Value {
    match decision {
        AlignmentDecision::Allow { via: Some(via) } => {
            json!({ "action": "allow", "via": via.as_str() })
        }
        AlignmentDecision::Allow { via: None } => json!({ "action": "allow" }),
        AlignmentDecision::Block { reason, kind } => {
            json!({ "action": "block", "kind": kind.as_str(), "reason": reason })
        }
        AlignmentDecision::AskAuthorizer { fingerprint } => {
            json!({ "action": "ask", "fingerprint": fingerprint })
        }
    }
}

/// A completion report as the TypeScript harness writes it.
pub fn report_to_json(report: &CompletionReport) -> Value {
    let verifications: Vec<Value> = report
        .verifications
        .iter()
        .map(|check| {
            let mut object = json!({
                "command": check.command,
                "passed": check.passed,
                "step": js_number(check.step),
                "nameFiltered": check.name_filtered,
                "empty": check.empty,
            });
            if let Some(scope) = &check.scope {
                object["scope"] = json!(scope);
            }
            if let Some(files) = &check.files {
                object["files"] = json!(files);
            }
            object
        })
        .collect();
    let mut object = json!({
        "status": report.status.as_str(),
        "claimed": report.claimed,
        "changedPaths": report.changed_paths,
        "mutations": report.mutations,
        "verifications": verifications,
        "gated": report.gated,
    });
    if let Some(detail) = &report.detail {
        object["detail"] = json!(detail);
    }
    object
}

/// A developer constraint as the TypeScript harness writes it.
pub fn constraint_to_json(constraint: &DeveloperConstraint) -> Value {
    json!({
        "id": constraint.id,
        "text": constraint.text,
        "source": match constraint.source { ConstraintSource::Message => "message", ConstraintSource::Api => "api" },
        "timestamp": js_number(constraint.timestamp),
    })
}

/// Context policy statistics (`ContextPolicyStats`).
pub fn stats_to_json(stats: &ContextStats) -> Value {
    json!({ "elidedResults": stats.elided_results, "elidedChars": stats.elided_chars, "batches": stats.batches })
}
