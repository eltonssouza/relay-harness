//! Resolving a provider's auth as `resolveProviderAuth` does: the request's key, else the stored
//! credential, else the environment; an expiring OAuth token refreshed once under the
//! `auth.json` lock and saved.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use relay_ai::auth::{AuthContext, Credential};
use relay_ai::auth_file::AuthFile;
use relay_ai::oauth::{OAuthContext, OAuthRequest, OAuthResponse};
use relay_ai::resolve::{resolve_provider_auth, AuthOverrides};
use serde_json::{json, Value};

const NOW: f64 = 1_700_000_000_000.0;

/// Answers token requests from a script and counts them.
#[derive(Default)]
struct Tokens {
    answers: RefCell<Vec<(u16, Value)>>,
    requests: RefCell<Vec<String>>,
}

impl OAuthContext for Tokens {
    async fn fetch(&self, request: OAuthRequest) -> Result<OAuthResponse, String> {
        self.requests.borrow_mut().push(request.url);
        let (status, body) = self.answers.borrow_mut().remove(0);
        Ok(OAuthResponse {
            status,
            body: body.to_string(),
            ..OAuthResponse::default()
        })
    }
    async fn sleep(&self, _duration: Duration) {}
    fn now_ms(&self) -> f64 {
        NOW
    }
    fn env(&self, _name: &str) -> Option<String> {
        None
    }
}

#[derive(Default)]
struct Environment(HashMap<&'static str, &'static str>);

impl AuthContext for Environment {
    fn env(&self, name: &str) -> Option<String> {
        self.0.get(name).map(|value| value.to_string())
    }
    fn file_exists(&self, _path: &str) -> bool {
        false
    }
}

