//! Replays `crates/fixtures/resources/system-prompt.json`, what the TypeScript system prompt did
//! (`packages/coding-agent/test/parity/resources-record.ts`): the prompt's state and text for
//! scripted options, section patches, and the skills' listing.

use std::fs;
use std::path::Path;

use relay_ai::message::Sections;
use relay_resources::{
    build_system_prompt, build_system_prompt_state, diff_system_prompt_sections,
    format_skills_for_prompt, ContextFile, DocsPaths, Skill, SkillReadTool, SystemPromptOptions,
};
use serde_json::{json, Map, Value};

fn fixture() -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/resources/system-prompt.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn differences(label: &str, expected: &Value, actual: &Value, failures: &mut Vec<String>) {
    // Serialized, so key order counts.
    if serde_json::to_string(expected).unwrap() != serde_json::to_string(actual).unwrap() {
        failures.push(format!(
            "{label}\n    expected {expected}\n    actual   {actual}"
        ));
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| item.as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn string_map(value: &Value) -> Vec<(String, String)> {
    value
        .as_object()
        .map(|fields| {
            fields
                .iter()
                .map(|(name, text)| (name.clone(), text.as_str().unwrap().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn options(value: &Value) -> SystemPromptOptions {
    let text = |name: &str| {
        value
            .get(name)
            .map(|text| text.as_str().unwrap().to_string())
    };
    SystemPromptOptions {
        custom_prompt: text("customPrompt"),
        force_system_prompt: text("forceSystemPrompt"),
        selected_tools: value.get("selectedTools").map(strings),
        tool_snippets: string_map(&value["toolSnippets"]).into_iter().collect(),
        tool_guidelines: value["toolGuidelines"]
            .as_object()
            .map(|fields| {
                fields
                    .iter()
                    .map(|(name, rules)| (name.clone(), strings(rules)))
                    .collect()
            })
            .unwrap_or_default(),
        prompt_guidelines: strings(&value["promptGuidelines"]),
        append_system_prompt: text("appendSystemPrompt").unwrap_or_default(),
        sections: string_map(&value["sections"]),
        cwd: text("cwd").unwrap(),
        context_files: value["contextFiles"]
            .as_array()
            .map(|files| {
                files
                    .iter()
                    .map(|file| ContextFile {
                        path: file["path"].as_str().unwrap().into(),
                        content: file["content"].as_str().unwrap().into(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        project_agents_path: text("projectAgentsPath"),
        skills: value
            .get("skills")
            .map(|skills| serde_json::from_value::<Vec<Skill>>(skills.clone()).unwrap())
            .unwrap_or_default(),
        docs: DocsPaths {
            readme: "<package>/README.md".into(),
            docs: "<package>/docs".into(),
            examples: "<package>/examples".into(),
        },
    }
}

fn object(pairs: Vec<(String, Value)>) -> Value {
    Value::Object(pairs.into_iter().collect::<Map<_, _>>())
}

fn sections_json(sections: &Sections) -> Value {
    object(
        sections
            .0
            .iter()
            .map(|(name, text)| {
                (
                    name.clone(),
                    text.as_ref().map_or(Value::Null, |text| json!(text)),
                )
            })
            .collect(),
    )
}

fn outcome(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({ "result": value }),
        Err(error) => json!({ "error": error }),
    }
}

#[test]
fn the_system_prompt_matches_the_typescript_one() {
    let recorded = fixture();
    let mut failures = Vec::new();

    for case in recorded["prompts"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let options = options(&case["options"]);
        let state = outcome(build_system_prompt_state(&options).map(|state| {
            let mut fields = vec![("content".to_string(), json!(state.content))];
            if let Some(sections) = state.sections {
                fields.push((
                    "sections".into(),
                    object(
                        sections
                            .into_iter()
                            .map(|(name, text)| (name, json!(text)))
                            .collect(),
                    ),
                ));
            }
            object(fields)
        }));
        differences(
            &format!("{name}: state"),
            &case["state"],
            &state,
            &mut failures,
        );
        let text = outcome(build_system_prompt(&options).map(Value::String));
        differences(
            &format!("{name}: text"),
            &case["text"],
            &text,
            &mut failures,
        );
    }

    for case in recorded["diffs"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let previous: Sections = serde_json::from_value(case["previous"].clone()).unwrap();
        let current = string_map(&case["current"]);
        let patch = diff_system_prompt_sections(&previous, &current)
            .map_or_else(|| json!("<undefined>"), |patch| sections_json(&patch));
        differences(
            &format!("diff {name}"),
            &case["result"],
            &patch,
            &mut failures,
        );
    }

    let skills: Vec<Skill> = serde_json::from_value(recorded["skills"].clone()).unwrap();
    for case in recorded["skillLists"].as_array().unwrap() {
        let names = strings(&case["skills"]);
        let listed: Vec<Skill> = names
            .iter()
            .map(|name| {
                skills
                    .iter()
                    .find(|skill| &skill.name == name)
                    .unwrap()
                    .clone()
            })
            .collect();
        let tool = match case["tool"].as_str().unwrap() {
            "read" => SkillReadTool::Read,
            _ => SkillReadTool::Bash,
        };
        let text = format_skills_for_prompt(&listed, tool);
        differences(
            &format!("skills {}", case["name"]),
            &case["text"],
            &json!(text),
            &mut failures,
        );
    }

    // The skills read back as the TypeScript objects they were recorded from.
    differences(
        "skills",
        &recorded["skills"],
        &serde_json::to_value(&skills).unwrap(),
        &mut failures,
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
