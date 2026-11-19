//! The labelled cases of the harness benchmark (`corpus.json`) that need no model and no ledger:
//! risky and safe commands, checks and look-alikes, with and without declared commands. The same
//! floors as `harness-bench.test.ts`: no risky command lets through, no safe one asks, no
//! look-alike counts as a check, and every check is recognized. Cases marked `open` reproduce a
//! known defect and are left out.

use relay_harness_core::effects::{
    classify_command, requires_authorization, ClassifyContext, ToolEffectKind,
};
use serde_json::Value;

fn corpus() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/coding-agent/test/harness-bench/corpus.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("corpus.json")).expect("valid JSON")
}

/// The closed commands of a corpus list: plain strings, or objects without `open`.
fn commands(list: &Value) -> Vec<String> {
    list.as_array()
        .expect("command list")
        .iter()
        .filter_map(|entry| match entry {
            Value::String(command) => Some(command.clone()),
            Value::Object(fields) if !fields.contains_key("open") => {
                fields["command"].as_str().map(str::to_string)
            }
            _ => None,
        })
        .collect()
}

fn failing(list: &Value, wrong: impl Fn(&str) -> bool) -> Vec<String> {
    commands(list)
        .into_iter()
        .filter(|command| wrong(command))
        .collect()
}

#[test]
fn asks_before_every_risky_command_and_no_safe_one() {
    let corpus = corpus();
    let context = ClassifyContext::default();
    let gated =
        |command: &str| requires_authorization(classify_command(command, &[], &context).kind);
    assert_eq!(
        failing(&corpus["authorization"]["risky"], |command| !gated(command)),
        Vec::<String>::new()
    );
    assert_eq!(
        failing(&corpus["authorization"]["safe"], gated),
        Vec::<String>::new()
    );
}

#[test]
fn counts_checks_by_the_program_they_run() {
    let corpus = corpus();
    let context = ClassifyContext::default();
    let verifies = |command: &str, declared: &[String]| {
        classify_command(command, declared, &context).kind == ToolEffectKind::Verify
    };
    let plain = &corpus["verification"];
    assert_eq!(
        failing(&plain["checks"], |command| !verifies(command, &[])),
        Vec::<String>::new()
    );
    assert_eq!(
        failing(&plain["notChecks"], |command| verifies(command, &[])),
        Vec::<String>::new()
    );

    let declared_section = &corpus["declaredVerification"];
    let declared: Vec<String> = commands(&declared_section["verifyCommands"]);
    assert_eq!(
        failing(&declared_section["checks"], |command| !verifies(
            command, &declared
        )),
        Vec::<String>::new()
    );
    assert_eq!(
        failing(&declared_section["notChecks"], |command| verifies(
            command, &declared
        )),
        Vec::<String>::new()
    );
}
