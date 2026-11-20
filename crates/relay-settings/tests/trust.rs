//! Replays `crates/fixtures/settings/trust.json`, what the TypeScript project trust did
//! (`packages/coding-agent/test/parity/trust-record.ts`): the trust store over a tree of folders,
//! the prompt's options, which folders need trust, and the decision with scripted answers.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use relay_settings::trust::{
    answer_trust_prompt, has_trust_requiring_project_resources, project_trust_options,
    project_trust_parent_path, resolve_project_trusted, ProjectTrustInput, ProjectTrustStore,
    TrustError, TrustOption, TrustResolution, TrustUpdate,
};
use serde_json::{json, Map, Value};

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/settings/trust.json");
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
            let escaped = serde_json::to_string(root).unwrap();
            let escaped = &escaped[1..escaped.len() - 1];
            let replaced = text.replace(escaped, "<root>").replace(root, "<root>");
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
                out.push_str(&tail[..end].replace("\\\\", "/").replace('\\', "/"));
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

/// `value` with every string equal to `from` replaced by `to`.
fn replace_exact(value: &Value, from: &str, to: &str) -> Value {
    match value {
        Value::String(text) if text == from => json!(to),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| replace_exact(item, from, to))
                .collect(),
        ),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(name, item)| (name.clone(), replace_exact(item, from, to)))
                .collect(),
        ),
        other => other.clone(),
    }
}

struct Tree(PathBuf);

