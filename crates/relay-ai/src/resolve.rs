//! A provider's request auth (`resolveProviderAuth`, `packages/ai/src/auth/resolve.ts`): an API
//! key given with the request; else the stored credential, which owns the provider; else the
//! environment.
//!
//! A stored OAuth token with less than five minutes left is refreshed under the `auth.json`
//! lock, and saved before the lock is released. The expiry is checked again under the lock, so
//! concurrent requests and processes refresh once; a provider logged out meanwhile has no auth.
//! The refresh may take 15 seconds.

use std::time::Duration;

use serde_json::{Map, Value};

use crate::auth::{
    provider, resolve_api_key, ApiKeyCredential, AuthContext, AuthResult, Credential,
    OAuthCredential,
};
use crate::auth_file::{AuthFile, ModifyError};
use crate::oauth::{self, OAuthContext};

/// Five minutes: a token closer to its expiry than this is refreshed first.
const MINIMUM_VALIDITY_MS: f64 = 5.0 * 60.0 * 1000.0;
const REFRESH_TIMEOUT: Duration = Duration::from_secs(15);

/// `AuthResolutionOverrides`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AuthOverrides {
    /// A key for this request, over any stored credential.
    pub api_key: Option<String>,
    /// Provider settings over the stored ones and the environment.
    pub env: Option<Map<String, Value>>,
    /// Require this much token validity after a refresh, in milliseconds.
    pub min_oauth_validity_ms: Option<f64>,
}

/// `ModelsError` with code `auth` or `oauth`: what failed, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthError {
    pub code: &'static str,
    pub message: String,
    pub cause: Option<String>,
}

impl AuthError {
    fn new(code: &'static str, message: String, cause: Option<String>) -> Self {
        AuthError {
            code,
            message,
            cause,
        }
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.cause {
            Some(cause) => write!(formatter, "{}: {cause}", self.message),
            None => formatter.write_str(&self.message),
        }
    }
}

impl std::error::Error for AuthError {}

/// The environment with the request's provider settings first.
struct Overlay<'a> {
    base: &'a dyn AuthContext,
    env: Option<&'a Map<String, Value>>,
}

impl AuthContext for Overlay<'_> {
    fn env(&self, name: &str) -> Option<String> {
        self.env
            .and_then(|env| env.get(name))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.base.env(name))
    }

    fn file_exists(&self, path: &str) -> bool {
        self.base.file_exists(path)
    }
}

/// A provider's request auth; `None` when it is not configured.
pub async fn resolve_provider_auth(
    provider_id: &str,
    file: &AuthFile,
    ctx: &dyn AuthContext,
    oauth_ctx: &impl OAuthContext,
    overrides: &AuthOverrides,
) -> Result<Option<AuthResult>, AuthError> {
    let Some(methods) = provider(provider_id) else {
        return Ok(None);
    };
    let overlay = Overlay {
        base: ctx,
        env: overrides.env.as_ref(),
    };
    if let (Some(key), Some(_)) = (&overrides.api_key, methods.api_key) {
        let credential = ApiKeyCredential {
            key: Some(key.clone()),
            env: overrides.env.clone(),
        };
        return Ok(resolve_api_key(provider_id, Some(&credential), &overlay));
    }
    let stored = file.read(provider_id).map_err(|error| {
        AuthError::new(
            "auth",
            format!("Credential store read failed for {provider_id}"),
            Some(error),
        )
    })?;
    match stored {
        Some(Credential::Oauth(credential)) if methods.oauth.is_some() => {
            resolve_stored_oauth(provider_id, file, oauth_ctx, credential, overrides).await
        }
        Some(Credential::ApiKey(mut credential)) if methods.api_key.is_some() => {
            if let Some(env) = &overrides.env {
                let merged = credential.env.get_or_insert_with(Map::new);
                for (name, value) in env {
                    merged.insert(name.clone(), value.clone());
                }
            }
            Ok(resolve_api_key(provider_id, Some(&credential), &overlay))
        }
        // A credential of a kind the provider has no handler for: no fallback to the environment.
        Some(_) => Ok(None),
        None => Ok(resolve_api_key(provider_id, None, &overlay)),
    }
}

async fn resolve_stored_oauth(
    provider_id: &str,
    file: &AuthFile,
    oauth_ctx: &impl OAuthContext,
    stored: OAuthCredential,
    overrides: &AuthOverrides,
) -> Result<Option<AuthResult>, AuthError> {
    let minimum = MINIMUM_VALIDITY_MS.max(overrides.min_oauth_validity_ms.unwrap_or(0.0));
    let expires_soon =
        |credential: &OAuthCredential| oauth_ctx.now_ms() + minimum >= credential.expires;
    let mut credential = stored;
    if expires_soon(&credential) {
        let refreshed = file
            .modify_async(provider_id, |current| async {
                // Checked again under the lock: another process may have refreshed, or logged out.
                let Some(Credential::Oauth(current)) = current else {
                    return Ok(None);
                };
                if !expires_soon(&current) {
                    return Ok(None);
                }
                let refresh = oauth::refresh(provider_id, &current, oauth_ctx);
                match tokio::time::timeout(REFRESH_TIMEOUT, refresh).await {
                    Ok(Ok(next)) => Ok(Some(Credential::Oauth(next))),
                    Ok(Err(error)) => Err(error),
                    Err(_) => Err("The operation was aborted due to timeout".to_string()),
                }
            })
            .await
            .map_err(|error| match error {
                ModifyError::Change(cause) => AuthError::new(
                    "oauth",
                    format!("OAuth refresh failed for {provider_id}"),
                    Some(cause),
                ),
                ModifyError::Store(cause) => AuthError::new(
                    "auth",
                    format!("Credential store modify failed for {provider_id}"),
                    Some(cause),
                ),
            })?;
        let Some(Credential::Oauth(refreshed)) = refreshed else {
            return Ok(None);
        };
        credential = refreshed;
        if overrides.min_oauth_validity_ms.is_some() && expires_soon(&credential) {
            return Err(AuthError::new(
                "oauth",
                format!("OAuth refresh returned a token that expires too soon for {provider_id}"),
                None,
            ));
        }
    }
    let auth = oauth::to_auth(provider_id, &credential).map_err(|error| {
        AuthError::new(
            "oauth",
            format!("OAuth auth derivation failed for {provider_id}"),
            Some(error),
        )
    })?;
    Ok(Some(AuthResult {
        auth,
        env: None,
        source: Some("OAuth".into()),
    }))
}
