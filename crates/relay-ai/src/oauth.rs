//! OAuth token refresh and request auth (`refresh`, `toAuth`) of each built-in OAuth provider,
//! as `packages/ai/src/auth/oauth/*.ts` do them. Logging in is separate: it is interactive.
//!
//! The requests go through an `OAuthContext`, which also gives the time, the environment and the
//! waits between retries, so the flows run unchanged against recorded answers in tests.

use std::future::Future;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::auth::{ModelAuth, OAuthCredential};

/// A request a flow makes.
#[derive(Debug, Clone, PartialEq)]
pub struct OAuthRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout: Option<Duration>,
}

/// The answer: an HTTP status (with its reason phrase), headers and body.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OAuthResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl OAuthResponse {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// `response.json()`: the body parsed, or the parser's error.
    fn json(&self) -> Result<Value, String> {
        serde_json::from_str(&self.body).map_err(|error| format!("SyntaxError: {error}"))
    }

    /// An object body, or none (`readJson`).
    fn object(&self) -> Option<Map<String, Value>> {
        match self.json() {
            Ok(Value::Object(object)) => Some(object),
            _ => None,
        }
    }
}

/// What a flow needs from outside: HTTP, the clock, the environment and waiting.
pub trait OAuthContext {
    /// Send a request; an error is a failure to get any answer (`fetch failed`).
    fn fetch(&self, request: OAuthRequest) -> impl Future<Output = Result<OAuthResponse, String>>;
    fn sleep(&self, duration: Duration) -> impl Future<Output = ()>;
    /// Unix time in milliseconds.
    fn now_ms(&self) -> f64;
    /// A process variable; empty is unset.
    fn env(&self, name: &str) -> Option<String>;
}

const fn json_headers() -> [(&'static str, &'static str); 2] {
    [
        ("Content-Type", "application/json"),
        ("Accept", "application/json"),
    ]
}

fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect()
}

/// `new URLSearchParams(fields).toString()`.
pub fn form_encode(fields: &[(&str, &str)]) -> String {
    fields
        .iter()
        .map(|(name, value)| format!("{}={}", form_component(name), form_component(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn form_component(text: &str) -> String {
    let mut encoded = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                encoded.push(byte as char)
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn credential(
    access: &str,
    refresh: &str,
    expires: f64,
    extra: Map<String, Value>,
) -> OAuthCredential {
    OAuthCredential {
        refresh: refresh.to_string(),
        access: access.to_string(),
        expires,
        extra,
    }
}

fn string_field<'a>(object: Option<&'a Map<String, Value>>, name: &str) -> Option<&'a str> {
    object?.get(name)?.as_str()
}

fn truthy_string<'a>(object: Option<&'a Map<String, Value>>, name: &str) -> Option<&'a str> {
    string_field(object, name).filter(|value| !value.is_empty())
}

fn positive_number(object: Option<&Map<String, Value>>, name: &str) -> Option<f64> {
    object?
        .get(name)?
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0)
}

/// `JSON.stringify(value)` for a parsed body, `null` for none.
fn stringify(object: Option<&Map<String, Value>>) -> String {
    object.map_or_else(
        || "null".into(),
        |object| Value::Object(object.clone()).to_string(),
    )
}

// Anthropic (Claude Pro/Max).

const ANTHROPIC_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";

