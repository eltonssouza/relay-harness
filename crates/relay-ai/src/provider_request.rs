//! What each adapter sends over HTTP besides its body (the URL and headers the SDKs build), the
//! body as it goes on the wire, and how each reports an HTTP error, as the TypeScript adapters
//! and their SDKs do.
//!
//! Headers are applied in layers, as the SDKs' `buildHeaders` applies them: the SDK's own, the
//! auth, the adapter's defaults, the body's content type, the request's. A later layer replaces a
//! header whatever its case, and a `null` removes it. An adapter merges its defaults first with
//! `Object.assign`, which compares names exactly, so a later `User-Agent` replaces an earlier
//! `User-Agent` in its place but not an earlier `user-agent`.
//!
//! The SDKs' telemetry headers (`x-stainless-*`, `x-goog-api-client`) describe the JavaScript
//! runtime and are not sent. Anthropic's workload identity federation is not supported yet.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::anthropic::{self, AnthropicOptions};
use crate::google::{self, GoogleOptions};
use crate::http::{truncate_error_text, HttpRequest, MAX_ERROR_BODY_CHARS};
use crate::openai_completions::{self, OpenAICompletionsOptions};
use crate::openai_responses::{self, OpenAIResponsesOptions};
use crate::options::{resolve_cache_retention, CacheRetention};
use crate::retry::{HttpError, RequestError};
use crate::{Content, InputBlock, Message, Model};

/// The parts of a request's options that are not body settings.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOptions {
    pub api_key: Option<String>,
    /// Headers for this request; a `null` value removes a header.
    pub headers: Option<Map<String, Value>>,
    pub session_id: Option<String>,
    pub cache_retention: Option<CacheRetention>,
    pub env: Option<HashMap<String, String>>,
}

/// The Claude Code version the OAuth form reports (`claudeCodeVersion`).
pub const CLAUDE_CODE_VERSION: &str = "2.1.280";
const CHATGPT_USAGE_URL: &str = "https://chatgpt.com/settings/usage";

fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// `os.release()`: the kernel version on Linux and macOS, `major.minor.build` on Windows.
fn os_release() -> Option<String> {
    let output = |program: &str, args: &[&str]| {
        std::process::Command::new(program)
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    let release = match std::env::consts::OS {
        "linux" => std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .ok()
            .map(|text| text.trim().to_string()),
        "windows" => output("cmd", &["/d", "/c", "ver"]).and_then(|text| {
            let version = text.split("Version ").nth(1)?.trim_end_matches(']').trim();
            Some(version.split('.').take(3).collect::<Vec<_>>().join("."))
        }),
        _ => output("uname", &["-r"]),
    };
    release.filter(|release| !release.is_empty())
}

/// Relay's user agent (`getRelayUserAgent`): `relay (<platform> <release>; <arch>)`.
pub fn relay_user_agent() -> &'static str {
    static USER_AGENT: OnceLock<String> = OnceLock::new();
    USER_AGENT.get_or_init(|| match os_release() {
        Some(release) => format!("relay ({} {release}; {})", node_platform(), node_arch()),
        None => format!("relay ({}; {})", node_platform(), node_arch()),
    })
}

/// `Object.assign({}, ...sources)`.
fn assign(sources: &[Option<&Map<String, Value>>]) -> Map<String, Value> {
    let mut merged = Map::new();
    for source in sources.iter().flatten() {
        for (name, value) in *source {
            merged.insert(name.clone(), value.clone());
        }
    }
    merged
}

fn layer(entries: &[(&str, &str)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(name, value)| (name.to_string(), json!(value)))
        .collect()
}

/// The SDKs' `buildHeaders`: names in lowercase, the last value winning, `null` removing.
fn build_headers(layers: &[&Map<String, Value>]) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = Vec::new();
    for layer in layers {
        for (name, value) in *layer {
            let name = name.to_ascii_lowercase();
            headers.retain(|(existing, _)| *existing != name);
            match value {
                Value::Null => {}
                Value::String(text) => headers.push((name, text.clone())),
                other => headers.push((name, other.to_string())),
            }
        }
    }
    headers
}

/// The SDKs' `buildURL`: the base and the path, with one slash between them.
fn join_url(base: &str, path: &str) -> String {
    if base.ends_with('/') && path.starts_with('/') {
        format!("{base}{}", &path[1..])
    } else {
        format!("{base}{path}")
    }
}

