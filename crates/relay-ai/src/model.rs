//! The parts of a catalog model (`Model` in `packages/ai/src/types.ts`) that request building
//! reads. Unknown fields are ignored, so a full catalog entry reads as well.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub api: String,
    pub provider: String,
    pub base_url: String,
    pub reasoning: bool,
    /// `"text"` and, for vision models, `"image"`.
    pub input: Vec<String>,
    pub max_tokens: u64,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub cost: Option<ModelCost>,
    /// Headers sent with every request; a `null` value removes a header.
    #[serde(default)]
    pub headers: Option<Map<String, Value>>,
    #[serde(default)]
    pub compat: Option<ModelCompat>,
    /// Provider levels per Relay thinking level; `off: null` means thinking cannot be turned off.
    #[serde(default)]
    pub thinking_level_map: Option<Map<String, Value>>,
}

impl Model {
    pub fn accepts_images(&self) -> bool {
        self.input.iter().any(|kind| kind == "image")
    }

    pub fn compat(&self) -> ModelCompat {
        self.compat.clone().unwrap_or_default()
    }
}

/// Provider compatibility switches. Each is optional; the adapter decides the default.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCompat {
    pub supports_eager_tool_input_streaming: Option<bool>,
    pub supports_long_cache_retention: Option<bool>,
    pub supports_cache_control_on_tools: Option<bool>,
    pub supports_temperature: Option<bool>,
    pub force_adaptive_thinking: Option<bool>,
    pub allow_empty_signature: Option<bool>,
    pub supports_strict_tools: Option<bool>,
    pub supports_mid_convo_effort: Option<bool>,
    pub supports_mid_convo_system_messages: Option<bool>,
    pub supports_mid_convo_tool_changes: Option<bool>,
    pub allowed_fallback_models: Option<Vec<FallbackModel>>,
}

/// A model Anthropic may answer with instead, and its price for such answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FallbackModel {
    pub model: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub cost: Option<ModelCost>,
}

/// Prices in dollars per million tokens.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    /// Request-wide tiers; the highest threshold the input exceeds prices the whole request.
    #[serde(default)]
    pub tiers: Option<Vec<CostTier>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostTier {
    pub input_tokens_above: f64,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// Set `usage.cost` from the token counts, as `calculateCost` does: Anthropic charges twice the
/// input price for 1h cache writes.
pub fn calculate_cost(cost: &ModelCost, usage: &mut crate::Usage) {
    let input_tokens = (usage.input + usage.cache_read + usage.cache_write) as f64;
    let mut rates = (cost.input, cost.output, cost.cache_read, cost.cache_write);
    let mut matched = -1.0;
    for tier in cost.tiers.iter().flatten() {
        if input_tokens > tier.input_tokens_above && tier.input_tokens_above > matched {
            rates = (tier.input, tier.output, tier.cache_read, tier.cache_write);
            matched = tier.input_tokens_above;
        }
    }
    let (input, output, cache_read, cache_write) = rates;
    let long_write = usage.cache_write_1h.unwrap_or(0) as f64;
    let short_write = usage.cache_write as f64 - long_write;
    usage.cost.input = (input / 1_000_000.0) * usage.input as f64;
    usage.cost.output = (output / 1_000_000.0) * usage.output as f64;
    usage.cost.cache_read = (cache_read / 1_000_000.0) * usage.cache_read as f64;
    usage.cost.cache_write = (cache_write * short_write + input * 2.0 * long_write) / 1_000_000.0;
    usage.cost.total =
        usage.cost.input + usage.cost.output + usage.cost.cache_read + usage.cost.cache_write;
}
