//! `auth.json` as the TypeScript store reads and writes it: `JSON.stringify(data, null, 2)`,
//! entries kept in place, keys resolved through config values, the same rejections.

use std::fs;
use std::path::PathBuf;

use relay_ai::auth::{ApiKeyCredential, Credential, OAuthCredential};
use relay_ai::auth_file::AuthFile;
use serde_json::{json, Map};

fn scratch(name: &str) -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("relay-auth-file-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    directory
}

fn api_key(key: &str) -> Credential {
    Credential::ApiKey(ApiKeyCredential {
        key: Some(key.into()),
        env: None,
    })
}

fn oauth() -> Credential {
    let mut extra = Map::new();
    extra.insert("accountId".into(), json!("acct-1"));
    Credential::Oauth(OAuthCredential {
        refresh: "refresh-1".into(),
        access: "access-1".into(),
        expires: 1_700_000_000_000.0,
        extra,
    })
}

#[test]
fn writes_as_javascript_does_and_keeps_entries_in_place() {
    let directory = scratch("write");
    let file = AuthFile::in_agent_dir(&directory.join("agent"));
    file.modify("openai", |current| {
        assert_eq!(current, None);
        Ok(Some(api_key("sk-1")))
    })
    .unwrap();
    file.modify("anthropic", |_| Ok(Some(oauth()))).unwrap();
    let expected = r#"{
  "openai": {
    "type": "api_key",
    "key": "sk-1"
  },
  "anthropic": {
    "type": "oauth",
    "refresh": "refresh-1",
    "access": "access-1",
    "expires": 1700000000000,
    "accountId": "acct-1"
  }
}"#;
    assert_eq!(fs::read_to_string(file.path()).unwrap(), expected);
    assert_eq!(file.read("anthropic").unwrap(), Some(oauth()));

    // Replacing an entry keeps its place; deleting one keeps the others' order.
    let stored = file
        .modify("openai", |current| {
            assert_eq!(current, Some(api_key("sk-1")));
            Ok(Some(api_key("sk-2")))
        })
        .unwrap();
    assert_eq!(stored, Some(api_key("sk-2")));
    assert_eq!(
        file.list().unwrap(),
        vec![
            ("openai".to_string(), "api_key".to_string()),
            ("anthropic".to_string(), "oauth".to_string())
        ]
    );
    file.delete("openai").unwrap();
    assert_eq!(
        file.list().unwrap(),
        vec![("anthropic".to_string(), "oauth".to_string())]
    );
    assert!(!directory.join("agent/auth.json.lock").exists());
}

#[test]
fn a_change_that_returns_nothing_leaves_the_file_alone() {
    let directory = scratch("unchanged");
    fs::create_dir_all(&directory).unwrap();
    let file = AuthFile::in_agent_dir(&directory);
    let text = r#"{"x":{"type":"api_key","key":"k"}}"#;
    fs::write(file.path(), text).unwrap();
    let stored = file.modify("x", |_| Ok(None)).unwrap();
    assert_eq!(stored, Some(api_key("k")));
    assert_eq!(fs::read_to_string(file.path()).unwrap(), text);
}

#[test]
fn reads_keys_through_config_values() {
    let directory = scratch("values");
    fs::create_dir_all(&directory).unwrap();
    let file = AuthFile::in_agent_dir(&directory);
    let text = "\u{FEFF}{\"p\":{\"type\":\"api_key\",\"key\":\"$RELAY_AUTH_FILE_KEY\",\"env\":{\"RELAY_AUTH_FILE_KEY\":\"from-env\"}},\"q\":{\"type\":\"api_key\",\"key\":\"$RELAY_AUTH_FILE_UNSET\"}}";
    fs::write(file.path(), text).unwrap();
    let Some(Credential::ApiKey(p)) = file.read("p").unwrap() else {
        panic!("p is not an API key")
    };
    assert_eq!(p.key.as_deref(), Some("from-env"));
    let Some(Credential::ApiKey(q)) = file.read("q").unwrap() else {
        panic!("q is not an API key")
    };
    assert_eq!(q.key, None);
    let Some(Credential::ApiKey(raw)) = file.read_stored("p").unwrap() else {
        panic!("p is not an API key")
    };
    assert_eq!(raw.key.as_deref(), Some("$RELAY_AUTH_FILE_KEY"));
    assert_eq!(file.read("missing").unwrap(), None);
}

#[test]
fn rejects_what_the_typescript_store_rejects() {
    let directory = scratch("invalid");
    fs::create_dir_all(&directory).unwrap();
    let file = AuthFile::in_agent_dir(&directory);

    fs::write(file.path(), "[]").unwrap();
    assert_eq!(
        file.read("p").unwrap_err(),
        "Invalid auth.json: expected an object"
    );

    fs::write(file.path(), r#"{"p":{"type":"other"}}"#).unwrap();
    assert_eq!(
        file.read("p").unwrap_err(),
        "Invalid auth.json credential for provider \"p\""
    );

    fs::write(file.path(), "{not json").unwrap();
    let error = file.modify("p", |_| Ok(Some(api_key("k")))).unwrap_err();
    assert!(error.starts_with("Failed to read auth.json"), "{error}");
    assert_eq!(fs::read_to_string(file.path()).unwrap(), "{not json");
    assert!(!directory.join("auth.json.lock").exists());

    fs::remove_file(file.path()).unwrap();
    assert_eq!(file.read("p").unwrap(), None);
    assert!(file.list().unwrap().is_empty());
}