fn base_url<'a>(model: &'a Model, default: &'a str) -> &'a str {
    if model.base_url.is_empty() {
        default
    } else {
        &model.base_url
    }
}

/// GitHub Copilot's per-request headers: who started the turn, and whether it carries images.
fn copilot_headers(messages: &[Message]) -> Map<String, Value> {
    let initiator = match messages.last() {
        Some(Message::User(_)) | None => "user",
        Some(_) => "agent",
    };
    let has_images = messages.iter().any(|message| match message {
        Message::User(user) => matches!(&user.content, Content::Blocks(blocks)
            if blocks.iter().any(|block| matches!(block, InputBlock::Image(_)))),
        Message::ToolResult(result) => result
            .content
            .iter()
            .any(|block| matches!(block, InputBlock::Image(_))),
        _ => false,
    });
    let mut headers = layer(&[
        ("X-Initiator", initiator),
        ("Openai-Intent", "conversation-edits"),
    ]);
    if has_images {
        headers.insert("Copilot-Vision-Request".into(), json!("true"));
    }
    headers
}

fn is_open_router(model: &Model) -> bool {
    model.provider == "openrouter" || model.base_url.contains("openrouter.ai")
}

/// The session id used for cache affinity: none when caching is off.
fn cache_session_id(request: &RequestOptions) -> Option<&str> {
    match resolve_cache_retention(request.cache_retention, request.env.as_ref()) {
        CacheRetention::None => None,
        _ => request.session_id.as_deref(),
    }
}

fn has_header(headers: Option<&Map<String, Value>>, name: &str) -> bool {
    headers.into_iter().flatten().any(|(header, value)| {
        header.eq_ignore_ascii_case(name)
            && value
                .as_str()
                .is_some_and(|value| !crate::text::js_trim(value).is_empty())
    })
}

fn body_text(body: &Value) -> Vec<u8> {
    serde_json::to_vec(body).unwrap_or_default()
}

/// The Anthropic Messages request: the API key, an OAuth token (the Claude Code form), a GitHub
/// Copilot token, or auth the request's headers carry. The body's `betas` go in `anthropic-beta`.
pub fn anthropic_request(
    model: &Model,
    messages: &[Message],
    options: &AnthropicOptions,
    request: &RequestOptions,
) -> Result<HttpRequest, String> {
    let api_key = request.api_key.as_deref().filter(|key| !key.is_empty());
    let headers = request.headers.as_ref();
    let has_auth = api_key.is_some()
        || has_header(headers, "authorization")
        || has_header(headers, "x-api-key")
        || has_header(headers, "cf-aig-authorization");
    if !has_auth {
        return Err(format!("No API key for provider: {}", model.provider));
    }
    let oauth = api_key.is_some_and(|key| anthropic::uses_oauth(model, key));
    let mut body = anthropic::build_request(model, messages, oauth, options)?;
    let betas = body
        .as_object_mut()
        .and_then(|body| body.shift_remove("betas"));

    let relay = layer(&[("User-Agent", relay_user_agent())]);
    let browser = layer(&[
        ("accept", "application/json"),
        ("anthropic-dangerous-direct-browser-access", "true"),
    ]);
    let (auth, defaults) = if model.provider == "github-copilot" {
        let auth = api_key.map(|key| layer(&[("Authorization", &format!("Bearer {key}"))]));
        let dynamic = copilot_headers(messages);
        (
            auth,
            assign(&[
                Some(&relay),
                Some(&browser),
                model.headers.as_ref(),
                Some(&dynamic),
                headers,
            ]),
        )
    } else if oauth {
        let key = api_key.unwrap_or_default();
        let claude_code = layer(&[
            ("accept", "application/json"),
            ("anthropic-dangerous-direct-browser-access", "true"),
            ("user-agent", &format!("claude-cli/{CLAUDE_CODE_VERSION}")),
            ("x-app", "cli"),
        ]);
        (
            Some(layer(&[("Authorization", &format!("Bearer {key}"))])),
            assign(&[
                Some(&relay),
                Some(&claude_code),
                model.headers.as_ref(),
                headers,
            ]),
        )
    } else {
        let compat = model.compat();
        let mut affinity = Map::new();
        let send = compat
            .send_session_affinity_headers
            .unwrap_or_else(|| is_open_router(model));
        if let Some(session) = cache_session_id(request).filter(|_| send) {
            let format = compat
                .session_affinity_format
                .clone()
                .or_else(|| is_open_router(model).then(|| "openrouter".to_string()));
            let name = if format.as_deref() == Some("openrouter") {
                "x-session-id"
            } else {
                "x-session-affinity"
            };
            affinity.insert(name.into(), json!(session));
        }
        (
            api_key.map(|key| layer(&[("X-Api-Key", key)])),
            assign(&[
                Some(&relay),
                Some(&browser),
                Some(&affinity),
                model.headers.as_ref(),
                headers,
            ]),
        )
    };
    let sdk = layer(&[
        ("Accept", "application/json"),
        ("anthropic-dangerous-direct-browser-access", "true"),
        ("anthropic-version", "2023-06-01"),
    ]);
    let content = layer(&[("Content-Type", "application/json")]);
    let mut beta_header = Map::new();
    if let Some(Value::Array(betas)) = &betas {
        let joined: Vec<String> = betas
            .iter()
            .map(|beta| {
                beta.as_str()
                    .map_or_else(|| beta.to_string(), str::to_string)
            })
            .collect();
        beta_header.insert("anthropic-beta".into(), json!(joined.join(",")));
    }
    let empty = Map::new();
    Ok(HttpRequest {
        url: join_url(
            base_url(model, "https://api.anthropic.com"),
            "/v1/messages?beta=true",
        ),
        headers: build_headers(&[
            &sdk,
            auth.as_ref().unwrap_or(&empty),
            &defaults,
            &content,
            &beta_header,
        ]),
        body: body_text(&body),
    })
}