fn auth_file(name: &str, data: Value) -> AuthFile {
    let directory: PathBuf =
        std::env::temp_dir().join(format!("relay-resolve-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).unwrap();
    let file = AuthFile::in_agent_dir(&directory);
    fs::write(file.path(), data.to_string()).unwrap();
    file
}

fn anthropic_token(expires: f64) -> Value {
    json!({ "anthropic": { "type": "oauth", "refresh": "refresh-1", "access": "access-1", "expires": expires } })
}

#[tokio::test]
async fn a_valid_token_is_used_as_stored() {
    let file = auth_file("valid", anthropic_token(NOW + 3_600_000.0));
    let tokens = Tokens::default();
    let result = resolve_provider_auth(
        "anthropic",
        &file,
        &Environment::default(),
        &tokens,
        &AuthOverrides::default(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.auth.api_key.as_deref(), Some("access-1"));
    assert_eq!(result.source.as_deref(), Some("OAuth"));
    assert!(tokens.requests.borrow().is_empty());
}

#[tokio::test]
async fn an_expiring_token_is_refreshed_once_and_saved() {
    let file = auth_file("expiring", anthropic_token(NOW + 60_000.0));
    let tokens = Tokens::default();
    tokens.answers.borrow_mut().push((
        200,
        json!({ "access_token": "access-2", "refresh_token": "refresh-2", "expires_in": 3600 }),
    ));
    let result = resolve_provider_auth(
        "anthropic",
        &file,
        &Environment::default(),
        &tokens,
        &AuthOverrides::default(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.auth.api_key.as_deref(), Some("access-2"));
    assert_eq!(tokens.requests.borrow().len(), 1);
    let Some(Credential::Oauth(saved)) = file.read("anthropic").unwrap() else {
        panic!("no OAuth credential saved")
    };
    assert_eq!(saved.access, "access-2");
    assert_eq!(saved.refresh, "refresh-2");
    assert_eq!(saved.expires, NOW + 3_600_000.0 - 300_000.0);

    // The saved token is valid now: a second resolve does not refresh.
    resolve_provider_auth(
        "anthropic",
        &file,
        &Environment::default(),
        &tokens,
        &AuthOverrides::default(),
    )
    .await
    .unwrap();
    assert_eq!(tokens.requests.borrow().len(), 1);
    assert!(!file.path().with_extension("json.lock").exists());
}

#[tokio::test]
async fn a_failed_refresh_keeps_the_stored_token() {
    let stored = anthropic_token(NOW - 1.0);
    let file = auth_file("failed", stored.clone());
    let tokens = Tokens::default();
    tokens
        .answers
        .borrow_mut()
        .push((400, json!({ "error": "invalid_grant" })));
    let error = resolve_provider_auth(
        "anthropic",
        &file,
        &Environment::default(),
        &tokens,
        &AuthOverrides::default(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "oauth");
    assert_eq!(error.message, "OAuth refresh failed for anthropic");
    assert!(error
        .cause
        .as_deref()
        .unwrap()
        .starts_with("Anthropic token refresh request failed."));
    let saved: Value = serde_json::from_str(&fs::read_to_string(file.path()).unwrap()).unwrap();
    assert_eq!(saved, stored);
}

#[tokio::test]
async fn a_token_still_short_lived_after_refresh_is_an_error_when_validity_is_required() {
    let file = auth_file("short", anthropic_token(NOW - 1.0));
    let tokens = Tokens::default();
    tokens.answers.borrow_mut().push((
        200,
        json!({ "access_token": "a", "refresh_token": "r", "expires_in": 600 }),
    ));
    let overrides = AuthOverrides {
        min_oauth_validity_ms: Some(30.0 * 60.0 * 1000.0),
        ..AuthOverrides::default()
    };
    let error = resolve_provider_auth(
        "anthropic",
        &file,
        &Environment::default(),
        &tokens,
        &overrides,
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.message,
        "OAuth refresh returned a token that expires too soon for anthropic"
    );
}

#[tokio::test]
async fn a_stored_key_owns_the_provider_and_a_request_key_wins() {
    let file = auth_file(
        "keys",
        json!({ "openai": { "type": "api_key", "key": "$RELAY_RESOLVE_KEY", "env": { "RELAY_RESOLVE_KEY": "stored-key" } } }),
    );
    let environment = Environment(HashMap::from([("OPENAI_API_KEY", "env-key")]));
    let tokens = Tokens::default();
    let stored = resolve_provider_auth(
        "openai",
        &file,
        &environment,
        &tokens,
        &AuthOverrides::default(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(stored.auth.api_key.as_deref(), Some("stored-key"));
    assert_eq!(stored.source.as_deref(), Some("stored credential"));

    let overrides = AuthOverrides {
        api_key: Some("request-key".into()),
        ..AuthOverrides::default()
    };
    let requested = resolve_provider_auth("openai", &file, &environment, &tokens, &overrides)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(requested.auth.api_key.as_deref(), Some("request-key"));
}

#[tokio::test]
async fn nothing_stored_reads_the_environment() {
    let file = auth_file("ambient", json!({}));
    let environment = Environment(HashMap::from([("GROQ_API_KEY", "env-key")]));
    let result = resolve_provider_auth(
        "groq",
        &file,
        &environment,
        &Tokens::default(),
        &AuthOverrides::default(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.auth.api_key.as_deref(), Some("env-key"));
    assert_eq!(result.source.as_deref(), Some("GROQ_API_KEY"));
}

#[tokio::test]
async fn a_credential_the_provider_cannot_use_leaves_it_unconfigured() {
    // Groq has no OAuth; the stored OAuth credential still owns it, so the environment is not read.
    let file = auth_file(
        "mismatch",
        json!({ "groq": { "type": "oauth", "refresh": "r", "access": "a", "expires": NOW } }),
    );
    let environment = Environment(HashMap::from([("GROQ_API_KEY", "env-key")]));
    let result = resolve_provider_auth(
        "groq",
        &file,
        &environment,
        &Tokens::default(),
        &AuthOverrides::default(),
    )
    .await
    .unwrap();
    assert_eq!(result, None);
}
