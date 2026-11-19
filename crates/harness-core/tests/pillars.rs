//! The Rust alignment and evidence pillars must decide as the TypeScript ones do.
//!
//! `tests/fixtures/pillars.json` is written by the TypeScript harness (`npm run harness:golden`):
//! constraints, intent and corrections for each text, the alignment decision for each request and
//! answer, and the completion report for each scenario.

use relay_harness_core::alignment::{
    extract_constraints, is_correction, is_question_only, requests_action, AlignmentDecision,
    AlignmentPolicy, AlignmentPolicyOptions,
};
use relay_harness_core::effects::{
    classify_tool_call, ClassifyContext, ToolCall, ToolEffect, ToolEffectKind,
};
use relay_harness_core::evidence::{format_verification_request, EvidenceLedger};
use serde_json::{json, Value};

fn fixture() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pillars.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("pillars.json")).expect("valid JSON")
}

fn strings(value: &Value) -> Option<Vec<String>> {
    value.as_array().map(|items| {
        items
            .iter()
            .map(|item| item.as_str().unwrap_or_default().to_string())
            .collect()
    })
}

fn kind(name: &str) -> ToolEffectKind {
    match name {
        "read" => ToolEffectKind::Read,
        "write" => ToolEffectKind::Write,
        "execute" => ToolEffectKind::Execute,
        "verify" => ToolEffectKind::Verify,
        "destructive" => ToolEffectKind::Destructive,
        "external" => ToolEffectKind::External,
        other => panic!("unknown effect kind {other}"),
    }
}

fn effect(value: &Value) -> ToolEffect {
    ToolEffect {
        kind: kind(value["kind"].as_str().expect("kind")),
        paths: strings(&value["paths"]).unwrap_or_default(),
        command: value["command"].as_str().map(str::to_string),
        reason: value["reason"].as_str().map(str::to_string),
        scope: strings(&value["scope"]),
        files: strings(&value["files"]),
        writes: strings(&value["writes"]),
    }
}

fn decision(value: &AlignmentDecision) -> Value {
    match value {
        AlignmentDecision::Allow { via } => match via {
            Some(via) => json!({ "action": "allow", "via": via.as_str() }),
            None => json!({ "action": "allow" }),
        },
        AlignmentDecision::Block { reason, kind } => {
            json!({ "action": "block", "kind": kind.as_str(), "reason": reason })
        }
        AlignmentDecision::AskAuthorizer { fingerprint } => {
            json!({ "action": "ask", "fingerprint": fingerprint })
        }
    }
}

fn report_differences(label: &str, differences: Vec<String>, total: usize) {
    assert!(
        differences.is_empty(),
        "{} of {total} {label} differ:\n{}",
        differences.len(),
        differences.join("\n")
    );
}

#[test]
fn reads_texts_as_the_typescript_harness_does() {
    let fixture = fixture();
    let entries = fixture["texts"].as_array().expect("texts");
    let mut differences = Vec::new();
    for entry in entries {
        let text = entry["text"].as_str().expect("text");
        let actual = json!({
            "text": text,
            "constraints": extract_constraints(text),
            "questionOnly": is_question_only(text),
            "requestsAction": requests_action(text),
            "correction": is_correction(text),
        });
        if &actual != entry {
            differences.push(format!("rust:       {actual}\n    typescript: {entry}"));
        }
    }
    report_differences("texts", differences, entries.len());
}

#[test]
fn decides_alignment_as_the_typescript_harness_does() {
    let fixture = fixture();
    let context = ClassifyContext {
        cwd: Some("/work/app".into()),
        home: Some("/home/dev".into()),
        temp_dir: None,
    };
    let entries = fixture["alignment"].as_array().expect("alignment");
    let mut differences = Vec::new();
    for entry in entries {
        let tool_name = entry["toolName"].as_str().expect("toolName");
        let arguments = match entry["write"].as_str() {
            Some(path) => vec![
                ("path".to_string(), path.to_string()),
                ("content".to_string(), String::new()),
            ],
            None => vec![(
                "command".to_string(),
                entry["command"].as_str().unwrap_or_default().to_string(),
            )],
        };
        let effect = classify_tool_call(
            &ToolCall {
                name: tool_name.to_string(),
                arguments,
            },
            &[],
            &context,
        );
        let mut policy = AlignmentPolicy::new(AlignmentPolicyOptions::default());
        policy.observe_developer_message(entry["request"].as_str().expect("request"), 0.0, true);
        let first = policy.check(tool_name, &effect);
        let mut last = first.clone();
        if let (AlignmentDecision::Block { .. }, Some(answer)) = (&first, entry["answer"].as_str())
        {
            policy.observe_developer_message(answer, 1.0, true);
            last = policy.check(tool_name, &effect);
        }
        let constraints: Vec<String> = policy
            .constraints
            .list()
            .iter()
            .map(|constraint| constraint.text.clone())
            .collect();
        let actual = (decision(&first), decision(&last), json!(constraints));
        let expected = (
            entry["first"].clone(),
            entry["final"].clone(),
            entry["constraints"].clone(),
        );
        if actual != expected {
            differences.push(format!("{entry}\n    rust: {actual:?}"));
        }
    }
    report_differences("alignment cases", differences, entries.len());
}