async fn refresh_anthropic(
    stored: &OAuthCredential,
    ctx: &impl OAuthContext,
) -> Result<OAuthCredential, String> {
    let body = json!({
        "grant_type": "refresh_token",
        "client_id": ANTHROPIC_CLIENT_ID,
        "refresh_token": stored.refresh,
    });
    let failure = |details: String| {
        format!(
            "Anthropic token refresh request failed. url={ANTHROPIC_TOKEN_URL}; details={details}"
        )
    };
    let response = ctx
        .fetch(OAuthRequest {
            method: "POST",
            url: ANTHROPIC_TOKEN_URL.into(),
            headers: headers(&json_headers()),
            body: Some(body.to_string()),
            timeout: Some(Duration::from_secs(30)),
        })
        .await
        .map_err(|error| failure(format!("TypeError: {error}")))?;
    if !response.ok() {
        return Err(failure(format!(
            "Error: HTTP request failed. status={}; url={ANTHROPIC_TOKEN_URL}; body={}",
            response.status, response.body
        )));
    }
    let data = response.json().map_err(|error| {
        format!(
            "Anthropic token refresh returned invalid JSON. url={ANTHROPIC_TOKEN_URL}; body={}; details={error}",
            response.body
        )
    })?;
    let expires_in = data["expires_in"].as_f64().unwrap_or(f64::NAN);
    Ok(credential(
        data["access_token"].as_str().unwrap_or_default(),
        data["refresh_token"].as_str().unwrap_or_default(),
        ctx.now_ms() + expires_in * 1000.0 - 5.0 * 60.0 * 1000.0,
        Map::new(),
    ))
}

// OpenAI Codex (ChatGPT Plus/Pro, legacy).

const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_JWT_CLAIM: &str = "https://api.openai.com/auth";

/// `atob`: standard base64, padding optional; base64url characters are invalid, as in `atob`.
fn atob(text: &str) -> Option<Vec<u8>> {
    let text = text.trim_end_matches('=');
    if text.len() % 4 == 1 {
        return None;
    }
    let mut bits = 0u32;
    let mut count = 0;
    let mut bytes = Vec::new();
    for character in text.bytes() {
        let value = match character {
            b'A'..=b'Z' => character - b'A',
            b'a'..=b'z' => character - b'a' + 26,
            b'0'..=b'9' => character - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
        }
    }
    Some(bytes)
}

/// The ChatGPT account id in a Codex access token's JWT claims.
fn codex_account_id(access: &str) -> Option<String> {
    let parts: Vec<&str> = access.split('.').collect();
    let [_, payload, _] = parts.as_slice() else {
        return None;
    };
    // `atob` yields one character per byte (Latin-1); JSON.parse then reads that text.
    let latin1: String = atob(payload)?.into_iter().map(char::from).collect();
    let claims: Value = serde_json::from_str(&latin1).ok()?;
    claims[CODEX_JWT_CLAIM]["chatgpt_account_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

async fn refresh_codex(
    stored: &OAuthCredential,
    ctx: &impl OAuthContext,
) -> Result<OAuthCredential, String> {
    let response = ctx
        .fetch(OAuthRequest {
            method: "POST",
            url: CODEX_TOKEN_URL.into(),
            headers: headers(&[("Content-Type", "application/x-www-form-urlencoded")]),
            body: Some(form_encode(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", &stored.refresh),
                ("client_id", CODEX_CLIENT_ID),
            ])),
            timeout: None,
        })
        .await
        .map_err(|error| format!("OpenAI Codex token refresh error: {error}"))?;
    if !response.ok() {
        let detail = if response.body.is_empty() {
            response.status_text.clone()
        } else {
            response.body.clone()
        };
        return Err(format!(
            "OpenAI Codex token refresh failed ({}): {detail}",
            response.status
        ));
    }
    let data = response.json()?;
    let object = data.as_object();
    let (Some(access), Some(refresh), Some(expires_in)) = (
        truthy_string(object, "access_token"),
        truthy_string(object, "refresh_token"),
        object
            .and_then(|object| object.get("expires_in"))
            .and_then(Value::as_f64),
    ) else {
        return Err(format!(
            "OpenAI Codex token refresh response missing fields: {data}"
        ));
    };
    let account_id =
        codex_account_id(access).ok_or("Failed to extract accountId from token".to_string())?;
    let mut extra = Map::new();
    extra.insert("accountId".into(), json!(account_id));
    Ok(credential(
        access,
        refresh,
        ctx.now_ms() + expires_in * 1000.0,
        extra,
    ))
}

// OpenAI (Sign in with ChatGPT).

const CHATGPT_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const CHATGPT_RESOURCE: &str = "https://api.openai.com/v1";
const CHATGPT_DIRECT_SCOPE: &str = "chatgpt.tokens.use.direct";

async fn refresh_chatgpt(
    stored: &OAuthCredential,
    ctx: &impl OAuthContext,
) -> Result<OAuthCredential, String> {
    let client_id = stored
        .extra
        .get("clientId")
        .and_then(Value::as_str)
        .filter(|id| !crate::text::js_trim(id).is_empty())
        .ok_or("Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT")?;
    let response = ctx
        .fetch(OAuthRequest {
            method: "POST",
            url: CHATGPT_TOKEN_URL.into(),
            headers: headers(&[
                ("accept", "application/json"),
                ("content-type", "application/x-www-form-urlencoded"),
            ]),
            body: Some(form_encode(&[
                ("grant_type", "refresh_token"),
                ("client_id", client_id),
                ("refresh_token", &stored.refresh),
                ("resource", CHATGPT_RESOURCE),
            ])),
            timeout: None,
        })
        .await?;
    if !response.ok() {
        let detail = if response.body.is_empty() {
            response.status_text.clone()
        } else {
            response.body.clone()
        };
        return Err(format!(
            "OpenAI OAuth token request failed ({}): {detail}",
            response.status
        ));
    }
    let data = response.json()?;
    let object = data
        .as_object()
        .ok_or("OpenAI OAuth token response must be an object")?;
    let token = |field: &str| {
        object
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !crate::text::js_trim(value).is_empty())
            .ok_or(format!("OpenAI OAuth token response has invalid {field}"))
    };
    let access = token("access_token")?;
    let refresh = token("refresh_token")?;
    let scope = token("scope")?;
    let expires_in = positive_number(Some(object), "expires_in")
        .ok_or("OpenAI OAuth token response has invalid expires_in")?;
    let scopes: Vec<&str> = crate::text::js_trim(scope)
        .split(char::is_whitespace)
        .filter(|scope| !scope.is_empty())
        .collect();
    if !scopes.contains(&CHATGPT_DIRECT_SCOPE) {
        return Err(format!(
            "OpenAI OAuth grant did not include {CHATGPT_DIRECT_SCOPE}"
        ));
    }
    let mut extra = Map::new();
    extra.insert("clientId".into(), json!(client_id));
    extra.insert("scopes".into(), json!(scopes));
    Ok(credential(
        access,
        refresh,
        ctx.now_ms() + expires_in * 1000.0 - 3.0 * 60.0 * 1000.0,
        extra,
    ))
}

