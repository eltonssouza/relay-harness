//! Replays `crates/fixtures/resources/context.json`, what the TypeScript resource loader read
//! (`packages/coding-agent/test/parity/context-record.ts`): git paths, context files and the
//! project guide's path over a tree of folders and git layouts, then the system prompt files.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use relay_resources::{
    find_git_paths, load_project_context_files, load_prompt_files, project_agents_path,
    ContextFile, GitPaths, PromptFileOptions,
};
use relay_settings::trust::canonicalize_path;
use serde_json::{json, Value};

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/resources/context.json");
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

/// The recorder's `portable`: `<root>` for the tree, `/` after it.
fn portable(value: &Value, root: &str) -> Value {
    match value {
        Value::String(text) => {
            let replaced = text.replace(root, "<root>");
            let mut out = String::new();
            let mut rest = replaced.as_str();
            while let Some(index) = rest.find("<root>") {
                out.push_str(&rest[..index]);
                let tail = &rest[index..];
                let end = tail
                    .find(|character: char| {
                        matches!(character, '"' | '\'' | ')') || character.is_whitespace()
                    })
                    .unwrap_or(tail.len());
                out.push_str(&tail[..end].replace('\\', "/"));
                rest = &tail[end..];
            }
            out.push_str(rest);
            Value::String(out)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| portable(item, root)).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(name, item)| (name.clone(), portable(item, root)))
                .collect(),
        ),
        other => other.clone(),
    }
}

struct Tree(String);

impl Tree {
    fn new(entries: &[Value]) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("relay-context-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // The real path, as the recorder takes it.
        let root = canonicalize_path(&dir.to_string_lossy());
        for entry in entries {
            let path = entry[0].as_str().unwrap();
            let full = Path::new(&root).join(path);
            match entry[1].as_str() {
                None => fs::create_dir_all(&full).unwrap(),
                Some(content) => {
                    fs::create_dir_all(full.parent().unwrap()).unwrap();
                    fs::write(&full, content.replace("<root>", &root)).unwrap();
                }
            }
        }
        Tree(root)
    }

    /// `path.join(root, path)`.
    fn at(&self, path: &str) -> String {
        relay_tools::paths::node_join(&self.0, path, cfg!(windows))
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn git_json(paths: Option<GitPaths>) -> Value {
    paths.map_or(Value::Null, |paths| {
        json!({"repoDir": paths.repo_dir, "commonGitDir": paths.common_git_dir, "headPath": paths.head_path})
    })
}

/// The files in the tree, as the recorder keeps them.
fn files_json(files: &[ContextFile], root: &str) -> Value {
    Value::Array(
        files
            .iter()
            .filter(|file| file.path.starts_with(root))
            .map(|file| json!({"path": file.path, "content": file.content}))
            .collect(),
    )
}

#[test]
fn context_and_prompt_files_match_the_typescript_ones() {
    let recorded = fixture();
    let tree = Tree::new(recorded["tree"].as_array().unwrap());
    let root = tree.0.clone();
    let mut failures = Vec::new();

    for case in recorded["context"].as_array().unwrap() {
        let cwd = case["cwd"].as_str().unwrap();
        let agent_dir = case["agentDir"].as_str().unwrap();
        let context = load_project_context_files(&tree.at(cwd), &tree.at(agent_dir));
        let actual = json!({
            "cwd": cwd,
            "agentDir": agent_dir,
            "gitPaths": git_json(find_git_paths(&tree.at(cwd))),
            "files": files_json(&context.files, &root),
        });
        // Every file of the tree is readable; a folder named like a context file is skipped.
        if !context.warnings.is_empty() {
            failures.push(format!("context {cwd}: warnings {:?}", context.warnings));
        }
        differences(
            &format!("context {cwd} from {agent_dir}"),
            case,
            &portable(&actual, &root),
            &mut failures,
        );
    }

    for case in recorded["prompts"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let source = |text: &Value| text.as_str().unwrap().replace("<root>", &root);
        let cwd = tree.at(case["cwd"].as_str().unwrap());
        let agent_dir = tree.at(case["agentDir"].as_str().unwrap());
        let options = &case["options"];
        let files = load_prompt_files(&PromptFileOptions {
            cwd: cwd.clone(),
            agent_dir: agent_dir.clone(),
            project_trusted: case["trusted"] == true,
            system_prompt: options.get("systemPrompt").map(source),
            append_system_prompt: options
                .get("appendSystemPrompt")
                .map(|sources| sources.as_array().unwrap().iter().map(source).collect()),
        });
        let no_context = case["noContextFiles"] == true;
        let agents_files = if no_context {
            json!([])
        } else {
            files_json(&load_project_context_files(&cwd, &agent_dir).files, &root)
        };
        let actual = portable(
            &json!({
                "systemPrompt": files.system_prompt.clone().unwrap_or_else(|| "<undefined>".into()),
                "systemPromptSource": files.system_prompt_source.clone().unwrap_or_else(|| "<undefined>".into()),
                "appendSystemPrompt": files.append_system_prompt,
                "appendSystemPromptSources": files.append_system_prompt_sources,
                "agentsFiles": agents_files,
                "projectAgentsPath": if no_context { "<undefined>".to_string() } else { project_agents_path(&cwd) },
            }),
            &root,
        );
        for field in [
            "systemPrompt",
            "systemPromptSource",
            "appendSystemPrompt",
            "appendSystemPromptSources",
            "agentsFiles",
            "projectAgentsPath",
        ] {
            differences(
                &format!("prompts {name}: {field}"),
                &case[field],
                &actual[field],
                &mut failures,
            );
        }
        // A source that exists but cannot be read is reported, as the TypeScript loader warns.
        let unreadable = name == "unreadable prompt file" || name == "appended sources";
        if unreadable
            != files
                .warnings
                .iter()
                .any(|warning| warning.contains("folder.md"))
        {
            failures.push(format!("prompts {name}: warnings {:?}", files.warnings));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
