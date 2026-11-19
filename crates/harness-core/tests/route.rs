//! The Rust router against general-agents' `route.py`: `fixtures/route.json` holds the catalog,
//! the Portuguese alias table and what the Python script answered for the orchestrator's routing
//! cases (`npm run harness:route-golden -- <general-agents checkout>` regenerates it).

use relay_harness_core::route::{py_strip, RouteAgent, Router, Vocabulary};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/route.json")).expect("route fixture")
}

fn pairs(value: &Value) -> Vec<(String, String)> {
    value
        .as_array()
        .expect("pairs")
        .iter()
        .map(|pair| {
            (
                pair[0].as_str().expect("key").to_string(),
                pair[1].as_str().expect("value").to_string(),
            )
        })
        .collect()
}

/// Every number as a float: the fixture writes `18` where Python wrote `18.0`.
fn floats(value: &Value) -> Value {
    match value {
        Value::Number(number) => json!(number.as_f64().expect("number")),
        Value::Array(items) => Value::Array(items.iter().map(floats).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), floats(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn router(fixture: &Value) -> Router {
    let agents = fixture["agents"]
        .as_array()
        .expect("agents")
        .iter()
        .map(|agent| RouteAgent {
            name: agent["name"].as_str().expect("name").to_string(),
            description: agent["description"]
                .as_str()
                .expect("description")
                .to_string(),
            domain: agent["domain"].as_str().expect("domain").to_string(),
        })
        .collect();
    let vocabulary = &fixture["vocabulary"];
    Router::new(
        agents,
        Vocabulary::new(&pairs(&vocabulary["words"]), &pairs(&vocabulary["phrases"])),
    )
}

#[test]
fn routes_every_case_as_route_py_does() {
    let fixture = fixture();
    let router = router(&fixture);
    let cases = fixture["cases"].as_array().expect("cases");
    let mut differences = Vec::new();
    for case in cases {
        let query = case["query"].as_str().expect("query");
        let top = case["top"].as_u64().expect("top") as usize;
        let (clear, candidates) = router.route(query, top, case["domain"].as_str());
        let actual = json!({
            "query": py_strip(query),
            "clear_specialist": clear,
            "candidates": candidates.iter().map(|candidate| json!({
                "name": router.agents()[candidate.agent].name,
                "score": candidate.score,
                "strength": candidate.strength,
                "terms": candidate.terms,
                "exclusion_alert": candidate.exclusion_alert,
            })).collect::<Vec<_>>(),
        });
        if floats(&actual) != floats(&case["expected"]) {
            differences.push(format!(
                "{query}\n  expected {}\n  actual   {actual}",
                case["expected"]
            ));
        }
    }
    assert!(
        differences.is_empty(),
        "{} of {} cases differ from route.py:\n{}",
        differences.len(),
        cases.len(),
        differences.join("\n")
    );
}

#[test]
fn the_fixture_covers_portuguese_alerts_and_no_specialist() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("cases");
    let unclear = cases
        .iter()
        .filter(|case| case["expected"]["clear_specialist"] == false)
        .count();
    let alerts = cases
        .iter()
        .filter(|case| {
            case["expected"]["candidates"]
                .as_array()
                .is_some_and(|candidates| {
                    candidates.iter().any(|c| c["exclusion_alert"] != json!([]))
                })
        })
        .count();
    assert!(cases.len() >= 160, "{} cases", cases.len());
    assert!(unclear >= 6, "{unclear} cases without a clear specialist");
    assert!(alerts >= 10, "{alerts} cases with an exclusion alert");
}
