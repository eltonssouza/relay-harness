//! The Rust classification must equal the TypeScript one for every reference command.
//!
//! `tests/fixtures/classification.json` is written by the TypeScript harness
//! (`npm run harness:golden`); a TypeScript test fails when it falls behind that code.

use relay_harness_core::effects::{
    classify_command, deletion_targets, risky_operations, ClassifyContext,
};
use serde_json::Value;

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| {
        items
            .iter()
            .map(|item| item.as_str().unwrap_or_default().to_string())
            .collect()
    })
}

#[test]
fn classifies_every_reference_command_as_the_typescript_harness_does() {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/classification.json"
    ))
    .expect("reference classifications");
    let golden: Value = serde_json::from_str(&text).expect("valid JSON");
    let context = ClassifyContext {
        cwd: golden["context"]["cwd"].as_str().map(str::to_string),
        home: golden["context"]["home"].as_str().map(str::to_string),
        temp_dir: None,
    };
    let entries = golden["entries"].as_array().expect("entries");
    let mut mismatches = Vec::new();
    for entry in entries {
        let command = entry["command"].as_str().expect("command");
        let verify_commands = strings(entry.get("verifyCommands")).unwrap_or_default();
        let effect = classify_command(command, &verify_commands, &context);
        let mut operations: Vec<String> = risky_operations(command, &context)
            .iter()
            .map(|operation| operation.as_str().to_string())
            .collect();
        operations.sort();
        let actual = (
            effect.kind.as_str().to_string(),
            effect.reason.clone(),
            effect.scope.clone(),
            effect.files.clone(),
            effect.writes.clone(),
            operations,
            deletion_targets(command),
        );
        let expected = (
            entry["kind"].as_str().unwrap_or_default().to_string(),
            entry
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string),
            strings(entry.get("scope")),
            strings(entry.get("files")),
            strings(entry.get("writes")),
            strings(entry.get("operations")).unwrap_or_default(),
            strings(entry.get("deletionTargets")),
        );
        if actual != expected {
            mismatches.push(format!(
                "{command:?}\n    rust:       {actual:?}\n    typescript: {expected:?}"
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} of {} commands differ:\n{}",
        mismatches.len(),
        entries.len(),
        mismatches.join("\n")
    );
}
