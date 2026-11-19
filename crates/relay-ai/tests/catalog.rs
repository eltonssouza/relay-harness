//! The built-in catalog read from the same files the TypeScript catalog loads
//! (`packages/ai/src/providers/data/`): every provider file is compiled in, and every chat entry
//! reads into a `Model` and writes back unchanged, so nothing the catalog says is lost.

use std::fs;
use std::path::PathBuf;

use relay_ai::catalog::{entries_of_type, generated_at, model, models, providers};
use relay_ai::Model;
use serde_json::{json, Value};

fn data_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/ai/src/providers/data")
}

fn read_json(name: &str) -> Value {
    let path = data_directory().join(name);
    serde_json::from_str(&fs::read_to_string(&path).unwrap())
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

#[test]
fn compiles_in_every_provider_file() {
    let mut files: Vec<String> = fs::read_dir(data_directory())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".json") && !name.starts_with('.'))
        .map(|name| name.trim_end_matches(".json").to_string())
        .collect();
    files.sort();
    assert_eq!(providers().collect::<Vec<_>>(), files);

    let manifest = read_json(".manifest.json");
    let mut listed: Vec<String> = manifest["files"]
        .as_object()
        .unwrap()
        .keys()
        .map(|name| name.trim_end_matches(".json").to_string())
        .collect();
    listed.sort();
    assert_eq!(listed, files);
    assert_eq!(generated_at().as_deref(), manifest["generatedAt"].as_str());
}

#[test]
fn every_chat_entry_reads_back_unchanged() {
    let mut failures = Vec::new();
    let mut count = 0;
    for provider in providers() {
        let entries = entries_of_type(&read_json(&format!("{provider}.json")), "chat");
        let built = models(provider);
        assert_eq!(built.len(), entries.len(), "{provider}");
        for (entry, model) in entries.iter().zip(built) {
            count += 1;
            let written = serde_json::to_value(model).unwrap();
            // Value equality ignores key order; numbers must match in kind (10, not 10.0).
            if &written != entry {
                failures.push(format!(
                    "{provider}/{}:\n  catalog {entry}\n  written {written}",
                    model.id
                ));
            }
        }
    }
    assert!(count > 1000, "only {count} chat models");
    assert!(
        failures.is_empty(),
        "{} entries changed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn flattens_by_type_and_id() {
    let file = json!({
        "api-a": {
            "chat:one": { "id": "one", "type": "chat", "n": 1 },
            "image:pic": { "id": "pic", "type": "image" },
            "chat:two": { "id": "two", "type": "chat" }
        },
        "api-b": {
            "chat:one": { "id": "one", "type": "chat", "n": 2 },
            "chat:three": { "id": "three", "type": "chat" }
        }
    });
    let ids: Vec<Value> = entries_of_type(&file, "chat")
        .into_iter()
        .map(|entry| json!([entry["id"], entry.get("n")]))
        .collect();
    assert_eq!(
        ids,
        vec![
            json!(["one", 2]),
            json!(["two", null]),
            json!(["three", null])
        ]
    );
    assert_eq!(entries_of_type(&file, "image").len(), 1);
}

#[test]
fn finds_a_model_by_provider_and_id() {
    let first: &Model = models("anthropic").first().unwrap();
    assert_eq!(model("anthropic", &first.id), Some(first));
    assert_eq!(first.api, "anthropic-messages");
    assert!(model("anthropic", "no-such-model").is_none());
    assert!(models("no-such-provider").is_empty());
}