#[test]
fn judges_completion_as_the_typescript_harness_does() {
    let fixture = fixture();
    let entries = fixture["completion"].as_array().expect("completion");
    let mut differences = Vec::new();
    for entry in entries {
        let mut ledger = EvidenceLedger::new(1, None);
        ledger.begin_request(true);
        for step in entry["steps"].as_array().expect("steps") {
            let is_error = step["isError"].as_bool().unwrap_or(false);
            ledger.record_tool_outcome(
                &effect(&step["effect"]),
                is_error,
                step["output"].as_str().unwrap_or_default(),
                None,
            );
        }
        let mut report = ledger.assess(entry["finalText"].as_str().expect("finalText"));
        let gated = ledger.should_gate(&mut report);
        let mut actual = json!({
            "name": entry["name"],
            "steps": entry["steps"],
            "finalText": entry["finalText"],
            "status": report.status.as_str(),
            "claimed": report.claimed,
            "changedPaths": report.changed_paths,
            "mutations": report.mutations,
            "pending": ledger.pending_changes(),
            "gated": gated,
            "verificationRequest": if gated { Some(format_verification_request(&report, &[])) } else { None },
        });
        if let Some(detail) = &report.detail {
            actual["detail"] = json!(detail);
        }
        if &actual != entry {
            differences.push(format!(
                "{}\n    rust:       {actual}\n    typescript: {entry}",
                entry["name"]
            ));
        }
    }
    report_differences("completion scenarios", differences, entries.len());
}

fn tool_call(value: &Value) -> ToolCall {
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
    ToolCall {
        name: value["name"].as_str().expect("name").to_string(),
        arguments,
    }
}

#[test]
fn elides_context_as_the_typescript_harness_does() {
    use relay_harness_core::context::{
        ContextMessage, ContextPolicyOptions, ContextToolCall, ContextWindowPolicy,
    };
    let fixture = fixture();
    let context = &fixture["context"];
    let options = &context["options"];
    let mut policy = ContextWindowPolicy::new(ContextPolicyOptions {
        keep_recent: options["keepRecent"].as_u64().expect("keepRecent") as usize,
        batch_size: options["batchSize"].as_u64().expect("batchSize") as usize,
        min_elide_chars: options["minElideChars"].as_u64().expect("minElideChars") as usize,
        max_digest_entries: 30,
        cwd: options["cwd"].as_str().map(str::to_string),
    });
    let transcript = context["transcript"].as_array().expect("transcript");
    let messages: Vec<ContextMessage> = transcript
        .iter()
        .map(|message| match message["role"].as_str() {
            Some("assistant") => ContextMessage::Assistant {
                tool_calls: message["toolCalls"]
                    .as_array()
                    .expect("toolCalls")
                    .iter()
                    .map(|call| ContextToolCall {
                        id: call["id"].as_str().expect("id").to_string(),
                        call: tool_call(call),
                        arguments_json: call["argumentsJson"]
                            .as_str()
                            .expect("argumentsJson")
                            .to_string(),
                        effect: None,
                    })
                    .collect(),
            },
            Some("toolResult") => ContextMessage::ToolResult {
                tool_call_id: message["toolCallId"]
                    .as_str()
                    .expect("toolCallId")
                    .to_string(),
                tool_name: message["toolName"].as_str().expect("toolName").to_string(),
                chars: message["chars"].as_u64().expect("chars") as usize,
                is_error: message["isError"].as_bool().expect("isError"),
            },
            _ => ContextMessage::Other,
        })
        .collect();
    let mut requests: Vec<Vec<String>> = Vec::new();
    let mut stubs = serde_json::Map::new();
    for length in 1..=messages.len() {
        let role = transcript[length - 1]["role"].as_str();
        if role != Some("user") && role != Some("toolResult") {
            continue;
        }
        let elided = policy.transform(&messages[..length]);
        stubs = elided
            .iter()
            .map(|(id, stub)| (id.clone(), json!(stub)))
            .collect();
        requests.push(elided.into_iter().map(|(id, _)| id).collect());
    }
    let stats = policy.stats();
    assert_eq!(
        json!(requests),
        context["requests"],
        "elided calls per request"
    );
    assert_eq!(Value::Object(stubs), context["stubs"], "stubs");
    assert_eq!(
        json!({ "elidedResults": stats.elided_results, "elidedChars": stats.elided_chars, "batches": stats.batches }),
        context["stats"],
        "stats"
    );
    assert_eq!(
        json!(policy.render_progress()),
        context["progress"],
        "progress digest"
    );
}

#[test]
fn renders_the_harness_state_as_the_typescript_harness_does() {
    use relay_harness_core::engine::{EngineOptions, HarnessEngine};
    let fixture = fixture();
    let workspace = ClassifyContext {
        cwd: Some("/work/app".into()),
        home: Some("/home/dev".into()),
        temp_dir: None,
    };
    for entry in fixture["state"].as_array().expect("state") {
        let mut engine = HarnessEngine::new(EngineOptions {
            workspace: workspace.clone(),
            ..EngineOptions::default()
        });
        for step in entry["steps"].as_array().expect("steps") {
            if let Some(request) = step["request"].as_str() {
                engine.begin_request(request);
            }
            if let Some(developer) = step["developer"].as_str() {
                engine.observe_developer_message(
                    developer,
                    0.0,
                    step["afterWork"].as_bool().unwrap_or(false),
                );
            }
            if let Some(path) = step["edit"].as_str() {
                let call = ToolCall {
                    name: "edit".into(),
                    arguments: vec![("path".into(), path.into())],
                };
                let effect = engine.classify(&call, None);
                engine.record_tool_outcome(&effect, false, "", None);
            }
            if let Some(command) = step["check"].as_str() {
                let call = ToolCall {
                    name: "bash".into(),
                    arguments: vec![("command".into(), command.into())],
                };
                let effect = engine.classify(&call, None);
                engine.record_tool_outcome(&effect, false, "ok", None);
            }
        }
        assert_eq!(
            json!(engine.render_state(None)),
            entry["state"],
            "{}",
            entry["steps"]
        );
    }
}
