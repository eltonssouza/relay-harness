//! Each OAuth provider's token refresh and request auth, replayed from what the TypeScript flows
//! did in `crates/fixtures/oauth/` (`npm run parity:record`): the same requests, the same refreshed
//! credential or error, the same auth.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use relay_ai::auth::{Credential, OAuthCredential};
use relay_ai::oauth::{refresh, to_auth, OAuthContext, OAuthRequest, OAuthResponse};
use serde_json::{json, Value};

struct Scripted {
    now: f64,
    env: BTreeMap<String, String>,
    answers: RefCell<Vec<Value>>,
    requests: RefCell<Vec<Value>>,
}

impl OAuthContext for Scripted {
    async fn fetch(&self, request: OAuthRequest) -> Result<OAuthResponse, String> {
        let headers: BTreeMap<String, String> = request
            .headers
            .iter()
            .map(|(name, value)| (name.to_lowercase(), value.clone()))
            .collect();
        self.requests.borrow_mut().push(json!({
            "method": request.method,
            "url": request.url,
            "headers": headers,
            "body": request.body,
        }));
        let mut answers = self.answers.borrow_mut();
        let index = answers
            .iter()
            .position(|answer| request.url.contains(answer["match"].as_str().unwrap()))
            .ok_or("fetch failed")?;
        let answer = answers.remove(index);
        Ok(OAuthResponse {
            status: answer["status"].as_u64().unwrap() as u16,
            status_text: String::new(),
            headers: answer["headers"]
                .as_object()
                .map(|headers| {
                    headers
                        .iter()
                        .map(|(name, value)| (name.clone(), value.as_str().unwrap().to_string()))
                        .collect()
                })
                .unwrap_or_default(),
            body: answer["body"].as_str().unwrap().to_string(),
        })
    }

    async fn sleep(&self, _duration: Duration) {}

    fn now_ms(&self) -> f64 {
        self.now
    }

    fn env(&self, name: &str) -> Option<String> {
        self.env
            .get(name)
            .filter(|value| !value.is_empty())
            .cloned()
    }
}

fn cases() -> Vec<(String, Value)> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/oauth");
    let mut files: Vec<PathBuf> = fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("{}: {error}", directory.display()))
        .map(|entry| entry.unwrap().path())
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            (
                name,
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap(),
            )
        })
        .collect()
}

fn oauth_credential(value: &Value) -> OAuthCredential {
    match serde_json::from_value(value.clone()).unwrap() {
        Credential::Oauth(credential) => credential,
        Credential::ApiKey(_) => panic!("not an OAuth credential"),
    }
}

/// V8 words `JSON.parse` failures its own way; compare such messages up to the parser's part.
fn same_message(rust: &str, typescript: &str) -> bool {
    match typescript.find("SyntaxError") {
        Some(index) => rust.starts_with(&typescript[..index]),
        None => rust == typescript,
    }
}

#[tokio::test]
async fn refreshes_as_the_typescript_flows_do() {
    let cases = cases();
    assert!(cases.len() >= 25, "only {} cases", cases.len());
    let mut failures = Vec::new();
    for (name, case) in cases {
        let provider = case["provider"].as_str().unwrap();
        let stored = oauth_credential(&case["credential"]);
        let ctx = Scripted {
            now: 1_700_000_000_000.0,
            env: case["env"]
                .as_object()
                .map(|env| {
                    env.iter()
                        .map(|(name, value)| (name.clone(), value.as_str().unwrap().to_string()))
                        .collect()
                })
                .unwrap_or_default(),
            answers: RefCell::new(case["answers"].as_array().unwrap().clone()),
            requests: RefCell::new(Vec::new()),
        };
        let outcome = refresh(provider, &stored, &ctx).await;
        let requests = Value::Array(ctx.requests.into_inner());
        if requests != case["requests"] {
            failures.push(format!(
                "{name}: requests\n  TypeScript {}\n  Rust       {requests}",
                case["requests"]
            ));
        }
        match (&outcome, case.get("result")) {
            (Ok(credential), Some(expected)) => {
                let written = serde_json::to_value(Credential::Oauth(credential.clone())).unwrap();
                if &written != expected {
                    failures.push(format!(
                        "{name}: credential\n  TypeScript {expected}\n  Rust       {written}"
                    ));
                }
            }
            (Err(message), None) => {
                let expected = case["error"].as_str().unwrap();
                if !same_message(message, expected) {
                    failures.push(format!(
                        "{name}: error\n  TypeScript {expected:?}\n  Rust       {message:?}"
                    ));
                }
            }
            (outcome, _) => failures.push(format!(
                "{name}: Rust {outcome:?}, TypeScript {}",
                case.get("result").unwrap_or(&case["error"])
            )),
        }
        let auth_from = outcome.as_ref().unwrap_or(&stored);
        match (to_auth(provider, auth_from), case.get("auth")) {
            (Ok(auth), Some(expected)) => {
                let written = serde_json::to_value(auth).unwrap();
                if &written != expected {
                    failures.push(format!(
                        "{name}: auth\n  TypeScript {expected}\n  Rust       {written}"
                    ));
                }
            }
            (Err(message), None) if message == case["authError"].as_str().unwrap() => {}
            (auth, _) => failures.push(format!(
                "{name}: auth Rust {auth:?}, TypeScript {}",
                case.get("auth").unwrap_or(&case["authError"])
            )),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
