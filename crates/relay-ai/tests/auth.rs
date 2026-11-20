//! Every built-in provider's API-key resolution, replayed from what the TypeScript resolvers
//! returned in `crates/fixtures/auth/` (`npm run parity:record`): the same branches, the same
//! auth, provider settings and source.

use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;

use relay_ai::auth::{provider, resolve_api_key, ApiKeyCredential, AuthContext, PROVIDERS};
use serde_json::{json, Value};

fn recordings() -> Vec<Value> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/auth");
    let mut files: Vec<PathBuf> = fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("{}: {error}", directory.display()))
        .map(|entry| entry.unwrap().path())
        .collect();
    files.sort();
    files
        .iter()
        .map(|path| serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap())
        .collect()
}

/// Variables are `v-<NAME>` when set; every lookup is logged.
struct Scripted {
    env: Vec<String>,
    files: Vec<String>,
    lookups: RefCell<(Vec<String>, Vec<String>)>,
}

impl AuthContext for Scripted {
    fn env(&self, name: &str) -> Option<String> {
        self.lookups.borrow_mut().0.push(name.to_string());
        self.env
            .iter()
            .any(|set| set == name)
            .then(|| format!("v-{name}"))
    }

    fn file_exists(&self, path: &str) -> bool {
        self.lookups.borrow_mut().1.push(path.to_string());
        self.files.iter().any(|file| file == path)
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn describes_each_provider_as_typescript_does() {
    let recordings = recordings();
    assert_eq!(recordings.len(), PROVIDERS.len());
    for recording in &recordings {
        let id = recording["provider"].as_str().unwrap();
        let auth = provider(id).unwrap_or_else(|| panic!("{id} is not in PROVIDERS"));
        assert_eq!(auth.name, recording["name"], "{id}");
        assert_eq!(
            auth.api_key.map(|api_key| api_key.name()),
            recording["apiKey"]["name"].as_str(),
            "{id}"
        );
        let oauth = auth.oauth.map(|oauth| {
            let mut info = json!({ "name": oauth.name });
            if let Some(subscription) = oauth.is_subscription {
                info["isSubscription"] = json!(subscription);
            }
            if let Some(label) = oauth.login_label {
                info["loginLabel"] = json!(label);
            }
            info
        });
        assert_eq!(oauth.unwrap_or(Value::Null), recording["oauth"], "{id}");
    }
}

#[test]
fn resolves_api_keys_as_typescript_does() {
    let mut failures = Vec::new();
    let mut count = 0;
    for recording in recordings() {
        let id = recording["provider"].as_str().unwrap().to_string();
        for case in recording["cases"].as_array().unwrap() {
            count += 1;
            let ctx = Scripted {
                env: strings(&case["env"]),
                files: strings(&case["files"]),
                lookups: RefCell::new((Vec::new(), Vec::new())),
            };
            let credential: Option<ApiKeyCredential> = case
                .get("credential")
                .map(|credential| serde_json::from_value(credential.clone()).unwrap());
            let result = resolve_api_key(&id, credential.as_ref(), &ctx);
            let written =
                result.map_or(Value::Null, |result| serde_json::to_value(result).unwrap());
            let (env, files) = ctx.lookups.into_inner();
            let looked_up = json!({ "env": env, "files": files });
            if written != case["result"] || looked_up != case["lookups"] {
                failures.push(format!(
                    "{id} env {} files {} credential {}:\n  TypeScript {} after {}\n  Rust       {written} after {looked_up}",
                    case["env"],
                    case["files"],
                    case.get("credential").unwrap_or(&Value::Null),
                    case["result"],
                    case["lookups"]
                ));
            }
        }
    }
    assert!(count > 500, "only {count} cases");
    assert!(
        failures.is_empty(),
        "{} of {count} cases differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
