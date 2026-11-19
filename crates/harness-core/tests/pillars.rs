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