// GitHub Copilot.

const COPILOT_HEADERS: [(&str, &str); 4] = [
    ("User-Agent", "GitHubCopilotChat/0.35.0"),
    ("Editor-Version", "vscode/1.107.0"),
    ("Editor-Plugin-Version", "copilot-chat/0.35.0"),
    ("Copilot-Integration-Id", "vscode-chat"),
];
const COPILOT_API_VERSION: &str = "2026-06-01";
const COPILOT_INDIVIDUAL: &str = "https://api.individual.githubcopilot.com";

/// The host of a URL or bare domain (`normalizeDomain`), in lowercase.
fn normalize_domain(input: &str) -> Option<String> {
    let trimmed = crate::text::js_trim(input);
    if trimmed.is_empty() {
        return None;
    }
    let rest = match trimmed.find("://") {
        Some(index) => &trimmed[index + 3..],
        None => trimmed,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or_default();
    let host = host
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

fn copilot_enterprise_domain(credential: &OAuthCredential) -> Option<String> {
    credential
        .extra
        .get("enterpriseUrl")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .and_then(normalize_domain)
}

/// The API base URL: from the token's `proxy-ep`, else the enterprise host, else Individual.
fn copilot_base_url(token: &str, enterprise: Option<&str>) -> String {
    if let Some(start) = token.find("proxy-ep=") {
        let host = token[start + "proxy-ep=".len()..]
            .split(';')
            .next()
            .unwrap_or_default();
        if !host.is_empty() {
            let host = host
                .strip_prefix("proxy.")
                .map_or(host.to_string(), |rest| format!("api.{rest}"));
            return format!("https://{host}");
        }
    }
    match enterprise {
        Some(domain) => format!("https://copilot-api.{domain}"),
        None => COPILOT_INDIVIDUAL.into(),
    }
}

fn copilot_error(response: &OAuthResponse) -> String {
    format!(
        "{} {}: {}",
        response.status, response.status_text, response.body
    )
}

/// The models the account can pick, or, on Individual when none is marked, those its policy
/// enables (`parseGitHubCopilotModelCatalog`).
fn copilot_available_models(
    raw: &Value,
    allow_policy_fallback: bool,
) -> Result<Vec<String>, String> {
    let data = raw
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Invalid Copilot models response")?;
    let models: Vec<(String, bool, Option<String>)> = data
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?;
            if item["capabilities"]["supports"]["tool_calls"] == Value::Bool(false) {
                return None;
            }
            Some((
                id.to_string(),
                item["model_picker_enabled"] == Value::Bool(true),
                item["policy"]["state"].as_str().map(str::to_string),
            ))
        })
        .collect();
    let picker: Vec<String> = models
        .iter()
        .filter(|(_, picker, state)| *picker && state.as_deref() != Some("disabled"))
        .map(|(id, ..)| id.clone())
        .collect();
    if !picker.is_empty() || !allow_policy_fallback {
        return Ok(picker);
    }
    Ok(models
        .into_iter()
        .filter(|(_, _, state)| state.as_deref() == Some("enabled"))
        .map(|(id, ..)| id)
        .collect())
}

