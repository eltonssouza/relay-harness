//! Replays `crates/fixtures/compaction/`, what the TypeScript compaction and assistant retry loop
//! did (`packages/coding-agent/test/parity/compaction-record.ts`), comparing serialized JSON so
//! key order counts. Summary requests go to a scripted stream function that records them.

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use futures_util::stream::{self, BoxStream};
use relay_agent::{StreamEvent, StreamFn, StreamRequest};
use relay_ai::abort::AbortController;
use relay_ai::assistant_retry::{
    agent_retry_delay_ms, is_retryable_assistant_error, retry_assistant_call, RetryCallbacks,
    RetryPolicy,
};
use relay_ai::event::AssistantEvent;
use relay_ai::message::{AssistantMessage, Message, StopReason};
use relay_ai::Model;
use relay_compaction::branch::{
    collect_entries_for_branch_summary, prepare_branch_entries, BranchSummaryOptions,
};
use relay_compaction::cut::{
    find_cut_point, find_turn_start_index, prepare_compaction, CompactionSettings,
};
use relay_compaction::estimate::{
    calculate_context_tokens, estimate_context_tokens, estimate_projected_context_tokens,
    estimate_tokens, last_assistant_usage, should_compact,
};
use relay_compaction::utils::{
    compute_file_lists, convert_to_llm, format_file_operations, serialize_conversation,
    FileOperations,
};
use relay_compaction::Summarizer;
use relay_session::entries::{session_projection, Leaf};
use relay_session::SessionManager;
use serde_json::{json, Map, Value};

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/compaction")
        .join(name);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn differences(label: &str, expected: &Value, actual: &Value, failures: &mut Vec<String>) {
    let expected = expected.to_string();
    let actual = actual.to_string();
    if expected != actual {
        let show = |text: &str| {
            if text.len() > 1200 {
                format!("{}...", &text[..text.floor_char_boundary(1200)])
            } else {
                text.to_string()
            }
        };
        failures.push(format!(
            "{label}\n    expected {}\n    actual   {}",
            show(&expected),
            show(&actual)
        ));
    }
}

fn settings(value: &Value) -> CompactionSettings {
    CompactionSettings {
        enabled: value["enabled"].as_bool().unwrap(),
        reserve_tokens: value["reserveTokens"].as_f64().unwrap(),
        keep_recent_tokens: value["keepRecentTokens"].as_f64().unwrap(),
    }
}

fn defaults() -> CompactionSettings {
    relay_compaction::DEFAULT_COMPACTION_SETTINGS
}