impl Tree {
    fn new(entries: &[Value]) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("relay-trust-{}-{nanos}", std::process::id()));
        for entry in entries {
            let path = entry.as_str().unwrap();
            let full = root.join(path);
            if path.ends_with('/') {
                fs::create_dir_all(&full).unwrap();
            } else {
                fs::create_dir_all(full.parent().unwrap()).unwrap();
                fs::write(&full, "").unwrap();
            }
        }
        Tree(root)
    }

    fn root(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }

    fn at(&self, path: &str) -> String {
        self.0.join(path).to_string_lossy().into_owned()
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// An outcome as the recorder writes it.
fn outcome(result: Result<Value, TrustError>) -> Map<String, Value> {
    let mut object = Map::new();
    match result {
        Ok(value) => {
            object.insert("result".into(), value);
        }
        Err(error) if error.syntax => {
            // The recorder's `/^(Failed to read trust store .*?): /`.
            const PREFIX: &str = "Failed to read trust store ";
            let end = error.message[PREFIX.len()..].find(": ").unwrap() + PREFIX.len();
            assert!(error.message.starts_with(PREFIX), "{}", error.message);
            object.insert("syntaxError".into(), json!(error.message[..end]));
        }
        Err(error) => {
            object.insert("error".into(), json!(error.message));
        }
    }
    object
}

fn option_json(option: &TrustOption) -> Value {
    let mut object = Map::new();
    object.insert("label".into(), json!(option.label));
    object.insert("trusted".into(), json!(option.trusted));
    object.insert(
        "updates".into(),
        Value::Array(
            option
                .updates
                .iter()
                .map(|update| json!({"path": update.path, "decision": update.decision}))
                .collect(),
        ),
    );
    if let Some(path) = &option.saved_path {
        object.insert("savedPath".into(), json!(path));
    }
    Value::Object(object)
}

#[test]
fn project_trust_decides_as_the_typescript_one_does() {
    let recorded = fixture();
    let tree = Tree::new(recorded["tree"].as_array().unwrap());
    std::env::set_var("HOME", tree.at("home"));
    let root = tree.root();
    let mut failures = Vec::new();

    let store = ProjectTrustStore::new(&tree.at("agent"));
    let trust_file = tree.at("agent/trust.json");
    for (index, recorded_step) in recorded["steps"].as_array().unwrap().iter().enumerate() {
        let step = &recorded_step["step"];
        let cwd = step["cwd"].as_str().map(|cwd| tree.at(cwd));
        let result = match step["op"].as_str().unwrap() {
            "get" => store
                .get(cwd.as_deref().unwrap())
                .map(|decision| json!(decision)),
            "getEntry" => store.get_entry(cwd.as_deref().unwrap()).map(|entry| {
                entry.map_or(
                    Value::Null,
                    |entry| json!({"path": entry.path, "decision": entry.decision}),
                )
            }),
            "set" => store
                .set(cwd.as_deref().unwrap(), step["decision"].as_bool())
                .map(|()| json!("<undefined>")),
            "setMany" => {
                let updates: Vec<TrustUpdate> = step["updates"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|update| TrustUpdate {
                        path: tree.at(update["path"].as_str().unwrap()),
                        decision: update["decision"].as_bool(),
                    })
                    .collect();
                store.set_many(&updates).map(|()| json!("<undefined>"))
            }
            "file" => fs::read_to_string(&trust_file)
                .map(Value::String)
                .map_err(|error| TrustError {
                    message: relay_tools::js::fs_error(&error, "open", &trust_file),
                    syntax: false,
                }),
            "writeFile" => {
                fs::write(&trust_file, step["content"].as_str().unwrap()).unwrap();
                Ok(Value::Null)
            }
            "writeEntries" => {
                // Keyed as `path.join` spells the folders.
                let entries: Map<String, Value> = step["entries"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(path, value)| {
                        let key =
                            relay_tools::paths::node_resolve(&[&tree.at(path)], cfg!(windows));
                        (key, value.clone())
                    })
                    .collect();
                fs::write(&trust_file, Value::Object(entries).to_string()).unwrap();
                Ok(Value::Null)
            }
            other => panic!("unknown step {other}"),
        };
        let mut actual = Map::new();
        actual.insert("step".into(), step.clone());
        actual.extend(outcome(result));
        differences(
            &format!("step {index} {step}"),
            recorded_step,
            &portable(&Value::Object(actual), &root),
            &mut failures,
        );
    }

    for case in recorded["options"].as_array().unwrap() {
        let folder = tree.at(case["folder"].as_str().unwrap());
        let actual = json!({
            "folder": case["folder"],
            "parent": project_trust_parent_path(&folder).unwrap_or_else(|| "<undefined>".into()),
            "options": project_trust_options(&folder, false).iter().map(option_json).collect::<Vec<_>>(),
            "withSessionOnly": project_trust_options(&folder, true).iter().map(option_json).collect::<Vec<_>>(),
        });
        differences(
            &format!("options {}", case["folder"]),
            case,
            &portable(&actual, &root),
            &mut failures,
        );
    }

    // The file system's root has no parent; the recorder writes it as `<fs-root>`.
    let fs_root = Path::new(&root)
        .ancestors()
        .last()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let root_options = json!({
        "parent": project_trust_parent_path(&fs_root).unwrap_or_else(|| "<undefined>".into()),
        "options": project_trust_options(&fs_root, false).iter().map(option_json).collect::<Vec<_>>(),
    });
    differences(
        "options of the file system's root",
        &recorded["rootOptions"],
        &replace_exact(&root_options, &fs_root, "<fs-root>"),
        &mut failures,
    );

    for case in recorded["resources"].as_array().unwrap() {
        let folder = case["folder"].as_str().unwrap();
        let actual = has_trust_requiring_project_resources(&tree.at(folder));
        differences(
            &format!("resources {folder}"),
            &case["result"],
            &json!(actual),
            &mut failures,
        );
    }

    for (index, case) in recorded["resolved"].as_array().unwrap().iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let store = ProjectTrustStore::new(&tree.at(&format!("agents/{index}")));
        if let Some(Value::Object(stored)) = case.get("stored") {
            for (path, decision) in stored {
                store.set(&tree.at(path), decision.as_bool()).unwrap();
            }
        }
        let cwd = tree.at(case["cwd"].as_str().unwrap());
        let input = ProjectTrustInput {
            cwd: &cwd,
            store: &store,
            trust_override: case["trustOverride"].as_bool(),
            default_project_trust: case["defaultProjectTrust"].as_str().unwrap_or("ask"),
            extension: None,
            has_ui: case["hasUI"] == true,
        };
        let mut prompts = Vec::new();
        let trusted = match resolve_project_trusted(&input).unwrap() {
            TrustResolution::Decided(trusted) => trusted,
            TrustResolution::Ask { title, options } => {
                let labels: Vec<String> =
                    options.iter().map(|option| option.label.clone()).collect();
                prompts.push(json!({"title": title, "labels": labels}));
                let answer = case["answer"]
                    .as_str()
                    .and_then(|prefix| labels.iter().find(|label| label.starts_with(prefix)));
                answer_trust_prompt(&store, &options, answer.map(String::as_str)).unwrap()
            }
        };
        let file = fs::read_to_string(store.path()).unwrap_or_else(|_| "<absent>".into());
        let actual = portable(
            &json!({"trusted": trusted, "prompts": prompts, "file": file}),
            &root,
        );
        for field in ["trusted", "prompts", "file"] {
            differences(
                &format!("resolve {name}: {field}"),
                &case[field],
                &actual[field],
                &mut failures,
            );
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn an_extension_decides_and_may_remember() {
    let tree = Tree::new(&[json!("work/.relay/settings.json")]);
    let store = ProjectTrustStore::new(&tree.at("agent"));
    let cwd = tree.at("work");
    let mut input = ProjectTrustInput {
        cwd: &cwd,
        store: &store,
        trust_override: None,
        default_project_trust: "always",
        extension: Some(relay_settings::trust::ExtensionTrust {
            trusted: false,
            remember: false,
        }),
        has_ui: true,
    };
    assert_eq!(
        resolve_project_trusted(&input).unwrap(),
        TrustResolution::Decided(false)
    );
    assert!(!Path::new(store.path()).exists());
    input.extension = Some(relay_settings::trust::ExtensionTrust {
        trusted: true,
        remember: true,
    });
    assert_eq!(
        resolve_project_trusted(&input).unwrap(),
        TrustResolution::Decided(true)
    );
    assert_eq!(store.get(&cwd).unwrap(), Some(true));
}

#[cfg(unix)]
#[test]
fn links_are_followed_as_node_follows_them() {
    let tree = Tree::new(&[json!("real/inner/")]);
    std::os::unix::fs::symlink(tree.at("real"), tree.at("link")).unwrap();
    let canonical = relay_settings::trust::canonicalize_path(&tree.at("link/inner"));
    assert_eq!(
        canonical,
        relay_settings::trust::canonicalize_path(&tree.at("real/inner"))
    );
    assert_eq!(
        relay_settings::trust::canonicalize_path("/no/such/path"),
        "/no/such/path"
    );
}