async fn refresh_copilot(
    stored: &OAuthCredential,
    ctx: &impl OAuthContext,
) -> Result<OAuthCredential, String> {
    let enterprise = copilot_enterprise_domain(stored);
    let domain = enterprise.as_deref().unwrap_or("github.com");
    let mut token_headers = headers(&[
        ("Accept", "application/json"),
        ("Authorization", &format!("Bearer {}", stored.refresh)),
    ]);
    token_headers.extend(headers(&COPILOT_HEADERS));
    let response = ctx
        .fetch(OAuthRequest {
            method: "GET",
            url: format!("https://api.{domain}/copilot_internal/v2/token"),
            headers: token_headers,
            body: None,
            timeout: None,
        })
        .await?;
    if !response.ok() {
        return Err(copilot_error(&response));
    }
    let raw = response.json()?;
    let object = raw.as_object().ok_or("Invalid Copilot token response")?;
    let (Some(token), Some(expires_at)) = (
        object.get("token").and_then(Value::as_str),
        object.get("expires_at").and_then(Value::as_f64),
    ) else {
        return Err("Invalid Copilot token response fields".into());
    };
    let base_url = copilot_base_url(token, enterprise.as_deref());
    let mut model_headers = headers(&[
        ("Accept", "application/json"),
        ("Authorization", &format!("Bearer {token}")),
    ]);
    model_headers.extend(headers(&COPILOT_HEADERS));
    model_headers.push(("X-GitHub-Api-Version".into(), COPILOT_API_VERSION.into()));
    let models = ctx
        .fetch(OAuthRequest {
            method: "GET",
            url: format!("{base_url}/models"),
            headers: model_headers,
            body: None,
            timeout: Some(Duration::from_secs(5)),
        })
        .await?;
    if !models.ok() {
        return Err(copilot_error(&models));
    }
    let available = copilot_available_models(&models.json()?, base_url == COPILOT_INDIVIDUAL)?;
    let mut extra = Map::new();
    if let Some(domain) = &enterprise {
        extra.insert("enterpriseUrl".into(), json!(domain));
    }
    extra.insert("availableModelIds".into(), json!(available));
    Ok(credential(
        token,
        &stored.refresh,
        expires_at * 1000.0 - 5.0 * 60.0 * 1000.0,
        extra,
    ))
}

// Google Antigravity.

