//! The Relay harness core as a WebAssembly module.
//!
//! The ABI is three functions and JSON: the host writes a request into memory it got from
//! [`harness_alloc`], calls [`harness_call`], reads the response and releases both buffers with
//! [`harness_free`]. A request is `{"method": ..., ...}`; a response is `{"ok": value}` or
//! `{"error": message}`. Engines live in the module and are addressed by the id `create` returns.
//! No wasm-bindgen: the host loader is a small hand-written TypeScript module.

use std::cell::RefCell;

use relay_harness_core::alignment::{
    extract_constraints, is_correction, is_question_only, requests_action, AlignmentDecision,
    AlignmentPolicyOptions, ConstraintSource, DeveloperConstraint, DeveloperCorrection,
};
use relay_harness_core::context::{ContextMessage, ContextPolicyOptions, ContextToolCall};
use relay_harness_core::effects::{
    classify_command, classify_tool_call, deletion_targets, risky_operations, ClassifyContext,
    ToolCall, ToolEffect, ToolEffectKind,
};
use relay_harness_core::engine::{EngineOptions, HarnessEngine};
use relay_harness_core::evidence::CompletionReport;
use serde_json::{json, Map, Value};

thread_local! {
    static ENGINES: RefCell<Vec<Option<HarnessEngine>>> = const { RefCell::new(Vec::new()) };
}

/// Allocate `len` bytes for a request.
#[no_mangle]
pub extern "C" fn harness_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

/// Release a buffer from [`harness_alloc`] or a response from [`harness_call`].
///
/// # Safety
/// `ptr` and `len` must describe a buffer this module returned and that was not released yet.
#[no_mangle]
pub unsafe extern "C" fn harness_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}

/// Handle one JSON request. Returns the response's pointer in the high 32 bits and its length in the low 32 bits.
///
/// # Safety
/// `ptr` and `len` must describe readable memory holding the request.
#[no_mangle]
pub unsafe extern "C" fn harness_call(ptr: *const u8, len: usize) -> u64 {
    let request = std::slice::from_raw_parts(ptr, len);
    let response = handle_bytes(request).into_bytes().into_boxed_slice();
    let length = response.len() as u64;
    let address = Box::into_raw(response) as *mut u8 as usize as u64;
    (address << 32) | length
}

/// Handle a request given as JSON bytes and return the JSON response.
pub fn handle_bytes(request: &[u8]) -> String {
    let response = match serde_json::from_slice::<Value>(request) {
        Ok(request) => match handle(&request) {
            Ok(value) => json!({ "ok": value }),
            Err(error) => json!({ "error": error }),
        },
        Err(error) => json!({ "error": format!("invalid request: {error}") }),
    };
    response.to_string()
}

type Result<T> = std::result::Result<T, String>;

fn text(request: &Value, key: &str) -> Result<String> {
    request[key]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("missing string `{key}`"))
}