/// The OpenAI SDK's own headers: `OpenAI-Organization` and `OpenAI-Project` from the process
/// environment, and the bearer key.
fn openai_sdk_layers(api_key: &str) -> (Map<String, Value>, Map<String, Value>) {
    let mut sdk = layer(&[("Accept", "application/json")]);
    for (header, variable) in [
        ("OpenAI-Organization", "OPENAI_ORG_ID"),
        ("OpenAI-Project", "OPENAI_PROJECT_ID"),
    ] {
        if let Ok(value) = std::env::var(variable) {
            sdk.insert(header.into(), json!(value));
        }
    }
    let auth = layer(&[("Authorization", &format!("Bearer {api_key}"))]);
    (sdk, auth)
}

fn openai_request(
    model: &Model,
    path: &str,
    api_key: &str,
    defaults: &Map<String, Value>,
    body: &Value,
) -> HttpRequest {
    let (sdk, auth) = openai_sdk_layers(api_key);
    let content = layer(&[("Content-Type", "application/json")]);
    HttpRequest {
        url: join_url(base_url(model, "https://api.openai.com/v1"), path),
        headers: build_headers(&[&sdk, &auth, defaults, &content]),
        body: body_text(body),
    }
}

/// The OpenAI Responses request.
pub fn openai_responses_request(
    model: &Model,
    messages: &[Message],
    options: &OpenAIResponsesOptions,
    request: &RequestOptions,
) -> Result<HttpRequest, String> {
    let api_key = request
        .api_key
        .as_deref()
        .ok_or_else(|| format!("No API key for provider: {}", model.provider))?;
    let body = openai_responses::build_request(model, messages, Some(api_key), options)?;
    let relay = layer(&[("User-Agent", relay_user_agent())]);
    let copilot = (model.provider == "github-copilot").then(|| copilot_headers(messages));
    let mut session = Map::new();
    if let Some(id) = cache_session_id(request) {
        let format = model.compat().session_affinity_format.unwrap_or_else(|| {
            if is_open_router(model) {
                "openrouter".into()
            } else {
                "openai".into()
            }
        });
        if format == "openrouter" {
            session.insert("x-session-id".into(), json!(id));
        } else {
            if format == "openai" {
                session.insert("session_id".into(), json!(id));
            }
            session.insert("x-client-request-id".into(), json!(id));
        }
    }
    let defaults = assign(&[
        Some(&relay),
        model.headers.as_ref(),
        copilot.as_ref(),
        Some(&session),
        request.headers.as_ref(),
    ]);
    Ok(openai_request(
        model,
        "/responses",
        api_key,
        &defaults,
        &body,
    ))
}