#[test]
fn estimates_match_the_typescript_ones() {
    let recorded = fixture("estimate.json");
    let prepare = fixture("prepare.json");
    let mut failures = Vec::new();
    for case in recorded["messages"].as_array().unwrap() {
        differences(
            &format!("tokens of {}", case["message"]),
            &case["tokens"],
            &json!(estimate_tokens(&case["message"])),
            &mut failures,
        );
    }
    for case in recorded["contexts"].as_array().unwrap() {
        let messages = case["messages"].as_array().unwrap();
        differences(
            &format!("context {}", case["messages"]),
            &case["estimate"],
            &json!(estimate_context_tokens(messages)),
            &mut failures,
        );
    }
    for case in recorded["usages"].as_array().unwrap() {
        differences(
            &format!("usage {}", case["usage"]),
            &case["tokens"],
            &relay_ai::json::js_number(calculate_context_tokens(&case["usage"])),
            &mut failures,
        );
    }
    for case in recorded["shouldCompact"].as_array().unwrap() {
        let settings = settings(&case["settings"]);
        let actual = should_compact(
            case["tokens"].as_f64().unwrap(),
            case["window"].as_f64().unwrap(),
            settings.enabled,
            settings.reserve_tokens,
        );
        differences(
            &format!("shouldCompact {case}"),
            &case["result"],
            &json!(actual),
            &mut failures,
        );
    }
    for case in recorded["lastAssistantUsage"].as_array().unwrap() {
        let name = case["path"].as_str().unwrap();
        let entries = prepare["paths"][name].as_array().unwrap();
        let actual = last_assistant_usage(entries)
            .cloned()
            .unwrap_or(json!("<undefined>"));
        differences(
            &format!("last usage {name}"),
            &case["usage"],
            &actual,
            &mut failures,
        );
    }
    for case in recorded["projected"].as_array().unwrap() {
        let name = case["path"].as_str().unwrap();
        let entries = prepare["paths"][name].as_array().unwrap();
        let projection = session_projection(entries, Leaf::Last);
        let actual = json!(estimate_projected_context_tokens(&projection, entries));
        differences(
            &format!("projected {name}"),
            &case["estimate"],
            &actual,
            &mut failures,
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn cuts_and_preparations_match_the_typescript_ones() {
    let recorded = fixture("prepare.json");
    let mut failures = Vec::new();
    for case in recorded["cuts"].as_array().unwrap() {
        let name = case["path"].as_str().unwrap();
        let entries = recorded["paths"][name].as_array().unwrap();
        let start = case["start"].as_u64().unwrap() as usize;
        let end = case["end"]
            .as_u64()
            .map_or(entries.len(), |end| end as usize);
        let keep = case["keep"].as_f64().unwrap();
        let label = format!("cut {name} {start} {keep}");
        differences(
            &label,
            &case["result"],
            &json!(find_cut_point(entries, start, end, keep)),
            &mut failures,
        );
        let starts: Vec<i64> = (0..entries.len())
            .map(|index| find_turn_start_index(entries, index, start))
            .collect();
        differences(
            &format!("{label}: turn starts"),
            &case["turnStarts"],
            &json!(starts),
            &mut failures,
        );
    }
    for case in recorded["preparations"].as_array().unwrap() {
        let name = case["path"].as_str().unwrap();
        let entries = recorded["paths"][name].as_array().unwrap();
        let settings = CompactionSettings {
            keep_recent_tokens: case["keepRecentTokens"].as_f64().unwrap(),
            ..defaults()
        };
        let actual = prepare_compaction(entries, settings)
            .map_or(json!("<undefined>"), |preparation| preparation.to_json());
        differences(
            &format!("prepare {name} {}", case["keepRecentTokens"]),
            &case["preparation"],
            &actual,
            &mut failures,
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn conversations_serialize_as_the_typescript_ones() {
    let recorded = fixture("serialize.json");
    let mut failures = Vec::new();
    for (index, case) in recorded["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let llm = convert_to_llm(case["messages"].as_array().unwrap());
        differences(
            &format!("conversation {index}: llm"),
            &case["llm"],
            &json!(llm),
            &mut failures,
        );
        differences(
            &format!("conversation {index}: text"),
            &case["text"],
            &json!(serialize_conversation(&llm)),
            &mut failures,
        );
    }
    for (index, case) in recorded["fileOperations"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let mut operations = FileOperations::default();
        for message in case["messages"].as_array().unwrap() {
            operations.extract(message);
        }
        let (read, modified) = compute_file_lists(&operations);
        differences(
            &format!("file operations {index}"),
            &case["lists"],
            &json!({"readFiles": read, "modifiedFiles": modified}),
            &mut failures,
        );
        differences(
            &format!("file operations {index}: text"),
            &case["text"],
            &json!(format_file_operations(&read, &modified)),
            &mut failures,
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The recorder's `response`: an assistant message from a script.
fn response(script: &Value) -> AssistantMessage {
    let usage = script.get("usage").cloned().unwrap_or(json!({
        "input": 20, "output": 10, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 30,
        "cost": {"input": 0.001, "output": 0.002, "cacheRead": 0, "cacheWrite": 0, "total": 0.003},
    }));
    let mut message = json!({
        "content": script.get("content").cloned().unwrap_or(json!([{"type": "text", "text": "SUMMARY"}])),
        "api": "anthropic-messages",
        "provider": "anthropic",
        "model": "claude-test",
        "usage": usage,
        "stopReason": script.get("stopReason").cloned().unwrap_or(json!("stop")),
        "timestamp": 2,
    });
    if let Some(error) = script.get("errorMessage") {
        message["errorMessage"] = error.clone();
    }
    serde_json::from_value(message).unwrap()
}

/// Answers each request with the next script and records it.
struct Scripted {
    scripts: Mutex<Vec<Value>>,
    requests: Mutex<Vec<Value>>,
}

impl StreamFn for Scripted {
    fn stream<'a>(
        &'a self,
        model: &'a Model,
        messages: &'a [Message],
        request: &'a StreamRequest,
    ) -> BoxStream<'a, StreamEvent> {
        let options = &request.options;
        let mut recorded = Map::new();
        if let Some(max) = options.max_tokens {
            recorded.insert("maxTokens".into(), json!(max));
        }
        if let Some(key) = &request.api_key {
            recorded.insert("apiKey".into(), json!(key));
        }
        if let Some(headers) = &options.headers {
            recorded.insert("headers".into(), Value::Object(headers.clone()));
        }
        if let Some(env) = &options.env {
            recorded.insert("env".into(), json!(env));
        }
        if let Some(session) = &options.session_id {
            recorded.insert("sessionId".into(), json!(session));
        }
        if let Some(reasoning) = &options.reasoning {
            recorded.insert("reasoning".into(), json!(reasoning));
        }
        if let Some(retention) = &options.cache_retention {
            recorded.insert("cacheRetention".into(), json!(retention));
        }
        self.requests
            .lock()
            .unwrap()
            .push(json!({"model": model.id, "messages": messages, "options": recorded}));
        let script = {
            let mut scripts = self.scripts.lock().unwrap();
            if scripts.is_empty() {
                json!({})
            } else {
                scripts.remove(0)
            }
        };
        let message = response(&script);
        let event = if message.stop_reason == StopReason::Error {
            AssistantEvent::Error {
                reason: StopReason::Error,
                error: Message::Assistant(Box::new(message.clone())),
            }
        } else {
            AssistantEvent::Done {
                reason: message.stop_reason,
                message: Message::Assistant(Box::new(message.clone())),
            }
        };
        Box::pin(stream::iter(vec![StreamEvent {
            event,
            partial: message,
        }]))
    }
}

/// Records the retry loop's callbacks as the recorder does.
#[derive(Default)]
struct Log(Mutex<Vec<Value>>);

impl RetryCallbacks for Log {
    fn retry_scheduled(&self, attempt: u32, max_attempts: u32, delay_ms: f64, error_message: &str) {
        self.0.lock().unwrap().push(json!({"scheduled": {
            "attempt": attempt, "maxAttempts": max_attempts,
            "delayMs": relay_ai::json::js_number(delay_ms), "errorMessage": error_message,
        }}));
    }

    fn retry_attempt_start(&self) {
        self.0.lock().unwrap().push(json!("attemptStart"));
    }

    fn retry_finished(&self, success: bool, attempt: u32, final_error: Option<&str>) {
        let mut finished = json!({"success": success, "attempt": attempt});
        if let Some(error) = final_error {
            finished["finalError"] = json!(error);
        }
        self.0.lock().unwrap().push(json!({"finished": finished}));
    }
}

fn is_uuid7(text: &[u8]) -> bool {
    let hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
    text.len() == 36
        && text.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => *byte == b'7',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => hex(*byte),
        })
}

/// The recorder's `normalizeRequests`.
fn normalize(value: &Value, key: Option<&str>) -> Value {
    match value {
        Value::String(text) => {
            let bytes = text.as_bytes();
            let mut out = String::new();
            let (mut at, mut copied) = (0, 0);
            while at + 36 <= bytes.len() {
                if is_uuid7(&bytes[at..at + 36]) {
                    out.push_str(&text[copied..at]);
                    out.push_str("<uuid7>");
                    at += 36;
                    copied = at;
                } else {
                    at += 1;
                }
            }
            out.push_str(&text[copied..]);
            Value::String(out)
        }
        Value::Number(number)
            if key == Some("timestamp") && number.as_f64().is_some_and(|time| time > 1e12) =>
        {
            json!(0)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| normalize(item, None)).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(name, item)| (name.clone(), normalize(item, Some(name))))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A branch's preparation as the recorder writes it.
fn branch_preparation_json(preparation: &relay_compaction::branch::BranchPreparation) -> Value {
    json!({
        "messages": preparation.messages,
        "fileOps": preparation.file_ops.to_json(),
        "totalTokens": preparation.total_tokens,
    })
}

fn test_model(overrides: Option<&Value>) -> Model {
    let mut model = json!({
        "id": "claude-test", "name": "Claude Test", "api": "anthropic-messages", "provider": "anthropic",
        "baseUrl": "https://example.invalid", "reasoning": true, "input": ["text"],
        "cost": {"input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 200000, "maxTokens": 8192,
    });
    if let Some(Value::Object(overrides)) = overrides {
        for (key, value) in overrides {
            model[key] = value.clone();
        }
    }
    serde_json::from_value(model).unwrap()
}

/// Requests compared exactly, except the options' key order, which only reflects how the
/// TypeScript code built its options object.
fn compare_requests(label: &str, expected: &Value, actual: &Value, failures: &mut Vec<String>) {
    let (Some(expected), Some(actual)) = (expected.as_array(), actual.as_array()) else {
        return differences(label, expected, actual, failures);
    };
    if expected.len() != actual.len() {
        return differences(label, &json!(expected), &json!(actual), failures);
    }
    for (index, (expected, actual)) in expected.iter().zip(actual).enumerate() {
        differences(
            &format!("{label} {index}: model"),
            &expected["model"],
            &actual["model"],
            failures,
        );
        differences(
            &format!("{label} {index}: messages"),
            &expected["messages"],
            &actual["messages"],
            failures,
        );
        if expected["options"] != actual["options"] {
            failures.push(format!(
                "{label} {index}: options\n    expected {}\n    actual   {}",
                expected["options"], actual["options"]
            ));
        }
    }
}

#[tokio::test]
async fn branch_summaries_match_the_typescript_ones() {
    let recorded = fixture("branch.json");
    let mut failures = Vec::new();
    let mut entries = vec![json!({
        "type": "session", "version": 3, "id": "s-tree", "timestamp": "2026-11-01T09:00:00.000Z", "cwd": "/tree",
    })];
    entries.extend(recorded["tree"].as_array().unwrap().iter().cloned());
    let session = SessionManager::in_memory(Some("/tree"), None, Some(entries)).unwrap();
    for case in recorded["collect"].as_array().unwrap() {
        let (collected, common) = collect_entries_for_branch_summary(
            &session,
            case["from"].as_str(),
            case["to"].as_str().unwrap(),
        );
        let ids: Vec<Value> = collected.iter().map(|entry| entry["id"].clone()).collect();
        let actual = json!({"from": case["from"], "to": case["to"], "entryIds": ids, "commonAncestorId": common});
        differences(
            &format!("collect {} -> {}", case["from"], case["to"]),
            case,
            &actual,
            &mut failures,
        );
    }
    let budget_entries = recorded["budgetEntries"].as_array().unwrap();
    for case in recorded["prepare"].as_array().unwrap() {
        let budget = case["budget"].as_f64().unwrap();
        let actual = branch_preparation_json(&prepare_branch_entries(budget_entries, budget));
        let mut expected = case.clone();
        expected.as_object_mut().unwrap().shift_remove("budget");
        differences(
            &format!("prepare {budget}"),
            &expected,
            &actual,
            &mut failures,
        );
    }
    let (tree_entries, _) = collect_entries_for_branch_summary(&session, Some("t14"), "t5");
    differences(
        "tree preparation",
        &recorded["treePreparation"],
        &branch_preparation_json(&prepare_branch_entries(&tree_entries, 0.0)),
        &mut failures,
    );
    for case in recorded["summaries"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let (entries, _) = collect_entries_for_branch_summary(
            &session,
            case["from"].as_str(),
            case["to"].as_str().unwrap(),
        );
        let model = test_model(case.get("model"));
        let scripted = Scripted {
            scripts: Mutex::new(case["responses"].as_array().unwrap().clone()),
            requests: Mutex::new(Vec::new()),
        };
        let controller = AbortController::new();
        if case["abortBefore"] == true {
            controller.abort();
        }
        let log = Log::default();
        let summarizer = Summarizer {
            model: &model,
            stream: &scripted,
            api_key: case["apiKey"].as_str().map(str::to_string),
            headers: None,
            env: None,
            signal: controller.signal(),
            thinking_level: Some("high".into()),
            session_id: None,
            retry: policy(&case["retry"]),
            callbacks: &log,
            clock: relay_agent::now,
        };
        let options = BranchSummaryOptions {
            custom_instructions: case["customInstructions"].as_str().map(str::to_string),
            replace_instructions: case["replaceInstructions"] == true,
            reserve_tokens: case["reserveTokens"].as_f64(),
        };
        let result = summarizer.branch_summary(&entries, &options).await;
        let requests = normalize(
            &Value::Array(scripted.requests.lock().unwrap().clone()),
            None,
        );
        compare_requests(
            &format!("{name}: requests"),
            &case["requests"],
            &requests,
            &mut failures,
        );
        differences(
            &format!("{name}: result"),
            &case["result"],
            &result.to_json(),
            &mut failures,
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn policy(value: &Value) -> Option<RetryPolicy> {
    value.as_object().map(|policy| RetryPolicy {
        enabled: policy["enabled"].as_bool().unwrap(),
        max_retries: policy["maxRetries"].as_u64().unwrap() as u32,
        base_delay_ms: policy["baseDelayMs"].as_f64().unwrap(),
        max_agent_delay_ms: policy.get("maxAgentDelayMs").and_then(Value::as_f64),
    })
}

#[tokio::test]
async fn compaction_asks_and_answers_as_the_typescript_one() {
    let recorded = fixture("compact.json");
    let paths = fixture("prepare.json")["paths"].clone();
    let mut failures = Vec::new();
    for case in recorded.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let entries = paths[case["path"].as_str().unwrap()].as_array().unwrap();
        let mut settings = CompactionSettings {
            keep_recent_tokens: case["keepRecentTokens"].as_f64().unwrap(),
            ..defaults()
        };
        if let Some(reserve) = case["reserveTokens"].as_f64() {
            settings.reserve_tokens = reserve;
        }
        let preparation = prepare_compaction(entries, settings).expect("a preparation");
        let mut model = json!({
            "id": "claude-test", "name": "Claude Test", "api": "anthropic-messages", "provider": "anthropic",
            "baseUrl": "https://example.invalid", "reasoning": true, "input": ["text"],
            "cost": {"input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 200000, "maxTokens": 8192,
        });
        if let Some(Value::Object(overrides)) = case.get("model") {
            for (key, value) in overrides {
                model[key] = value.clone();
            }
        }
        let model: Model = serde_json::from_value(model).unwrap();
        let scripted = Scripted {
            scripts: Mutex::new(case["responses"].as_array().unwrap().clone()),
            requests: Mutex::new(Vec::new()),
        };
        let controller = AbortController::new();
        if case["abortBefore"] == true {
            controller.abort();
        }
        let log = Log::default();
        let summarizer = Summarizer {
            model: &model,
            stream: &scripted,
            api_key: case["apiKey"].as_str().map(str::to_string),
            headers: case["headers"].as_object().cloned(),
            env: None,
            signal: controller.signal(),
            thinking_level: case["thinkingLevel"].as_str().map(str::to_string),
            session_id: case["sessionId"].as_str().map(str::to_string),
            retry: policy(&case["retry"]),
            callbacks: &log,
            clock: relay_agent::now,
        };
        let mut actual = Map::new();
        actual.insert(
            "requests".into(),
            Value::Array(scripted.requests.lock().unwrap().clone()),
        );
        let outcome = summarizer
            .compact(&preparation, case["customInstructions"].as_str())
            .await;
        actual.insert(
            "requests".into(),
            Value::Array(scripted.requests.lock().unwrap().clone()),
        );
        actual.insert(
            "callbacks".into(),
            Value::Array(log.0.lock().unwrap().clone()),
        );
        match outcome {
            Ok(result) => actual.insert("result".into(), result.to_json()),
            Err(error) => actual.insert("error".into(), json!(error)),
        };
        let actual = normalize(&Value::Object(actual), None);
        for field in ["requests", "callbacks", "result", "error"] {
            let expected = case.get(field).cloned().unwrap_or(Value::Null);
            let actual = actual.get(field).cloned().unwrap_or(Value::Null);
            differences(
                &format!("{name}: {field}"),
                &expected,
                &actual,
                &mut failures,
            );
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn the_retry_loop_matches_the_typescript_one() {
    let recorded = fixture("retry.json");
    let mut failures = Vec::new();
    for case in recorded["classify"].as_array().unwrap() {
        let text = case["errorMessage"].as_str().unwrap();
        let message = if text == "overloaded but stopped" {
            response(&json!({"stopReason": "stop", "errorMessage": "overloaded"}))
        } else if text.is_empty() {
            response(&json!({"stopReason": "error"}))
        } else {
            response(&json!({"stopReason": "error", "errorMessage": text}))
        };
        differences(
            &format!("retryable {text:?}"),
            &case["retryable"],
            &json!(is_retryable_assistant_error(&message)),
            &mut failures,
        );
    }
    for case in recorded["delays"].as_array().unwrap() {
        let delay = agent_retry_delay_ms(
            case["policy"]["baseDelayMs"].as_f64().unwrap(),
            case["policy"]["maxAgentDelayMs"].as_f64(),
            case["attempt"].as_u64().unwrap() as u32,
        );
        differences(
            &format!("delay {case}"),
            &case["delay"],
            &relay_ai::json::js_number(delay),
            &mut failures,
        );
    }
    for case in recorded["runs"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let scripts = Mutex::new(case["responses"].as_array().unwrap().clone());
        let calls = Mutex::new(0);
        let log = Log::default();
        let controller = AbortController::new();
        if case["abortBefore"] == true {
            controller.abort();
        }
        let signal = controller.signal();
        let result = retry_assistant_call(
            || {
                *calls.lock().unwrap() += 1;
                let script = {
                    let mut scripts = scripts.lock().unwrap();
                    if scripts.is_empty() {
                        json!({})
                    } else {
                        scripts.remove(0)
                    }
                };
                async move { response(&script) }
            },
            policy(&case["policy"]),
            &signal,
            &log,
        )
        .await;
        let actual = json!({
            "calls": *calls.lock().unwrap(),
            "callbacks": log.0.lock().unwrap().clone(),
            "result": {"stopReason": result.stop_reason, "errorMessage": result.error_message},
        });
        for field in ["calls", "callbacks", "result"] {
            differences(
                &format!("{name}: {field}"),
                &case[field],
                &actual[field],
                &mut failures,
            );
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
