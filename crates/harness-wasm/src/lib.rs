//! The Relay harness core as a WebAssembly module.
//!
//! The ABI is three functions and JSON: the host writes a request into memory it got from
//! [`harness_alloc`], calls [`harness_call`], reads the response and releases both buffers with
//! [`harness_free`]. A request is `{"method": ..., ...}`; a response is `{"ok": value}` or
//! `{"error": message}`. Engines live in the module and are addressed by the id `create` returns.
//! No wasm-bindgen: the host loader is a small hand-written TypeScript module.

use std::cell::RefCell;

use relay_harness_core::alignment::{
    extract_constraints, is_correction, is_question_only, requests_action, AlignmentPolicyOptions,
    ConstraintSource, DeveloperConstraint, DeveloperCorrection,
};
use relay_harness_core::context::{ContextMessage, ContextPolicyOptions, ContextToolCall};
use relay_harness_core::effects::{
    classify_command, classify_tool_call, deletion_targets, risky_operations,
};
use relay_harness_core::engine::{EngineOptions, HarnessEngine};
use relay_harness_core::json::{
    classify_context, constraint_to_json, decision_to_json, effect_from_json, effect_to_json,
    report_to_json, stats_to_json, strings, tool_call,
};
use relay_harness_core::route::{py_strip, RouteAgent, Router, Vocabulary};
use serde_json::{json, Value};

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
        workspace: classify_context(&value["workspace"]),
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

fn string_pairs(value: &Value) -> Vec<(String, String)> {
    value
        .as_array()
        .map(|pairs| {
            pairs
                .iter()
                .filter_map(|pair| {
                    Some((pair[0].as_str()?.to_string(), pair[1].as_str()?.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `route.py --json`: rank a catalog's agents for a request. Each candidate carries the catalog
/// entry's `domain`, `kind`, `model`, `path` and `can_edit`, as the script prints them. The
/// vocabulary's `words` and `phrases` are `[key, value]` pairs in file order: phrase order decides
/// which of two overlapping phrases of the same length applies.
fn route_agents(request: &Value) -> Result<Value> {
    let entries = request["agents"].as_array().ok_or("missing `agents`")?;
    let agents = entries
        .iter()
        .map(|agent| {
            Ok(RouteAgent {
                name: text(agent, "name")?,
                description: text(agent, "description")?,
                domain: text(agent, "domain")?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let vocabulary = Vocabulary::new(
        &string_pairs(&request["vocabulary"]["words"]),
        &string_pairs(&request["vocabulary"]["phrases"]),
    );
    let query = text(request, "query")?;
    let top = request["top"].as_u64().unwrap_or(5) as usize;
    let router = Router::new(agents, vocabulary);
    let (clear, candidates) = router.route(&query, top, request["domain"].as_str());
    let field = |index: usize, key: &str| entries[index].get(key).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "query": py_strip(&query),
        "clear_specialist": clear,
        "candidates": candidates.iter().map(|candidate| json!({
            "name": router.agents()[candidate.agent].name,
            "score": candidate.score,
            "strength": candidate.strength,
            "domain": field(candidate.agent, "domain"),
            "kind": field(candidate.agent, "kind"),
            "model": entries[candidate.agent].get("model").cloned().unwrap_or_else(|| json!({})),
            "path": field(candidate.agent, "path"),
            "can_edit": field(candidate.agent, "can_edit"),
            "terms": candidate.terms,
            "exclusion_alert": candidate.exclusion_alert,
        })).collect::<Vec<_>>(),
    }))
}

/// Handle one parsed request.
pub fn handle(request: &Value) -> Result<Value> {
    let method = request["method"].as_str().ok_or("missing `method`")?;
    let verify_commands = strings(&request["verifyCommands"]);
    match method {
        "classifyCommand" => Ok(effect_to_json(&classify_command(
            &text(request, "command")?,
            &verify_commands,
            &classify_context(&request["context"]),
        ))),
        "classifyToolCall" => Ok(effect_to_json(&classify_tool_call(
            &tool_call(&request["toolCall"])?,
            &verify_commands,
            &classify_context(&request["context"]),
        ))),
        "riskyOperations" => {
            let operations = risky_operations(
                &text(request, "command")?,
                &classify_context(&request["context"]),
            );
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
        "routeAgents" => route_agents(request),
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
                stats_to_json(&stats)
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
