//! The messages the TypeScript agent recorded in `crates/fixtures/scenarios/` (`npm run
//! parity:record`) read into `Message` and write back with the same content.

use std::fs;
use std::path::PathBuf;

use relay_ai::{InputBlock, Message, OutputBlock, StopReason};
use serde_json::Value;

fn scenarios() -> Vec<(String, Value)> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/scenarios");
    let mut files: Vec<PathBuf> = fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("{}: {error}", directory.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no scenarios in {}", directory.display());
    files
        .into_iter()
        .map(|path| {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let text = fs::read_to_string(&path).unwrap();
            (name, serde_json::from_str(&text).unwrap())
        })
        .collect()
}

/// The same JSON content: objects compare without key order, numbers by value (`0` is `0.0`).
fn same(recorded: &Value, written: &Value) -> bool {
    match (recorded, written) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| same(value, other)))
        }
        _ => recorded == written,
    }
}

/// Every message a recording holds, with where it is.
fn messages(recording: &Value) -> Vec<(String, &Value)> {
    let mut found = Vec::new();
    for (i, request) in recording["requests"].as_array().unwrap().iter().enumerate() {
        for (j, message) in request.as_array().unwrap().iter().enumerate() {
            found.push((format!("requests[{i}][{j}]"), message));
        }
    }
    for (i, entry) in recording["session"].as_array().unwrap().iter().enumerate() {
        if let Some(message) = entry.get("message") {
            found.push((format!("session[{i}].message"), message));
        }
    }
    for (i, event) in recording["events"].as_array().unwrap().iter().enumerate() {
        if let Some(message) = event.get("message") {
            found.push((format!("events[{i}].message"), message));
        }
        for field in ["messages", "toolResults"] {
            for (j, message) in event
                .get(field)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                found.push((format!("events[{i}].{field}[{j}]"), message));
            }
        }
    }
    found
}

#[test]
fn recorded_messages_read_and_write_back_unchanged() {
    for (name, recording) in scenarios() {
        let found = messages(&recording);
        assert!(!found.is_empty(), "{name} records no messages");
        for (place, recorded) in found {
            let message: Message = serde_json::from_value(recorded.clone())
                .unwrap_or_else(|error| panic!("{name} {place} does not read: {error}"));
            let written = serde_json::to_value(&message).unwrap();
            assert!(
                same(recorded, &written),
                "{name} {place} changed:\nrecorded {recorded}\nwritten  {written}"
            );
        }
    }
}

#[test]
fn a_field_the_types_do_not_know_is_caught() {
    // The round trip drops it, so the comparison above fails for a field the port misses.
    let recorded = serde_json::json!({
        "role": "user",
        "content": "hi",
        "timestamp": 0,
        "surprise": true,
    });
    let message: Message = serde_json::from_value(recorded.clone()).unwrap();
    assert!(!same(&recorded, &serde_json::to_value(&message).unwrap()));
    // A present null stays present.
    let recorded = serde_json::json!({
        "role": "toolResult",
        "toolCallId": "call_1",
        "toolName": "read",
        "content": [],
        "details": null,
        "isError": false,
        "timestamp": 0,
    });
    let message: Message = serde_json::from_value(recorded.clone()).unwrap();
    assert!(same(&recorded, &serde_json::to_value(&message).unwrap()));
}

#[test]
fn the_read_file_scenario_reads_the_file_then_answers() {
    let (_, recording) = scenarios()
        .into_iter()
        .find(|(name, _)| name == "read-file")
        .expect("the read-file scenario");
    let requests = recording["requests"].as_array().unwrap();
    assert_eq!(requests.len(), 2);
    let second: Vec<Message> = serde_json::from_value(requests[1].clone()).unwrap();
    let [Message::System(system), Message::User(_), Message::Assistant(call), Message::ToolResult(result)] =
        &second[..]
    else {
        panic!("unexpected second request: {second:?}");
    };
    let tools: Vec<&str> = system
        .tools_added
        .iter()
        .flatten()
        .map(|tool| tool.name.as_str())
        .collect();
    assert!(tools.contains(&"read"), "tools: {tools:?}");
    assert!(
        matches!(&call.content[..], [OutputBlock::ToolCall(tool_call)] if tool_call.name == "read" && tool_call.id == "call_1")
    );
    assert_eq!(call.stop_reason, StopReason::ToolUse);
    assert_eq!(result.tool_call_id, "call_1");
    assert!(
        matches!(&result.content[..], [InputBlock::Text(text)] if text.text.contains("The release is on Friday."))
    );
}