async fn refresh_antigravity(
    stored: &OAuthCredential,
    ctx: &impl OAuthContext,
) -> Result<OAuthCredential, String> {
    let (Some(client_id), Some(client_secret)) = (
        ctx.env("RELAY_AI_ANTIGRAVITY_CLIENT_ID"),
        ctx.env("RELAY_AI_ANTIGRAVITY_CLIENT_SECRET"),
    ) else {
        return Err("Set RELAY_AI_ANTIGRAVITY_CLIENT_ID and RELAY_AI_ANTIGRAVITY_CLIENT_SECRET to refresh Google Antigravity login".into());
    };
    let started_at = ctx.now_ms();
    let response = ctx
        .fetch(OAuthRequest {
            method: "POST",
            url: "https://oauth2.googleapis.com/token".into(),
            headers: headers(&[("Content-Type", "application/x-www-form-urlencoded")]),
            body: Some(form_encode(&[
                ("client_id", &client_id),
                ("client_secret", &client_secret),
                ("grant_type", "refresh_token"),
                ("refresh_token", &stored.refresh),
            ])),
            timeout: Some(Duration::from_secs(30)),
        })
        .await?;
    if !response.ok() {
        return Err(format!(
            "Antigravity OAuth token exchange failed (HTTP {})",
            response.status
        ));
    }
    let body = response.json()?;
    let object = body.as_object();
    let refresh = match object.and_then(|object| object.get("refresh_token")) {
        None | Some(Value::Null) => Some(stored.refresh.as_str()),
        Some(value) => value.as_str(),
    }
    .filter(|refresh| !refresh.is_empty());
    let (Some(access), Some(refresh), Some(expires_in)) = (
        truthy_string(object, "access_token"),
        refresh,
        positive_number(object, "expires_in"),
    ) else {
        return Err("Antigravity OAuth returned invalid token data".into());
    };
    Ok(credential(
        access,
        refresh,
        started_at + (expires_in * 1000.0 - 60_000.0).max(0.0),
        stored.extra.clone(),
    ))
}

// Kimi Code.

const KIMI_CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_REFRESH_RETRIES: u32 = 3;

