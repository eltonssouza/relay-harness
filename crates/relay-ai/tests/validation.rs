//! Tool-argument validation replayed from what `validateToolArguments` returned in
//! `crates/fixtures/validation.json` (`npm run parity:record`): the same converted arguments, or the
//! same error message, for the built-in tools' schemas (with TypeBox's conversion) and plain JSON
//! schemas.

use std::fs;
use std::path::PathBuf;

use relay_ai::validation::validate_tool_arguments;
use serde_json::Value;

#[test]
fn validates_as_typescript_does() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/validation.json");
    let fixture: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 100, "only {} cases", cases.len());
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let tool = name.split('-').next().unwrap();
        let outcome = validate_tool_arguments(
            tool,
            &case["schema"],
            case["typebox"].as_bool().unwrap(),
            &case["args"],
        );
        let same = match (&outcome, case.get("result"), case.get("error")) {
            (Ok(result), Some(expected), _) => result == expected,
            (Err(message), _, Some(expected)) => message == expected.as_str().unwrap(),
            _ => false,
        };
        if !same {
            failures.push(format!(
                "{name} args {}:\n  TypeScript {}\n  Rust       {}",
                case["args"],
                case.get("result").unwrap_or(&case["error"]),
                match &outcome {
                    Ok(result) => result.to_string(),
                    Err(message) => format!("{message:?}"),
                }
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