/// The OpenAI Chat Completions request.
pub fn openai_completions_request(
    model: &Model,
    messages: &[Message],
    options: &OpenAICompletionsOptions,
    request: &RequestOptions,
) -> Result<HttpRequest, String> {
    let api_key = request
        .api_key
        .as_deref()
        .ok_or_else(|| format!("No API key for provider: {}", model.provider))?;
    let body = openai_completions::build_request(model, messages, options)?;
    let relay = layer(&[("User-Agent", relay_user_agent())]);
    let copilot = (model.provider == "github-copilot").then(|| copilot_headers(messages));
    let compat = model.compat();
    let open_router = is_open_router(model);
    let mut session = Map::new();
    let send = compat.send_session_affinity_headers.unwrap_or(open_router);
    if let Some(id) = cache_session_id(request).filter(|_| send) {
        let format = compat.session_affinity_format.unwrap_or_else(|| {
            if open_router {
                "openrouter".into()
            } else {
                "openai".into()
            }
        });
        if format == "openrouter" {
            session.insert("x-session-id".into(), json!(id));
        } else {
            if format == "openai" {
                session.insert("session_id".into(), json!(id));
            }
            session.insert("x-client-request-id".into(), json!(id));
            session.insert("x-session-affinity".into(), json!(id));
        }
    }
    let defaults = assign(&[
        Some(&relay),
        model.headers.as_ref(),
        copilot.as_ref(),
        Some(&session),
        request.headers.as_ref(),
    ]);
    Ok(openai_request(
        model,
        "/chat/completions",
        api_key,
        &defaults,
        &body,
    ))
}

/// The Google Gemini request: the SDK's wire body, the key in `x-goog-api-key`.
pub fn google_request(
    model: &Model,
    messages: &[Message],
    options: &GoogleOptions,
    request: &RequestOptions,
) -> Result<HttpRequest, String> {
    let api_key = request
        .api_key
        .as_deref()
        .filter(|key| !key.is_empty())
        .ok_or_else(|| format!("No API key for provider: {}", model.provider))?;
    let params = google::build_params(model, messages, options)?;
    let relay = layer(&[("User-Agent", relay_user_agent())]);
    // `providerHeadersToRecord`: a null removes a header given earlier, never the SDK's.
    let merged = assign(&[
        Some(&relay),
        model.headers.as_ref(),
        request.headers.as_ref(),
    ]);
    let relay_headers: Map<String, Value> = build_headers(&[&merged])
        .into_iter()
        .map(|(name, value)| (name, json!(value)))
        .collect();
    let sdk = layer(&[("Content-Type", "application/json")]);
    let key = layer(&[("x-goog-api-key", api_key)]);
    Ok(HttpRequest {
        url: google::request_url(model),
        headers: build_headers(&[&sdk, &relay_headers, &key]),
        body: body_text(&google::wire_body(&params)),
    })
}

/// JavaScript truthiness of a parsed JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `safeJSON(text)`, kept only when truthy, as the SDKs test it.
fn parse_error_body(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok().filter(truthy)
}

/// The SDKs' `APIError.makeMessage`.
fn sdk_message(status: Option<u16>, error: Option<&Value>, message: Option<&str>) -> String {
    let text = match error {
        Some(error) => match error.get("message").filter(|message| truthy(message)) {
            Some(Value::String(message)) => Some(message.clone()),
            Some(message) => Some(message.to_string()),
            None => truthy(error).then(|| error.to_string()),
        },
        None => message
            .filter(|message| !message.is_empty())
            .map(str::to_string),
    };
    match (status, text) {
        (Some(status), Some(text)) => format!("{status} {text}"),
        (Some(status), None) => format!("{status} status code (no body)"),
        (None, Some(text)) => text,
        (None, None) => "(no status code or body)".into(),
    }
}

/// The Anthropic SDK's message: the parsed body whole, or the text that did not parse.
pub fn anthropic_error_message(error: &RequestError) -> String {
    match error {
        RequestError::Http(http) if http.status.is_some() => {
            let text = http.body.as_deref().unwrap_or_default();
            let parsed = parse_error_body(text);
            let message = parsed.is_none().then_some(text);
            sdk_message(http.status, parsed.as_ref(), message)
        }
        RequestError::Http(_) => "Connection error.".into(),
        RequestError::Aborted => "Request was aborted.".into(),
        RequestError::Other(message) => message.clone(),
    }
}

/// The OpenAI SDK's error: its message, and the `error` it keeps (a body without an `error`
/// field is wrapped in one).
fn openai_sdk_error(http: &HttpError) -> (String, Option<Value>) {
    let text = http.body.as_deref().unwrap_or_default();
    let parsed = parse_error_body(text);
    let message = parsed.is_none().then_some(text);
    let normalized = parsed.map(|parsed| match &parsed {
        Value::Object(object) if object.get("error").is_none_or(Value::is_null) => {
            json!({ "error": parsed })
        }
        _ => parsed,
    });
    let error = normalized
        .as_ref()
        .and_then(|normalized| normalized.as_object())
        .and_then(|object| object.get("error"))
        .cloned();
    (sdk_message(http.status, error.as_ref(), message), error)
}

