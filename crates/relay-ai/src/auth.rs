//! Provider credentials (`packages/ai/src/auth` and each built-in provider's `auth`): the stored
//! credential types of `auth.json`, and resolving a provider's API-key auth from a stored
//! credential and the environment.
//!
//! Most providers take a stored key, else the first of their environment variables
//! (`envApiKeyAuth`). Anthropic, Amazon Bedrock, Google Vertex and the two Cloudflare providers
//! read more: auth headers, account ids, ambient cloud credentials. OAuth providers are described
//! here; their flows are separate.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// One provider's entry in `auth.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Credential {
    ApiKey(ApiKeyCredential),
    Oauth(OAuthCredential),
}

/// A stored key, and provider settings such as Cloudflare's account id.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ApiKeyCredential {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// String values, in the order they were stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<Map<String, Value>>,
}

impl ApiKeyCredential {
    fn env_value(&self, name: &str) -> Option<&str> {
        self.env.as_ref()?.get(name)?.as_str()
    }
}

/// Stored OAuth tokens; `expires` is a Unix time in milliseconds. Providers keep other fields
/// (account ids, endpoints) beside them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OAuthCredential {
    pub refresh: String,
    pub access: String,
    #[serde(serialize_with = "crate::json::serialize_js_f64")]
    pub expires: f64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// What a request needs from auth (`ModelAuth`). A `null` header removes one the adapter sets.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelAuth {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// Resolved auth (`AuthResult`): the request auth, provider settings, and where they came from.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct AuthResult {
    pub auth: ModelAuth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<Map<String, Value>>,
    /// For status displays: `stored credential`, a variable name, `AWS access keys`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// The environment auth resolution reads (`AuthContext`).
pub trait AuthContext {
    /// A variable's value; unset and blank values are `None`.
    fn env(&self, name: &str) -> Option<String>;
    /// Whether a file exists; a leading `~` is the home directory.
    fn file_exists(&self, path: &str) -> bool;
}

/// The process environment and file system (`defaultProviderAuthContext`).
pub struct ProcessAuthContext;

impl AuthContext for ProcessAuthContext {
    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
    }

    fn file_exists(&self, path: &str) -> bool {
        let resolved = match path.strip_prefix('~') {
            Some(rest) => match home_directory() {
                Some(home) => format!("{home}{rest}"),
                None => return false,
            },
            None => path.to_string(),
        };
        std::path::Path::new(&resolved).exists()
    }
}

fn home_directory() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .filter(|home| !home.is_empty())
}

/// How a provider resolves API-key auth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiKeyAuth {
    /// A stored key, else the first variable set (`envApiKeyAuth`): its display name and variables.
    Env(&'static str, &'static [&'static str]),
    /// A provider-specific resolver: its display name.
    Custom(&'static str),
}

impl ApiKeyAuth {
    pub fn name(&self) -> &'static str {
        match self {
            ApiKeyAuth::Env(name, _) | ApiKeyAuth::Custom(name) => name,
        }
    }
}

/// A provider's OAuth sign-in, as the login list shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OAuthInfo {
    pub name: &'static str,
    /// Access comes with a subscription (Claude Pro, ChatGPT Plus).
    pub is_subscription: Option<bool>,
    pub login_label: Option<&'static str>,
}

/// A built-in provider's auth methods.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderAuth {
    pub id: &'static str,
    pub name: &'static str,
    pub api_key: Option<ApiKeyAuth>,
    pub oauth: Option<OAuthInfo>,
}

const fn oauth(
    name: &'static str,
    is_subscription: Option<bool>,
    login_label: Option<&'static str>,
) -> Option<OAuthInfo> {
    Some(OAuthInfo {
        name,
        is_subscription,
        login_label,
    })
}

const fn env_key(
    id: &'static str,
    name: &'static str,
    key_name: &'static str,
    variable: &'static [&'static str],
) -> ProviderAuth {
    ProviderAuth {
        id,
        name,
        api_key: Some(ApiKeyAuth::Env(key_name, variable)),
        oauth: None,
    }
}

const fn custom(id: &'static str, name: &'static str, key_name: &'static str) -> ProviderAuth {
    ProviderAuth {
        id,
        name,
        api_key: Some(ApiKeyAuth::Custom(key_name)),
        oauth: None,
    }
}

const fn with_oauth(provider: ProviderAuth, oauth: Option<OAuthInfo>) -> ProviderAuth {
    ProviderAuth { oauth, ..provider }
}

