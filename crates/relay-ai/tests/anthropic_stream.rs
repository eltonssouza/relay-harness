//! The Anthropic streams in `crates/fixtures/anthropic-stream/` (`npm run parity:record`), decoded
//! in Rust from the same byte chunks: the same events and the same final message.

use std::fs;
use std::path::PathBuf;

use relay_ai::anthropic::uses_oauth;
use relay_ai::anthropic_stream::AnthropicStream;
use relay_ai::{Message, Model};
use serde_json::Value;

fn cases() -> Vec<(String, Value)> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/anthropic-stream");
    let mut files: Vec<PathBuf> = fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("{}: {error}", directory.display()))
        .map(|entry| entry.unwrap().path())
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            (
                name,
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap(),
            )
        })
        .collect()
}

/// The same JSON content: numbers by value (`0` is `0.0`), objects without key order.
fn same(recorded: &Value, decoded: &Value) -> bool {
    match (recorded, decoded) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| same(value, other)))
        }
        _ => recorded == decoded,
    }
}

fn chunks(bytes: &[u8], splits: &[usize]) -> Vec<Vec<u8>> {
    let mut chunks = Vec::new();
    let mut start = 0;
    for split in splits.iter().copied().chain([bytes.len()]) {
        if split > start {
            chunks.push(bytes[start..split].to_vec());
        }
        start = start.max(split);
    }
    chunks
}

#[test]
fn decodes_the_streams_as_the_typescript_adapter_does() {
    let cases = cases();
    assert!(cases.len() >= 20, "only {} cases", cases.len());
    let mut failures = Vec::new();
    for (name, case) in cases {
        let model: Model = serde_json::from_value(case["model"].clone()).unwrap();
        let messages: Vec<Message> = serde_json::from_value(case["messages"].clone()).unwrap();
        let oauth = uses_oauth(&model, case["apiKey"].as_str().unwrap());
        let splits: Vec<usize> = serde_json::from_value(case["splits"].clone()).unwrap();
        let body = case["sse"].as_str().unwrap().as_bytes();

        let mut stream = AnthropicStream::new(&model, &messages, oauth, None, || 0);
        let mut events = vec![stream.start()];
        for chunk in chunks(body, &splits) {
            events.extend(stream.push(&chunk));
        }
        events.extend(stream.finish());
        let decoded = serde_json::to_value(&events).unwrap();

        let recorded = &case["events"];
        if !same(recorded, &decoded) {
            let recorded = recorded.as_array().unwrap();
            let decoded = decoded.as_array().unwrap();
            let position = recorded
                .iter()
                .zip(decoded)
                .position(|(a, b)| !same(a, b))
                .unwrap_or(recorded.len().min(decoded.len()));
            failures.push(format!(
                "{name}: event {position} differs ({} recorded, {} decoded)\n-- TypeScript\n{}\n-- Rust\n{}",
                recorded.len(),
                decoded.len(),
                recorded.get(position).map(Value::to_string).unwrap_or_default(),
                decoded.get(position).map(Value::to_string).unwrap_or_default(),
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