/// `formatProviderError(normalizeProviderError(error), prefix)` for an OpenAI SDK error.
fn format_openai_error(
    status: Option<u16>,
    message: &str,
    error: Option<&Value>,
    prefix: Option<&str>,
) -> String {
    let body = error
        .filter(|error| error.as_object().is_some_and(|object| !object.is_empty()))
        .map(|error| error.to_string())
        .map(|text| crate::text::js_trim(&text).to_string())
        .filter(|text| !text.is_empty())
        .map(|text| truncate_error_text(&text, MAX_ERROR_BODY_CHARS));
    let carries_body = body
        .as_ref()
        .is_none_or(|body| message.contains(body.as_str()));
    match (status, body) {
        (Some(status), Some(body)) if !carries_body => match prefix {
            Some(prefix) => format!("{prefix} ({status}): {body}"),
            None => format!("{status}: {body}"),
        },
        (Some(status), _) if prefix.is_some() => {
            format!("{} ({status}): {message}", prefix.unwrap_or_default())
        }
        _ => message.to_string(),
    }
}

/// The OpenAI Responses adapter's message: `<provider> API error (<status>): <body>`, with a
/// pointer to the ChatGPT usage page when the subscription limit is shared.
pub fn openai_responses_error_message(model: &Model, error: &RequestError) -> String {
    let prefix = format!(
        "{} API error",
        if model.provider == "openai" {
            "OpenAI"
        } else {
            &model.provider
        }
    );
    let message = match error {
        RequestError::Http(http) if http.status.is_some() => {
            let (message, body) = openai_sdk_error(http);
            format_openai_error(http.status, &message, body.as_ref(), Some(&prefix))
        }
        RequestError::Http(_) => "Connection error.".into(),
        RequestError::Aborted => "Request was aborted.".into(),
        RequestError::Other(message) => message.clone(),
    };
    if message.contains("subscription_sharing_usage_limit_exceeded") {
        format!("{message}\nCheck your ChatGPT usage: {CHATGPT_USAGE_URL}")
    } else {
        message
    }
}

/// `String(value)` for the values a JSON body holds.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

/// The Chat Completions adapter's message: `<status>: <body>`, and OpenRouter's raw provider
/// error when the message lacks it.
pub fn openai_completions_error_message(error: &RequestError) -> String {
    match error {
        RequestError::Http(http) if http.status.is_some() => {
            let (message, body) = openai_sdk_error(http);
            let mut text = format_openai_error(http.status, &message, body.as_ref(), None);
            let raw = body
                .as_ref()
                .and_then(|body| body.get("metadata"))
                .and_then(|metadata| metadata.get("raw"))
                .filter(|raw| truthy(raw));
            if let Some(raw) = raw {
                let raw = js_string(raw);
                if !text.contains(&raw) {
                    text.push('\n');
                    text.push_str(&raw);
                }
            }
            text
        }
        RequestError::Http(_) => "Connection error.".into(),
        RequestError::Aborted => "Request was aborted.".into(),
        RequestError::Other(message) => message.clone(),
    }
}

/// The Google SDK's message: the JSON body re-serialized, or a text body wrapped as
/// `{"error":{"message":…,"code":…,"status":<status text>}}`.
pub fn google_error_message(error: &RequestError) -> String {
    match error {
        RequestError::Http(http) if http.status.is_some() => {
            let text = http.body.as_deref().unwrap_or_default();
            let json_body = http
                .header("content-type")
                .is_some_and(|kind| kind.contains("application/json"));
            if json_body {
                // A JSON body that does not parse: TypeScript reports V8's `SyntaxError`, whose
                // wording Rust cannot reproduce; this reports the parser's.
                return match serde_json::from_str::<Value>(text) {
                    Ok(body) => body.to_string(),
                    Err(error) => format!("Invalid JSON in the error response: {error}"),
                };
            }
            json!({ "error": { "message": text, "code": http.status, "status": http.status_text } })
                .to_string()
        }
        RequestError::Http(_) => "fetch failed".into(),
        RequestError::Aborted => "This operation was aborted".into(),
        RequestError::Other(message) => message.clone(),
    }
}
