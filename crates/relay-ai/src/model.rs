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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FallbackModel {
    pub model: String,
}
