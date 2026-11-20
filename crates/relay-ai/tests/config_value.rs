//! Config values as the coding agent reads them, from `crates/fixtures/config-values.json`
//! (`npm run parity:record`), and `!command` values run through the shell.

use std::fs;
use std::path::PathBuf;

use relay_ai::config_value::{
    env_var_name, env_var_names, is_command, missing_env_var_names, resolve, run_command,
};
use serde_json::Value;

#[test]
fn reads_templates_as_the_coding_agent_does() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/config-values.json");
    let fixture: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let env = fixture["env"].as_object().unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 20);
    for case in cases {
        let config = case["config"].as_str().unwrap();
        let names = |value: &Value| -> Vec<String> {
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(is_command(config), case["command"], "{config:?}");
        assert_eq!(
            env_var_name(config).as_deref(),
            case["envVarName"].as_str(),
            "{config:?}"
        );
        assert_eq!(
            env_var_names(config),
            names(&case["envVarNames"]),
            "{config:?}"
        );
        assert_eq!(
            missing_env_var_names(config, Some(env)),
            names(&case["missing"]),
            "{config:?}"
        );
        if !is_command(config) {
            assert_eq!(
                resolve(config, Some(env)).as_deref(),
                case["resolved"].as_str(),
                "{config:?}"
            );
        }
    }
}

#[test]
fn runs_commands_and_takes_their_trimmed_output() {
    assert_eq!(run_command("echo  hello ").as_deref(), Some("hello"));
    assert_eq!(resolve("!echo cached", None).as_deref(), Some("cached"));
    assert_eq!(run_command("exit 3"), None);
    assert_eq!(run_command("echo"), None);
}
