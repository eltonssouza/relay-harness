//! `parseStreamingJson` on every prefix of streamed tool arguments, and `parseJsonWithRepair` on
//! malformed data, as recorded from the TypeScript helpers in `crates/fixtures/json/parse.json`.

use std::fs;
use std::path::PathBuf;

use relay_ai::json::{parse_json_with_repair, parse_streaming_json};
use serde_json::Value;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/json/parse.json");
    serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap()
}

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
fn parses_every_prefix_of_streamed_arguments() {
    let fixture = fixture();
    let mut failures = Vec::new();
    let mut checked = 0;
    for document in fixture["streamed"].as_array().unwrap() {
        for result in document["results"].as_array().unwrap() {
            let input = result["input"].as_str().unwrap();
            let parsed = parse_streaming_json(input);
            checked += 1;
            if !same(&result["output"], &parsed) {
                failures.push(format!(
                    "{input:?}: TypeScript {} but Rust {parsed}",
                    result["output"]
                ));
            }
        }
    }
    assert!(checked > 300, "only {checked} prefixes");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn repairs_malformed_json_as_the_typescript_helper_does() {
    for case in fixture()["repaired"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        match (parse_json_with_repair(input), case.get("output")) {
            (Ok(parsed), Some(output)) => assert!(same(output, &parsed), "{input:?}: {parsed}"),
            (Err(_), None) => {}
            (parsed, output) => panic!("{input:?}: TypeScript {output:?}, Rust {parsed:?}"),
        }
    }
}
