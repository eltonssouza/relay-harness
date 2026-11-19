//! The Anthropic bodies the TypeScript adapter built for each case in `crates/fixtures/anthropic/`
//! (`npm run parity:record`), built again in Rust: the same JSON text, key order included.

use std::fs;
use std::path::PathBuf;

use relay_ai::anthropic::{build_request, uses_oauth, AnthropicOptions};
use relay_ai::{Message, Model};
use serde_json::Value;

fn cases() -> Vec<(String, Value)> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/anthropic");
    let mut files: Vec<PathBuf> = fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("{}: {error}", directory.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
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

#[test]
fn builds_the_bodies_the_typescript_adapter_builds() {
    let cases = cases();
    assert!(cases.len() >= 20, "only {} cases", cases.len());
    let mut failures = Vec::new();
    for (name, case) in cases {
        let model: Model = serde_json::from_value(case["model"].clone()).unwrap();
        let options: AnthropicOptions = serde_json::from_value(case["options"].clone()).unwrap();
        let messages: Vec<Message> = serde_json::from_value(case["messages"].clone()).unwrap();
        let oauth = uses_oauth(&model, case["apiKey"].as_str().unwrap());
        let expected = serde_json::to_string_pretty(&case["body"]).unwrap();
        match build_request(&model, &messages, oauth, &options) {
            Ok(body) => {
                let built = serde_json::to_string_pretty(&body).unwrap();
                if built != expected {
                    let line = built
                        .lines()
                        .zip(expected.lines())
                        .position(|(a, b)| a != b)
                        .unwrap_or(0);
                    let context = |text: &str| {
                        text.lines()
                            .skip(line.saturating_sub(3))
                            .take(8)
                            .collect::<Vec<_>>()
                            .join("\n")
                    };
                    failures.push(format!(
                        "{name}: first difference at line {}\n-- TypeScript\n{}\n-- Rust\n{}",
                        line + 1,
                        context(&expected),
                        context(&built)
                    ));
                }
            }
            Err(error) => failures.push(format!("{name}: {error}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn a_tool_that_requires_strict_mode_fails_on_a_model_without_it() {
    let model: Model = serde_json::from_value(serde_json::json!({
        "id": "claude-test",
        "api": "anthropic-messages",
        "provider": "anthropic",
        "baseUrl": "http://127.0.0.1:9",
        "reasoning": false,
        "input": ["text"],
        "maxTokens": 1000,
    }))
    .unwrap();
    let messages: Vec<Message> = serde_json::from_value(serde_json::json!([
        {
            "role": "system",
            "content": "",
            "toolsAdded": [{
                "name": "pick",
                "description": "Pick one.",
                "parameters": { "type": "object", "properties": {}, "required": [] },
                "constrainedSampling": { "type": "json_schema", "strict": "require" },
            }],
            "timestamp": 0,
        },
        { "role": "user", "content": "Pick.", "timestamp": 0 },
    ]))
    .unwrap();
    let error = build_request(&model, &messages, false, &AnthropicOptions::default()).unwrap_err();
    assert_eq!(
        error,
        "Tool \"pick\" requires JSON-schema constrained sampling, but strict tools are unsupported."
    );
}
