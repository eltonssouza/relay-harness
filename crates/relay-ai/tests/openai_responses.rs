//! The OpenAI Responses bodies the TypeScript adapter built for each case in
//! `crates/fixtures/openai-responses/`
//! (`npm run parity:record`), built again in Rust: the same JSON text, key order included.

use std::fs;
use std::path::PathBuf;

use relay_ai::openai_responses::{build_request, OpenAIResponsesOptions};
use relay_ai::{Message, Model};
use serde_json::Value;

fn cases() -> Vec<(String, Value)> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/openai-responses");
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
fn builds_the_responses_bodies_the_typescript_adapter_builds() {
    let cases = cases();
    assert!(cases.len() >= 20, "only {} cases", cases.len());
    let mut failures = Vec::new();
    for (name, case) in cases {
        let model: Model = serde_json::from_value(case["model"].clone()).unwrap();
        let options: OpenAIResponsesOptions =
            serde_json::from_value(case["options"].clone()).unwrap();
        let messages: Vec<Message> = serde_json::from_value(case["messages"].clone()).unwrap();
        let api_key = case["apiKey"].as_str();
        let expected = serde_json::to_string_pretty(&case["body"]).unwrap();
        match build_request(&model, &messages, api_key, &options) {
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