const fn oauth_only(
    id: &'static str,
    name: &'static str,
    oauth: Option<OAuthInfo>,
) -> ProviderAuth {
    ProviderAuth {
        id,
        name,
        api_key: None,
        oauth,
    }
}

/// The built-in providers, in `builtinProviders` order.
pub const PROVIDERS: &[ProviderAuth] = &[
    custom(
        "amazon-bedrock",
        "Amazon Bedrock",
        "AWS credentials or bearer token",
    ),
    env_key(
        "ant-ling",
        "Ant Ling",
        "Ant Ling API key",
        &["ANT_LING_API_KEY"],
    ),
    with_oauth(
        custom("anthropic", "Anthropic", "Anthropic API key"),
        oauth("Anthropic (Claude Pro/Max)", Some(true), None),
    ),
    env_key(
        "azure-openai-responses",
        "Azure OpenAI",
        "Azure OpenAI API key",
        &["AZURE_OPENAI_API_KEY"],
    ),
    env_key(
        "baseten",
        "Baseten",
        "Baseten API key",
        &["BASETEN_API_KEY"],
    ),
    env_key(
        "cerebras",
        "Cerebras",
        "Cerebras API key",
        &["CEREBRAS_API_KEY"],
    ),
    custom(
        "cloudflare-ai-gateway",
        "Cloudflare AI Gateway",
        "Cloudflare API key",
    ),
    custom(
        "cloudflare-workers-ai",
        "Cloudflare Workers AI",
        "Cloudflare API key",
    ),
    env_key(
        "deepseek",
        "DeepSeek",
        "DeepSeek API key",
        &["DEEPSEEK_API_KEY"],
    ),
    env_key(
        "fireworks",
        "Fireworks",
        "Fireworks API key",
        &["FIREWORKS_API_KEY"],
    ),
    with_oauth(
        env_key(
            "github-copilot",
            "GitHub Copilot",
            "GitHub Copilot token",
            &["COPILOT_GITHUB_TOKEN"],
        ),
        oauth("GitHub Copilot", Some(true), None),
    ),
    env_key("google", "Google", "Gemini API key", &["GEMINI_API_KEY"]),
    oauth_only(
        "google-antigravity",
        "Google Antigravity",
        oauth(
            "Google Antigravity",
            None,
            Some("Sign in with Google Antigravity"),
        ),
    ),
    custom(
        "google-vertex",
        "Google Vertex AI",
        "Google Cloud credentials",
    ),
    env_key("groq", "Groq", "Groq API key", &["GROQ_API_KEY"]),
    env_key(
        "huggingface",
        "Hugging Face",
        "Hugging Face token",
        &["HF_TOKEN"],
    ),
    with_oauth(
        env_key(
            "kimi-coding",
            "Kimi For Coding",
            "Kimi API key",
            &["KIMI_API_KEY"],
        ),
        oauth(
            "Kimi Code (subscription)",
            Some(true),
            Some("Sign in with Kimi Code"),
        ),
    ),
    with_oauth(
        env_key("meta", "Meta", "Meta Model API key", &["META_API_KEY"]),
        oauth(
            "Meta (Muse subscription)",
            Some(true),
            Some("Sign in with Meta"),
        ),
    ),
    env_key(
        "minimax",
        "MiniMax",
        "MiniMax API key",
        &["MINIMAX_API_KEY"],
    ),
    env_key(
        "minimax-cn",
        "MiniMax CN",
        "MiniMax CN API key",
        &["MINIMAX_CN_API_KEY"],
    ),
    env_key(
        "mistral",
        "Mistral",
        "Mistral API key",
        &["MISTRAL_API_KEY"],
    ),
    env_key(
        "moonshotai",
        "Moonshot AI",
        "Moonshot AI API key",
        &["MOONSHOT_API_KEY"],
    ),
    env_key(
        "moonshotai-cn",
        "Moonshot AI CN",
        "Moonshot AI API key",
        &["MOONSHOT_API_KEY"],
    ),
    env_key("nvidia", "NVIDIA", "NVIDIA API key", &["NVIDIA_API_KEY"]),
    with_oauth(
        env_key("openai", "OpenAI", "OpenAI API key", &["OPENAI_API_KEY"]),
        oauth(
            "OpenAI (ChatGPT subscription)",
            Some(true),
            Some("Sign in with ChatGPT"),
        ),
    ),
    oauth_only(
        "openai-codex",
        "OpenAI Codex (legacy)",
        oauth("OpenAI (ChatGPT Plus/Pro)", Some(true), None),
    ),
    env_key(
        "opencode",
        "OpenCode Zen",
        "OpenCode API key",
        &["OPENCODE_API_KEY"],
    ),
    env_key(
        "opencode-go",
        "OpenCode Go",
        "OpenCode API key",
        &["OPENCODE_API_KEY"],
    ),
    with_oauth(
        env_key(
            "openrouter",
            "OpenRouter",
            "OpenRouter API key",
            &["OPENROUTER_API_KEY"],
        ),
        oauth("OpenRouter OAuth", None, Some("Sign in with OpenRouter")),
    ),
    env_key(
        "qwen-token-plan",
        "Qwen Token Plan",
        "Qwen Token Plan API key",
        &["QWEN_TOKEN_PLAN_API_KEY"],
    ),
    env_key(
        "qwen-token-plan-cn",
        "Qwen Token Plan CN",
        "Qwen Token Plan CN API key",
        &["QWEN_TOKEN_PLAN_CN_API_KEY"],
    ),
    env_key(
        "qwen-token-plan-individual",
        "Qwen Token Plan Individual",
        "Qwen Token Plan Individual API key",
        &["QWEN_TOKEN_PLAN_API_KEY"],
    ),
    env_key(
        "together",
        "Together",
        "Together API key",
        &["TOGETHER_API_KEY"],
    ),
    env_key(
        "typesafe",
        "TypeSafe",
        "TypeSafe API key",
        &["TYPESAFE_API_KEY"],
    ),
    env_key(
        "vercel-ai-gateway",
        "Vercel AI Gateway",
        "Vercel AI Gateway API key",
        &["AI_GATEWAY_API_KEY"],
    ),
    with_oauth(
        env_key("xai", "xAI", "xAI API key", &["XAI_API_KEY"]),
        oauth(
            "xAI (Grok/X subscription)",
            Some(true),
            Some("Sign in with SuperGrok or X Premium"),
        ),
    ),
    env_key("xiaomi", "Xiaomi", "Xiaomi API key", &["XIAOMI_API_KEY"]),
    env_key(
        "xiaomi-token-plan-ams",
        "Xiaomi Token Plan AMS",
        "Xiaomi Token Plan AMS API key",
        &["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
    ),
    env_key(
        "xiaomi-token-plan-cn",
        "Xiaomi Token Plan CN",
        "Xiaomi Token Plan CN API key",
        &["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
    ),
    env_key(
        "xiaomi-token-plan-sgp",
        "Xiaomi Token Plan SGP",
        "Xiaomi Token Plan SGP API key",
        &["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
    ),
    env_key("zai", "Z.AI", "Z.AI API key", &["ZAI_API_KEY"]),
    env_key(
        "zai-coding-cn",
        "Z.AI Coding CN",
        "Z.AI Coding CN API key",
        &["ZAI_CODING_CN_API_KEY"],
    ),
];

/// A built-in provider's auth methods.
pub fn provider(id: &str) -> Option<&'static ProviderAuth> {
    PROVIDERS.iter().find(|provider| provider.id == id)
}

const STORED: &str = "stored credential";

fn api_key_result(api_key: String, env: Option<Map<String, Value>>, source: &str) -> AuthResult {
    AuthResult {
        auth: ModelAuth {
            api_key: Some(api_key),
            ..ModelAuth::default()
        },
        env,
        source: Some(source.to_string()),
    }
}

fn ambient(env: Option<Map<String, Value>>, source: &str) -> AuthResult {
    AuthResult {
        auth: ModelAuth::default(),
        env,
        source: Some(source.to_string()),
    }
}

/// A non-empty stored key (`credential?.key` read as a condition).
fn stored_key(credential: Option<&ApiKeyCredential>) -> Option<&str> {
    credential
        .and_then(|credential| credential.key.as_deref())
        .filter(|key| !key.is_empty())
}

fn stored_key_result(credential: Option<&ApiKeyCredential>) -> Option<AuthResult> {
    let key = stored_key(credential)?;
    Some(api_key_result(
        key.to_string(),
        credential.and_then(|credential| credential.env.clone()),
        STORED,
    ))
}

fn resolve_env_key(
    variables: &[&str],
    credential: Option<&ApiKeyCredential>,
    ctx: &dyn AuthContext,
) -> Option<AuthResult> {
    if let Some(result) = stored_key_result(credential) {
        return Some(result);
    }
    variables.iter().find_map(|variable| {
        ctx.env(variable)
            .map(|value| api_key_result(value, None, variable))
    })
}

const ANTHROPIC_AUTH_TOKEN: &str = "ANTHROPIC_AUTH_TOKEN";

/// A stored key; `ANTHROPIC_AUTH_TOKEN` as a bearer header; an OAuth token or API key from the
/// environment; else workload identity federation, which the SDK exchanges for tokens itself.
fn resolve_anthropic(
    credential: Option<&ApiKeyCredential>,
    ctx: &dyn AuthContext,
) -> Option<AuthResult> {
    if let Some(result) = stored_key_result(credential) {
        return Some(result);
    }
    if let Some(token) = ctx.env(ANTHROPIC_AUTH_TOKEN) {
        let mut headers = Map::new();
        headers.insert("Authorization".into(), json!(format!("Bearer {token}")));
        return Some(AuthResult {
            auth: ModelAuth {
                headers: Some(headers),
                ..ModelAuth::default()
            },
            env: None,
            source: Some(ANTHROPIC_AUTH_TOKEN.into()),
        });
    }
    for variable in ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] {
        if let Some(value) = ctx.env(variable) {
            return Some(api_key_result(value, None, variable));
        }
    }
    let mut federation = Map::new();
    for variable in [
        "ANTHROPIC_FEDERATION_RULE_ID",
        "ANTHROPIC_ORGANIZATION_ID",
        "ANTHROPIC_IDENTITY_TOKEN_FILE",
    ] {
        federation.insert(variable.into(), json!(ctx.env(variable)?));
    }
    for variable in ["ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_WORKSPACE_ID"] {
        if let Some(value) = ctx.env(variable) {
            federation.insert(variable.into(), json!(value));
        }
    }
    Some(ambient(Some(federation), "workload identity federation"))
}

/// A bearer token or the AWS credential chain, which the SDK reads itself.
fn resolve_bedrock(
    credential: Option<&ApiKeyCredential>,
    ctx: &dyn AuthContext,
) -> Option<AuthResult> {
    if let Some(result) = stored_key_result(credential) {
        return Some(result);
    }
    if ctx.env("AWS_BEARER_TOKEN_BEDROCK").is_some() {
        return Some(ambient(None, "AWS_BEARER_TOKEN_BEDROCK"));
    }
    let stored_profile = credential.and_then(|credential| credential.env_value("AWS_PROFILE"));
    // `credential?.env?.AWS_PROFILE ?? env("AWS_PROFILE")`: a stored empty profile is not read
    // from the environment.
    let profile = match stored_profile {
        Some(profile) => Some(profile.to_string()),
        None => ctx.env("AWS_PROFILE"),
    };
    if profile.is_some_and(|profile| !profile.is_empty()) {
        let source = if stored_profile.is_some_and(|profile| !profile.is_empty()) {
            STORED
        } else {
            "AWS_PROFILE"
        };
        return Some(ambient(
            credential.and_then(|credential| credential.env.clone()),
            source,
        ));
    }
    if ctx.env("AWS_ACCESS_KEY_ID").is_some() && ctx.env("AWS_SECRET_ACCESS_KEY").is_some() {
        return Some(ambient(None, "AWS access keys"));
    }
    for (variable, source) in [
        ("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "ECS task role"),
        ("AWS_CONTAINER_CREDENTIALS_FULL_URI", "ECS task role"),
        ("AWS_WEB_IDENTITY_TOKEN_FILE", "web identity token"),
    ] {
        if ctx.env(variable).is_some() {
            return Some(ambient(None, source));
        }
    }
    None
}

const VERTEX_ADC_PATH: &str = "~/.config/gcloud/application_default_credentials.json";

/// A Google Cloud API key, else Application Default Credentials with a project and location.
/// Stored values count even when empty (`??`).
fn resolve_vertex(
    credential: Option<&ApiKeyCredential>,
    ctx: &dyn AuthContext,
) -> Option<AuthResult> {
    let stored = |name: &str| credential.and_then(|credential| credential.env_value(name));
    let stored_or_env = |name: &str| stored(name).map(str::to_string).or_else(|| ctx.env(name));
    let key = match credential.and_then(|credential| credential.key.clone()) {
        Some(key) => Some(key),
        None => ctx.env("GOOGLE_CLOUD_API_KEY"),
    };
    if let Some(key) = key.filter(|key| !key.is_empty()) {
        let source = if stored_key(credential).is_some() {
            STORED
        } else {
            "GOOGLE_CLOUD_API_KEY"
        };
        return Some(api_key_result(key, None, source));
    }
    let adc_path = stored_or_env("GOOGLE_APPLICATION_CREDENTIALS");
    let has_credentials = ctx.file_exists(adc_path.as_deref().unwrap_or(VERTEX_ADC_PATH));
    let project = stored("GOOGLE_CLOUD_PROJECT")
        .map(str::to_string)
        .or_else(|| ctx.env("GOOGLE_CLOUD_PROJECT"))
        .or_else(|| ctx.env("GCLOUD_PROJECT"));
    let location = stored_or_env("GOOGLE_CLOUD_LOCATION");
    let present = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.is_empty());
    if has_credentials && present(&project) && present(&location) {
        let source = if credential.is_some() {
            STORED
        } else {
            "gcloud application default credentials"
        };
        return Some(ambient(
            credential.and_then(|credential| credential.env.clone()),
            source,
        ));
    }
    None
}

const CLOUDFLARE_API_KEY: &str = "CLOUDFLARE_API_KEY";

/// A Cloudflare key and account id, plus a gateway id for AI Gateway; each a stored value
/// (even empty) else the environment.
fn resolve_cloudflare(
    gateway: bool,
    credential: Option<&ApiKeyCredential>,
    ctx: &dyn AuthContext,
) -> Option<AuthResult> {
    let value = |name: &str| {
        let stored = credential.and_then(|credential| {
            if name == CLOUDFLARE_API_KEY {
                credential.key.clone()
            } else {
                credential.env_value(name).map(str::to_string)
            }
        });
        stored.or_else(|| ctx.env(name))
    };
    // Every value is read before any is checked, as the TypeScript resolver does.
    let api_key = value(CLOUDFLARE_API_KEY);
    let account_id = value("CLOUDFLARE_ACCOUNT_ID");
    let gateway_id = gateway.then(|| value("CLOUDFLARE_GATEWAY_ID"));
    let present = |value: Option<String>| value.filter(|value| !value.is_empty());
    let api_key = present(api_key)?;
    let account_id = present(account_id)?;
    let gateway_id = match gateway_id {
        Some(gateway_id) => Some(present(gateway_id)?),
        None => None,
    };
    let mut env = Map::new();
    env.insert("CLOUDFLARE_ACCOUNT_ID".into(), json!(account_id));
    if let Some(gateway_id) = gateway_id {
        env.insert("CLOUDFLARE_GATEWAY_ID".into(), json!(gateway_id));
    }
    let source = if credential.is_some() {
        STORED
    } else {
        CLOUDFLARE_API_KEY
    };
    let auth = if gateway {
        let mut headers = Map::new();
        headers.insert(
            "cf-aig-authorization".into(),
            json!(format!("Bearer {api_key}")),
        );
        headers.insert("Authorization".into(), Value::Null);
        headers.insert("x-api-key".into(), Value::Null);
        ModelAuth {
            headers: Some(headers),
            ..ModelAuth::default()
        }
    } else {
        ModelAuth {
            api_key: Some(api_key),
            ..ModelAuth::default()
        }
    };
    Some(AuthResult {
        auth,
        env: Some(env),
        source: Some(source.into()),
    })
}

/// A provider's API-key auth from its stored credential and the environment; `None` when it is
/// not configured or the provider has no API-key auth.
pub fn resolve_api_key(
    provider_id: &str,
    credential: Option<&ApiKeyCredential>,
    ctx: &dyn AuthContext,
) -> Option<AuthResult> {
    match provider(provider_id)?.api_key? {
        ApiKeyAuth::Env(_, variables) => resolve_env_key(variables, credential, ctx),
        ApiKeyAuth::Custom(_) => match provider_id {
            "anthropic" => resolve_anthropic(credential, ctx),
            "amazon-bedrock" => resolve_bedrock(credential, ctx),
            "google-vertex" => resolve_vertex(credential, ctx),
            "cloudflare-ai-gateway" => resolve_cloudflare(true, credential, ctx),
            "cloudflare-workers-ai" => resolve_cloudflare(false, credential, ctx),
            _ => None,
        },
    }
}
