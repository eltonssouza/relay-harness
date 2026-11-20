//! The Google Gemini requests in `crates/fixtures/google/` (`npm run parity:record`), built again
//! in Rust: the adapter's parameters as the same JSON text, the URL exactly, and the SDK's HTTP
//! body with the same content.

use std::fs;
use std::path::PathBuf;

use relay_ai::google::{build_params, request_url, wire_body, GoogleOptions};
use relay_ai::{Message, Model};
use serde_json::Value;

fn cases() -> Vec<(String, Value)> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/google");
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

/// The same JSON content: numbers by value, objects without key order.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| same(value, other)))
        }
        _ => a == b,
    }
}

#[test]
fn builds_the_requests_the_typescript_adapter_and_sdk_make() {
    let cases = cases();
    assert!(cases.len() >= 15, "only {} cases", cases.len());
    let mut failures = Vec::new();
    for (name, case) in cases {
        let model: Model = serde_json::from_value(case["model"].clone()).unwrap();
        let options: GoogleOptions = serde_json::from_value(case["options"].clone()).unwrap();
        let messages: Vec<Message> = serde_json::from_value(case["messages"].clone()).unwrap();
        let params = match build_params(&model, &messages, &options) {
            Ok(params) => params,
            Err(error) => {
                failures.push(format!("{name}: {error}"));
                continue;
            }
        };
        let built = serde_json::to_string_pretty(&params).unwrap();
        let expected = serde_json::to_string_pretty(&case["params"]).unwrap();
        if built != expected {
            let line = built
                .lines()
                .zip(expected.lines())
                .position(|(a, b)| a != b)
                .unwrap_or(0);
            let around = |text: &str| {
                text.lines()
                    .skip(line.saturating_sub(3))
                    .take(8)
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            failures.push(format!(
                "{name}: parameters differ at line {}\n-- TypeScript\n{}\n-- Rust\n{}",
                line + 1,
                around(&expected),
                around(&built)
            ));
        }
        let url = request_url(&model);
        if url != case["request"]["url"].as_str().unwrap() {
            failures.push(format!(
                "{name}: URL {url} instead of {}",
                case["request"]["url"]
            ));
        }
        let body = wire_body(&params);
        if !same(&case["request"]["body"], &body) {
            failures.push(format!(
                "{name}: HTTP body differs\n-- SDK\n{}\n-- Rust\n{body}",
                case["request"]["body"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
