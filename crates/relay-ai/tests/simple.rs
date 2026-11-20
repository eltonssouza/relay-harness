//! The requests each TypeScript adapter's `streamSimple` built for the cases in
//! `crates/fixtures/simple/` (`npm run parity:record`), built again in Rust from the same
//! provider-neutral options: the same JSON text, key order included. Google's are the SDK
//! parameters.

use std::fs;
use std::path::PathBuf;

use relay_ai::simple::{
    anthropic_options, estimate_context_tokens, google_options, openai_completions_options,
    openai_responses_options, SimpleOptions,
};
use relay_ai::{anthropic, google, openai_completions, openai_responses, Message, Model};
use serde_json::Value;

fn cases() -> Vec<(String, Value)> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/simple");
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

fn build(case: &Value) -> Result<Value, String> {
    let model: Model = serde_json::from_value(case["model"].clone()).unwrap();
    let options: SimpleOptions = serde_json::from_value(case["options"].clone()).unwrap();
    let messages: Vec<Message> = serde_json::from_value(case["messages"].clone()).unwrap();
    match case["adapter"].as_str().unwrap() {
        "anthropic" => anthropic::build_request(
            &model,
            &messages,
            false,
            &anthropic_options(&model, &messages, &options),
        ),
        "responses" => openai_responses::build_request(
            &model,
            &messages,
            Some("sk-parity"),
            &openai_responses_options(&model, &messages, &options),
        ),
        "completions" => openai_completions::build_request(
            &model,
            &messages,
            &openai_completions_options(&model, &messages, &options),
        ),
        "google" => google::build_params(
            &model,
            &messages,
            &google_options(&model, &messages, &options)?,
        ),
        other => Err(format!("unknown adapter {other}")),
    }
}

#[test]
fn maps_simple_options_as_the_typescript_adapters_do() {
    let cases = cases();
    assert!(cases.len() >= 25, "only {} cases", cases.len());
    let mut failures = Vec::new();
    for (name, case) in cases {
        let expected = serde_json::to_string_pretty(&case["body"]).unwrap();
        match build(&case) {
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
fn a_compaction_summary_after_a_response_voids_its_usage() {
    let messages: Vec<Message> = serde_json::from_value(serde_json::json!([
        { "role": "user", "content": "x".repeat(40), "timestamp": 1 },
        {
            "role": "assistant",
            "content": [{ "type": "text", "text": "ok" }],
            "api": "openai-completions",
            "provider": "openai",
            "model": "m",
            "usage": {
                "input": 900, "output": 100, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
            },
            "stopReason": "stop",
            "timestamp": 2
        },
        { "role": "user", "content": "y".repeat(8), "timestamp": 3 }
    ]))
    .unwrap();
    // The usage (900 + 100 tokens, with no total reported) and the 2 tokens after it.
    assert_eq!(estimate_context_tokens(&messages), 1002);
    let mut summarized = messages.clone();
    if let Message::User(user) = &mut summarized[0] {
        user.timestamp = 5;
    }
    // A first message newer than the response: every message is estimated.
    assert_eq!(estimate_context_tokens(&summarized), 10 + 1 + 2);
}

#[test]
fn a_level_google_cannot_resolve_fails() {
    let model: Model = serde_json::from_value(serde_json::json!({
        "id": "gemini-3-pro-preview",
        "api": "google-generative-ai",
        "provider": "google",
        "baseUrl": "",
        "reasoning": true,
        "input": ["text"],
        "maxTokens": 1000,
        "contextWindow": 100000,
        "thinkingLevelMap": { "high": "extreme" }
    }))
    .unwrap();
    let options = SimpleOptions {
        reasoning: Some("high".into()),
        ..SimpleOptions::default()
    };
    assert_eq!(
        google_options(&model, &[], &options).unwrap_err(),
        "Unsupported Google thinking level mapping for google/gemini-3-pro-preview: high -> extreme"
    );
}