fn optional_strings(value: &Value) -> Option<Vec<String>> {
    value.as_array().map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

fn strings(value: &Value) -> Vec<String> {
    optional_strings(value).unwrap_or_default()
}

fn context(value: &Value) -> ClassifyContext {
    ClassifyContext {
        cwd: value["cwd"].as_str().map(str::to_string),
        home: value["home"].as_str().map(str::to_string),
        temp_dir: value["tempDir"].as_str().map(str::to_string),
    }
}

fn tool_call(value: &Value) -> Result<ToolCall> {
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

fn kind(name: &str) -> Result<ToolEffectKind> {
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

fn effect_from_json(value: &Value) -> Result<ToolEffect> {
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

fn effect_to_json(effect: &ToolEffect) -> Value {
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

fn decision_to_json(decision: &AlignmentDecision) -> Value {
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

fn report_to_json(report: &CompletionReport) -> Value {
    let verifications: Vec<Value> = report
        .verifications
        .iter()
        .map(|check| {
            let mut object = json!({
                "command": check.command,
                "passed": check.passed,
                "step": check.step,
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

fn constraint_to_json(constraint: &DeveloperConstraint) -> Value {
    json!({
        "id": constraint.id,
        "text": constraint.text,
        "source": match constraint.source { ConstraintSource::Message => "message", ConstraintSource::Api => "api" },
        "timestamp": constraint.timestamp,
    })
}

fn engine_options(value: &Value) -> EngineOptions {
    let alignment = match &value["alignment"] {
        Value::Bool(false) => None,
        options => Some(AlignmentPolicyOptions {
            max_constraints: options["maxConstraints"].as_u64().unwrap_or(12) as usize,
            has_authorizer: options["hasAuthorizer"].as_bool().unwrap_or(false),
            scope_guard: options["scopeGuard"].as_bool().unwrap_or(true),
            authorization_gate: options["authorizationGate"].as_bool().unwrap_or(true),
        }),
    };
    let evidence_max_gates = match &value["evidence"] {
        Value::Bool(false) => None,
        options => Some(options["maxGatesPerRequest"].as_u64().unwrap_or(1) as usize),
    };
    let context_options = match &value["context"] {
        Value::Bool(false) => None,
        options => Some(ContextPolicyOptions {
            keep_recent: options["keepRecent"].as_u64().unwrap_or(6) as usize,
            batch_size: options["batchSize"].as_u64().unwrap_or(6) as usize,
            min_elide_chars: options["minElideChars"].as_u64().unwrap_or(1500) as usize,
            max_digest_entries: options["maxDigestEntries"].as_u64().unwrap_or(30) as usize,
            cwd: options["cwd"].as_str().map(str::to_string),
        }),
    };
    EngineOptions {
        alignment,
        evidence_max_gates,
        context: context_options,
        verify_commands: strings(&value["verifyCommands"]),
        workspace: context(&value["workspace"]),
    }
}

fn context_messages(value: &Value) -> Result<Vec<ContextMessage>> {
    let messages = value.as_array().ok_or("missing `messages`")?;
    messages
        .iter()
        .map(|message| {
            Ok(match message["role"].as_str() {
                Some("assistant") => ContextMessage::Assistant {
                    tool_calls: message["toolCalls"]
                        .as_array()
                        .map(|calls| {
                            calls
                                .iter()
                                .map(|call| {
                                    Ok(ContextToolCall {
                                        id: text(call, "id")?,
                                        call: tool_call(call)?,
                                        arguments_json: call["argumentsJson"]
                                            .as_str()
                                            .unwrap_or("{}")
                                            .to_string(),
                                        effect: if call["effect"].is_object() {
                                            Some(effect_from_json(&call["effect"])?)
                                        } else {
                                            None
                                        },
                                    })
                                })
                                .collect::<Result<Vec<_>>>()
                        })
                        .transpose()?
                        .unwrap_or_default(),
                },
                Some("toolResult") => ContextMessage::ToolResult {
                    tool_call_id: text(message, "toolCallId")?,
                    tool_name: text(message, "toolName")?,
                    chars: message["chars"].as_u64().unwrap_or(0) as usize,
                    is_error: message["isError"].as_bool().unwrap_or(false),
                },
                _ => ContextMessage::Other,
            })
        })
        .collect()
}

fn with_engine<T>(
    request: &Value,
    body: impl FnOnce(&mut HarnessEngine) -> Result<T>,
) -> Result<T> {
    let id = request["engine"].as_u64().ok_or("missing `engine`")? as usize;
    ENGINES.with(|engines| {
        let mut engines = engines.borrow_mut();
        let engine = engines
            .get_mut(id)
            .and_then(Option::as_mut)
            .ok_or_else(|| format!("no engine {id}"))?;
        body(engine)
    })
}

/// Handle one parsed request.
pub fn handle(request: &Value) -> Result<Value> {
    let method = request["method"].as_str().ok_or("missing `method`")?;
    let verify_commands = strings(&request["verifyCommands"]);
    match method {
        "classifyCommand" => Ok(effect_to_json(&classify_command(
            &text(request, "command")?,
            &verify_commands,
            &context(&request["context"]),
        ))),
        "classifyToolCall" => Ok(effect_to_json(&classify_tool_call(
            &tool_call(&request["toolCall"])?,
            &verify_commands,
            &context(&request["context"]),
        ))),
        "riskyOperations" => {
            let operations =
                risky_operations(&text(request, "command")?, &context(&request["context"]));
            Ok(json!(operations
                .iter()
                .map(|operation| operation.as_str())
                .collect::<Vec<_>>()))
        }
        "deletionTargets" => Ok(json!(deletion_targets(&text(request, "command")?))),
        "extractConstraints" => Ok(json!(extract_constraints(&text(request, "text")?))),
        "isQuestionOnly" => Ok(json!(is_question_only(&text(request, "text")?))),
        "requestsAction" => Ok(json!(requests_action(&text(request, "text")?))),
        "isCorrection" => Ok(json!(is_correction(&text(request, "text")?))),
        "create" => {
            let engine = HarnessEngine::new(engine_options(&request["options"]));
            ENGINES.with(|engines| {
                let mut engines = engines.borrow_mut();
                engines.push(Some(engine));
                Ok(json!({ "engine": engines.len() - 1 }))
            })
        }
        "dispose" => {
            let id = request["engine"].as_u64().ok_or("missing `engine`")? as usize;
            ENGINES.with(|engines| {
                if let Some(slot) = engines.borrow_mut().get_mut(id) {
                    *slot = None;
                }
            });
            Ok(Value::Null)
        }
        _ => engine_method(method, request),
    }
}

fn engine_method(method: &str, request: &Value) -> Result<Value> {
    with_engine(request, |engine| {
        match method {
        "classify" => {
            let custom = if request["custom"].is_object() { Some(effect_from_json(&request["custom"])?) } else { None };
            Ok(effect_to_json(&engine.classify(&tool_call(&request["toolCall"])?, custom)))
        }
        "promptGuidelines" => Ok(json!(engine.prompt_guidelines())),
        "beginRequest" => {
            engine.begin_request(&text(request, "text")?);
            Ok(Value::Null)
        }
        "observeDeveloperMessage" => Ok(json!(engine.observe_developer_message(
            &text(request, "text")?,
            request["timestamp"].as_f64().unwrap_or(0.0),
            request["afterAgentWork"].as_bool().unwrap_or(true),
        ))),
        "check" => Ok(decision_to_json(&engine.check(&text(request, "toolName")?, &effect_from_json(&request["effect"])?))),
        "resolveAuthorization" => Ok(decision_to_json(&engine.resolve_authorization(
            &effect_from_json(&request["effect"])?,
            &text(request, "fingerprint")?,
            request["approved"].as_bool(),
        ))),
        "beginToolCall" => Ok(json!(engine.begin_tool_call())),
        "recordToolOutcome" => {
            engine.record_tool_outcome(
                &effect_from_json(&request["effect"])?,
                request["isError"].as_bool().unwrap_or(false),
                request["output"].as_str().unwrap_or(""),
                request["startedAt"].as_f64(),
            );
            Ok(Value::Null)
        }
        "transformContext" => {
            let elided = engine.transform_context(&context_messages(&request["messages"])?);
            Ok(json!(elided.iter().map(|(id, stub)| json!({ "toolCallId": id, "stub": stub })).collect::<Vec<_>>()))
        }
        "renderState" => Ok(json!(engine.render_state(request["slices"].as_str()))),
        "assessFinalMessage" => Ok(match engine.assess_final_message(&text(request, "text")?) {
            Some(assessment) => json!({ "report": report_to_json(&assessment.report), "verificationRequest": assessment.verification_request }),
            None => Value::Null,
        }),
        "resync" => {
            engine.resync();
            Ok(Value::Null)
        }
        "constraints" => Ok(json!(engine.alignment.as_ref().map(|alignment| alignment.constraints.list().iter().map(constraint_to_json).collect::<Vec<_>>()).unwrap_or_default())),
        "addConstraint" => Ok(match engine.alignment.as_mut() {
            Some(alignment) => json!(alignment.constraints.add(&text(request, "text")?, request["timestamp"].as_f64().unwrap_or(0.0)).as_ref().map(constraint_to_json)),
            None => Value::Null,
        }),
        "removeConstraint" => Ok(json!(engine.alignment.as_mut().is_some_and(|alignment| alignment.constraints.remove(request["id"].as_str().unwrap_or_default())))),
        "restoreLearnings" => {
            if let Some(alignment) = engine.alignment.as_mut() {
                let constraints: Vec<DeveloperConstraint> = request["constraints"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| DeveloperConstraint {
                                id: item["id"].as_str().unwrap_or_default().to_string(),
                                text: item["text"].as_str().unwrap_or_default().to_string(),
                                source: if item["source"] == "api" { ConstraintSource::Api } else { ConstraintSource::Message },
                                timestamp: item["timestamp"].as_f64().unwrap_or(0.0),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let corrections: Vec<DeveloperCorrection> = request["corrections"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| DeveloperCorrection {
                                text: item["text"].as_str().unwrap_or_default().to_string(),
                                timestamp: item["timestamp"].as_f64().unwrap_or(0.0),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                alignment.constraints.restore(&constraints);
                alignment.restore_corrections(&corrections);
            }
            Ok(Value::Null)
        }
        "corrections" => Ok(json!(engine
            .alignment
            .as_ref()
            .map(|alignment| alignment.corrections().iter().map(|correction| json!({ "text": correction.text, "timestamp": correction.timestamp })).collect::<Vec<_>>())
            .unwrap_or_default())),
        "pendingAuthorizations" => Ok(json!(engine.alignment.as_ref().map(|alignment| alignment.pending_authorizations()).unwrap_or_default())),
        "pendingChanges" => Ok(json!(engine.evidence.as_ref().and_then(|evidence| evidence.pending_changes()))),
        "latestReport" => Ok(engine.evidence.as_ref().and_then(|evidence| evidence.latest_report()).map(report_to_json).unwrap_or(Value::Null)),
        "contextStats" => Ok(engine
            .context
            .as_ref()
            .map(|context| {
                let stats = context.stats();
                json!({ "elidedResults": stats.elided_results, "elidedChars": stats.elided_chars, "batches": stats.batches })
            })
            .unwrap_or(Value::Null)),
        other => Err(format!("unknown method `{other}`")),
    }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(request: Value) -> Value {
        serde_json::from_str(&handle_bytes(request.to_string().as_bytes())).expect("JSON response")
    }

    #[test]
    fn classifies_and_runs_an_engine_through_json() {
        assert_eq!(
            call(json!({ "method": "classifyCommand", "command": "npm test" }))["ok"]["kind"],
            "verify"
        );
        let engine =
            call(json!({ "method": "create", "options": { "workspace": { "cwd": "/work/app" } } }))
                ["ok"]["engine"]
                .clone();
        call(
            json!({ "method": "observeDeveloperMessage", "engine": engine, "text": "Never push to main.", "timestamp": 0 }),
        );
        let state = call(json!({ "method": "renderState", "engine": engine }));
        assert!(state["ok"]
            .as_str()
            .expect("state")
            .contains("Never push to main."));
        assert_eq!(
            call(json!({ "method": "nope" }))["error"],
            "missing `engine`"
        );
        call(json!({ "method": "dispose", "engine": engine }));
        assert!(call(json!({ "method": "renderState", "engine": engine }))["error"].is_string());
    }
}
