//! The built-in model catalog: the provider files `packages/ai/scripts/generate-models.ts`
//! writes to `packages/ai/src/providers/data/`, compiled into the binary.
//!
//! Each file groups its entries by API, keyed `<type>:<id>`. A provider's chat models are its
//! `chat` entries in file order, one per id, as `getBuiltinModels` flattens them; image and
//! classifier entries come with the APIs that use them. Providers are in `getBuiltinProviders`
//! order, which is their ids sorted.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::{Map, Value};

use crate::Model;

macro_rules! provider_files {
    ($($id:literal),* $(,)?) => {
        &[$((
            $id,
            include_str!(concat!("../../../packages/ai/src/providers/data/", $id, ".json")),
        )),*]
    };
}

/// Each built-in provider and its catalog file. `tests/catalog.rs` checks this against the
/// directory.
const PROVIDER_FILES: &[(&str, &str)] = provider_files![
    "amazon-bedrock",
    "ant-ling",
    "anthropic",
    "azure-openai-responses",
    "baseten",
    "cerebras",
    "cloudflare-ai-gateway",
    "cloudflare-workers-ai",
    "deepseek",
    "fireworks",
    "github-copilot",
    "google",
    "google-vertex",
    "groq",
    "huggingface",
    "kimi-coding",
    "meta",
    "minimax",
    "minimax-cn",
    "mistral",
    "moonshotai",
    "moonshotai-cn",
    "nvidia",
    "openai",
    "openai-codex",
    "opencode",
    "opencode-go",
    "openrouter",
    "qwen-token-plan",
    "qwen-token-plan-cn",
    "qwen-token-plan-individual",
    "together",
    "typesafe",
    "vercel-ai-gateway",
    "xai",
    "xiaomi",
    "xiaomi-token-plan-ams",
    "xiaomi-token-plan-cn",
    "xiaomi-token-plan-sgp",
    "zai",
    "zai-coding-cn",
];

const MANIFEST: &str = include_str!("../../../packages/ai/src/providers/data/.manifest.json");

/// The built-in provider ids, sorted.
pub fn providers() -> impl Iterator<Item = &'static str> {
    PROVIDER_FILES.iter().map(|(id, _)| *id)
}

/// A catalog file's entries of one type, in file order; a repeated id keeps its first place
/// and its last entry, as `Object.fromEntries` does.
pub fn entries_of_type(file: &Value, model_type: &str) -> Vec<Value> {
    let mut by_id = Map::new();
    for group in file.as_object().into_iter().flat_map(Map::values) {
        for entry in group.as_object().into_iter().flat_map(Map::values) {
            if entry.get("type").and_then(Value::as_str) != Some(model_type) {
                continue;
            }
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                by_id.insert(id.to_string(), entry.clone());
            }
        }
    }
    by_id.into_iter().map(|(_, entry)| entry).collect()
}

fn read_provider(id: &str, text: &str) -> Vec<Model> {
    let file: Value = serde_json::from_str(text)
        .unwrap_or_else(|error| panic!("catalog file {id}.json: {error}"));
    entries_of_type(&file, "chat")
        .into_iter()
        .map(|entry| {
            serde_json::from_value(entry)
                .unwrap_or_else(|error| panic!("catalog file {id}.json: {error}"))
        })
        .collect()
}

fn catalog() -> &'static HashMap<&'static str, Vec<Model>> {
    static CATALOG: OnceLock<HashMap<&'static str, Vec<Model>>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        PROVIDER_FILES
            .iter()
            .map(|(id, text)| (*id, read_provider(id, text)))
            .collect()
    })
}

/// A provider's built-in chat models (`getBuiltinModels`); none for an unknown provider.
pub fn models(provider: &str) -> &'static [Model] {
    catalog().get(provider).map_or(&[], Vec::as_slice)
}

/// One built-in chat model (`getBuiltinModel`).
pub fn model(provider: &str, id: &str) -> Option<&'static Model> {
    models(provider).iter().find(|model| model.id == id)
}

/// When the catalog was generated, as the manifest records it (an ISO 8601 time).
pub fn generated_at() -> Option<String> {
    let manifest: Value = serde_json::from_str(MANIFEST).ok()?;
    manifest
        .get("generatedAt")
        .and_then(Value::as_str)
        .map(str::to_string)
}
