//! Request options several adapters share: cache retention and the provider environment.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheRetention {
    None,
    Short,
    Long,
}

/// `getProviderEnvValue`: the provider environment first, then the process environment; an
/// empty value counts as unset.
pub fn provider_env(name: &str, env: Option<&HashMap<String, String>>) -> Option<String> {
    env.and_then(|env| env.get(name))
        .filter(|value| !value.is_empty())
        .cloned()
        .or_else(|| std::env::var(name).ok().filter(|value| !value.is_empty()))
}

/// The requested retention, else `long` when `RELAY_CACHE_RETENTION=long`, else `short`.
pub fn resolve_cache_retention(
    retention: Option<CacheRetention>,
    env: Option<&HashMap<String, String>>,
) -> CacheRetention {
    match retention {
        Some(retention) => retention,
        None if provider_env("RELAY_CACHE_RETENTION", env).as_deref() == Some("long") => {
            CacheRetention::Long
        }
        None => CacheRetention::Short,
    }
}