async fn refresh_kimi(
    stored: &OAuthCredential,
    ctx: &impl OAuthContext,
) -> Result<OAuthCredential, String> {
    let host = ctx
        .env("KIMI_CODE_OAUTH_HOST")
        .or_else(|| ctx.env("KIMI_OAUTH_HOST"))
        .unwrap_or_else(|| "https://auth.kimi.com".into());
    let host = host.trim_end_matches('/');
    let mut last_error = None;
    for attempt in 0..=KIMI_REFRESH_RETRIES {
        if attempt > 0 {
            ctx.sleep(Duration::from_millis(1000 << (attempt - 1)))
                .await;
        }
        let response = match ctx
            .fetch(OAuthRequest {
                method: "POST",
                url: format!("{host}/api/oauth/token"),
                headers: headers(&[
                    ("Content-Type", "application/x-www-form-urlencoded"),
                    ("Accept", "application/json"),
                ]),
                body: Some(form_encode(&[
                    ("client_id", KIMI_CLIENT_ID),
                    ("grant_type", "refresh_token"),
                    ("refresh_token", &stored.refresh),
                ])),
                timeout: Some(Duration::from_secs(30)),
            })
            .await
        {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        let object = response.object();
        if response.ok() {
            let (Some(access), Some(refresh), Some(expires_in)) = (
                truthy_string(object.as_ref(), "access_token"),
                truthy_string(object.as_ref(), "refresh_token"),
                positive_number(object.as_ref(), "expires_in"),
            ) else {
                return Err(format!(
                    "Kimi Code token refresh response missing fields: {}",
                    stringify(object.as_ref())
                ));
            };
            return Ok(credential(
                access,
                refresh,
                ctx.now_ms() + expires_in * 1000.0,
                Map::new(),
            ));
        }
        let invalid_grant = string_field(object.as_ref(), "error") == Some("invalid_grant");
        if matches!(response.status, 401 | 403) || invalid_grant {
            let description = string_field(object.as_ref(), "error_description")
                .map(|description| format!(": {description}"))
                .unwrap_or_default();
            return Err(format!(
                "Kimi Code token refresh unauthorized (status {}){description}",
                response.status
            ));
        }
        if (response.status == 429 || response.status >= 500) && attempt < KIMI_REFRESH_RETRIES {
            last_error = Some(format!(
                "Kimi Code token refresh failed with status {}",
                response.status
            ));
            continue;
        }
        return Err(format!(
            "Kimi Code token refresh failed with status {}: {}",
            response.status,
            stringify(object.as_ref())
        ));
    }
    Err(last_error.unwrap_or_else(|| "Kimi Code token refresh failed".into()))
}

// Meta (Muse subscription).

const META_KEY_URL: &str = "https://api.meta.ai/muse-code/key";
const META_KEY_LIFETIME_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

fn meta_error_detail(object: Option<&Map<String, Value>>) -> String {
    ["error_description", "detail", "message", "error"]
        .into_iter()
        .find_map(|key| {
            let value = crate::text::js_trim(string_field(object, key)?);
            (!value.is_empty()).then(|| format!(": {value}"))
        })
        .unwrap_or_default()
}

/// An http(s) URL as `new URL(value).href` writes it.
fn trusted_http_url(value: &str) -> Option<String> {
    let (scheme, rest) = value.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let (host, path) = match rest.find(['/', '?', '#']) {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    if host.is_empty() {
        return None;
    }
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    Some(format!("{scheme}://{}{path}", host.to_ascii_lowercase()))
}

async fn refresh_meta(
    stored: &OAuthCredential,
    ctx: &impl OAuthContext,
) -> Result<OAuthCredential, String> {
    let response = ctx
        .fetch(OAuthRequest {
            method: "POST",
            url: META_KEY_URL.into(),
            headers: headers(&[
                ("Accept", "application/json"),
                ("Authorization", &format!("Bearer {}", stored.refresh)),
                ("Content-Type", "application/json"),
                ("x-api-version", "1.0.0"),
            ]),
            body: Some("{}".into()),
            timeout: Some(Duration::from_secs(30)),
        })
        .await?;
    let object = response.object();
    if matches!(response.status, 401 | 403) {
        return Err(format!(
            "Meta session expired (status {}). Run `/login meta` to sign in again.{}",
            response.status,
            meta_error_detail(object.as_ref())
        ));
    }
    if !response.ok() {
        return Err(format!(
            "Meta API key mint failed with status {}{}",
            response.status,
            meta_error_detail(object.as_ref())
        ));
    }
    let Some(api_key) = truthy_string(object.as_ref(), "api_key") else {
        let setup = string_field(object.as_ref(), "action_url")
            .and_then(trusted_http_url)
            .map(|url| format!(" Complete setup at {url}"))
            .unwrap_or_default();
        return Err(format!("Meta did not issue an API key.{setup}"));
    };
    Ok(credential(
        api_key,
        &stored.refresh,
        ctx.now_ms() + META_KEY_LIFETIME_MS,
        Map::new(),
    ))
}

// xAI (Grok/X subscription).

const XAI_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";

async fn refresh_xai(
    stored: &OAuthCredential,
    ctx: &impl OAuthContext,
) -> Result<OAuthCredential, String> {
    let response = ctx
        .fetch(OAuthRequest {
            method: "POST",
            url: XAI_TOKEN_URL.into(),
            headers: headers(&[
                ("Accept", "application/json"),
                ("Content-Type", "application/x-www-form-urlencoded"),
            ]),
            body: Some(form_encode(&[
                ("grant_type", "refresh_token"),
                ("client_id", XAI_CLIENT_ID),
                ("refresh_token", &stored.refresh),
            ])),
            timeout: None,
        })
        .await?;
    let body = match response.json() {
        Ok(Value::Object(object)) => object,
        Ok(_) => Map::new(),
        Err(_) => {
            return Err(format!(
                "xAI OAuth returned invalid JSON (HTTP {})",
                response.status
            ))
        }
    };
    if !response.ok() {
        let detail: Vec<&str> = [
            string_field(Some(&body), "error"),
            string_field(Some(&body), "error_description"),
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect();
        let detail = if detail.is_empty() {
            String::new()
        } else {
            format!(": {}", detail.join(": "))
        };
        return Err(format!(
            "xAI OAuth token refresh failed (HTTP {}){detail}",
            response.status
        ));
    }
    let field = |name: &str| format!("Invalid xAI OAuth response field: {name}");
    let access = truthy_string(Some(&body), "access_token").ok_or_else(|| field("access_token"))?;
    let refresh = if !body.contains_key("refresh_token") && !stored.refresh.is_empty() {
        stored.refresh.as_str()
    } else {
        truthy_string(Some(&body), "refresh_token").ok_or_else(|| field("refresh_token"))?
    };
    let expires_in = if body.contains_key("expires_in") {
        positive_number(Some(&body), "expires_in").ok_or_else(|| field("expires_in"))?
    } else {
        3600.0
    };
    Ok(credential(
        access,
        refresh,
        ctx.now_ms() + expires_in * 1000.0 - 5.0 * 60.0 * 1000.0,
        Map::new(),
    ))
}

/// Refresh a provider's stored OAuth credential.
pub async fn refresh(
    provider_id: &str,
    stored: &OAuthCredential,
    ctx: &impl OAuthContext,
) -> Result<OAuthCredential, String> {
    match provider_id {
        "anthropic" => refresh_anthropic(stored, ctx).await,
        "openai-codex" => refresh_codex(stored, ctx).await,
        "openai" => refresh_chatgpt(stored, ctx).await,
        "github-copilot" => refresh_copilot(stored, ctx).await,
        "google-antigravity" => refresh_antigravity(stored, ctx).await,
        "kimi-coding" => refresh_kimi(stored, ctx).await,
        "meta" => refresh_meta(stored, ctx).await,
        // OpenRouter's OAuth gives an API key that does not expire.
        "openrouter" => Ok(stored.clone()),
        "xai" => refresh_xai(stored, ctx).await,
        other => Err(format!("{other} has no OAuth sign-in")),
    }
}

/// The request auth a valid credential gives (`toAuth`).
pub fn to_auth(provider_id: &str, credential: &OAuthCredential) -> Result<ModelAuth, String> {
    let api_key = || ModelAuth {
        api_key: Some(credential.access.clone()),
        ..ModelAuth::default()
    };
    match provider_id {
        "anthropic" | "openai-codex" | "openai" | "meta" | "openrouter" | "xai" => Ok(api_key()),
        "github-copilot" => {
            let enterprise = copilot_enterprise_domain(credential);
            Ok(ModelAuth {
                base_url: Some(copilot_base_url(&credential.access, enterprise.as_deref())),
                ..api_key()
            })
        }
        "google-antigravity" => {
            let project = credential
                .extra
                .get("projectId")
                .and_then(Value::as_str)
                .filter(|project| !project.is_empty())
                .ok_or("Missing Antigravity project. Log in again.")?;
            let mut headers = Map::new();
            headers.insert("X-Goog-User-Project".into(), json!(project));
            Ok(ModelAuth {
                headers: Some(headers),
                base_url: credential
                    .extra
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                ..api_key()
            })
        }
        "kimi-coding" => {
            let mut headers = Map::new();
            headers.insert(
                "Authorization".into(),
                json!(format!("Bearer {}", credential.access)),
            );
            Ok(ModelAuth {
                headers: Some(headers),
                ..ModelAuth::default()
            })
        }
        other => Err(format!("{other} has no OAuth sign-in")),
    }
}

/// The live context: requests over the shared HTTP client, the system clock and environment.
pub struct LiveOAuthContext;

impl OAuthContext for LiveOAuthContext {
    async fn fetch(&self, request: OAuthRequest) -> Result<OAuthResponse, String> {
        let client = crate::http::client()?;
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|error| error.to_string())?;
        let mut builder = client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        if let Some(timeout) = request.timeout {
            builder = builder.timeout(timeout);
        }
        let response = builder
            .send()
            .await
            .map_err(|_| "fetch failed".to_string())?;
        let status = response.status();
        let status_text = if response.version() == reqwest::Version::HTTP_2 {
            String::new()
        } else {
            status.canonical_reason().unwrap_or_default().to_string()
        };
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect();
        let body = response
            .text()
            .await
            .map_err(|_| "terminated".to_string())?;
        Ok(OAuthResponse {
            status: status.as_u16(),
            status_text,
            headers,
            body,
        })
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }

    fn now_ms(&self) -> f64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
    }

    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }
}
