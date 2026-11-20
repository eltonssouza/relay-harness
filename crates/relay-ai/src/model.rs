//! A catalog chat model (`Model` in `packages/ai/src/types.ts`). A built-in catalog entry reads
//! and writes back unchanged; unknown fields are dropped.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::json::serialize_js_f64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `chat` for catalog chat models; absent means chat.
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub model_type: Option<String>,
    pub api: String,
    pub provider: String,
    pub base_url: String,
    pub reasoning: bool,
    /// `"text"` and, for vision models, `"image"`.
    pub input: Vec<String>,
    /// Request size and image limits, and how images are resized before they enter the history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_limits: Option<InputLimits>,
    pub max_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<ModelCost>,
    /// Headers sent with every request; a `null` value removes a header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<ModelCompat>,
    /// Provider levels per Relay thinking level; `off: null` means thinking cannot be turned off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level_map: Option<Map<String, Value>>,
    /// Prompt cache lifetimes in seconds per retention (`short`, `long`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache: Option<Map<String, Value>>,
    /// Sampling parameters sent with every request, before the thinking level's and the request's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampling_params: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampling_params_by_thinking_level: Option<Map<String, Value>>,
}

impl Model {
    pub fn accepts_images(&self) -> bool {
        self.input.iter().any(|kind| kind == "image")
    }

    pub fn compat(&self) -> ModelCompat {
        self.compat.clone().unwrap_or_default()
    }

    /// `thinkingLevelMap[level]`: `None` when absent, `Some(Value::Null)` when unsupported.
    pub fn thinking_level(&self, level: &str) -> Option<&Value> {
        self.thinking_level_map
            .as_ref()
            .and_then(|map| map.get(level))
    }

    /// The thinking levels the model accepts (`getSupportedThinkingLevels`).
    pub fn supported_thinking_levels(&self) -> Vec<&'static str> {
        if !self.reasoning {
            return vec!["off"];
        }
        THINKING_LEVELS
            .into_iter()
            .filter(|level| match self.thinking_level(level) {
                Some(Value::Null) => false,
                mapped if matches!(*level, "xhigh" | "max") => mapped.is_some(),
                _ => true,
            })
            .collect()
    }

    /// The nearest accepted level: the requested one, else the next higher, else the next lower
    /// (`clampThinkingLevel`).
    pub fn clamp_thinking_level(&self, level: &str) -> &'static str {
        let available = self.supported_thinking_levels();
        if let Some(found) = available.iter().find(|candidate| **candidate == level) {
            return found;
        }
        let first = available.first().copied().unwrap_or("off");
        let Some(requested) = THINKING_LEVELS
            .iter()
            .position(|candidate| *candidate == level)
        else {
            return first;
        };
        THINKING_LEVELS[requested..]
            .iter()
            .chain(THINKING_LEVELS[..requested].iter().rev())
            .find(|candidate| available.contains(candidate))
            .copied()
            .unwrap_or(first)
    }

    /// The sampling parameters for a request (`resolveSamplingParams`): the model's, then its
    /// thinking level's, then the request's, each key overriding the earlier ones.
    pub fn sampling_params(
        &self,
        thinking_level: &str,
        request: Option<&Map<String, Value>>,
    ) -> Option<Map<String, Value>> {
        let level = self.clamp_thinking_level(thinking_level);
        let by_level = self
            .sampling_params_by_thinking_level
            .as_ref()
            .and_then(|levels| levels.get(level))
            .and_then(Value::as_object);
        if self.sampling_params.is_none() && by_level.is_none() && request.is_none() {
            return None;
        }
        let mut merged = Map::new();
        for source in [self.sampling_params.as_ref(), by_level, request]
            .into_iter()
            .flatten()
        {
            for (key, value) in source {
                merged.insert(key.clone(), value.clone());
            }
        }
        Some(merged)
    }
}

/// Relay's thinking levels, lowest first.
pub const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// Provider compatibility switches. Each is optional; the adapter decides the default.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCompat {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_eager_tool_input_streaming: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_long_cache_retention: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_cache_control_on_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_temperature: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force_adaptive_thinking: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_empty_signature: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_strict_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_mid_convo_effort: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_mid_convo_system_messages: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_mid_convo_tool_changes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_fallback_models: Option<Vec<FallbackModel>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_developer_role: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_strict_mode: Option<bool>,
    #[serde(
        rename = "supportsOpenAIGrammarTools",
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_openai_grammar_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_additional_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_tool_search: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_explicit_prompt_cache_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_max_output_tokens: Option<bool>,
    // OpenAI Chat Completions servers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_store: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_reasoning_effort: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_usage_in_streaming: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_finish_reason: Option<bool>,
    /// `max_completion_tokens` or `max_tokens`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_tool_result_name: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_assistant_after_tool_result: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_thinking_as_text: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_reasoning_content_on_assistant_messages: Option<bool>,
    /// How the server takes reasoning settings: `openai`, `deepseek`, `zai`, `qwen`, and others.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_template_kwargs: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_template_args: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_router_routing: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vercel_gateway_routing: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zai_tool_stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_token_budget_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_thinking_token_budget: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_mid_convo_tool_additions: Option<bool>,
    /// Send session affinity headers with the session id (OpenAI-compatible servers).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub send_session_affinity_headers: Option<bool>,
    /// `openai`, `openai-nosession` or `openrouter`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_affinity_format: Option<String>,
    /// `anthropic` for servers that take Anthropic-style cache markers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_control_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vllm_priority: Option<Value>,
}

/// `ModelInputLimits`: what a provider request may hold.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputLimits {
    /// The largest serialized request, in bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_request_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<ImageInputLimits>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInputLimits {
    /// How an image is resized before it enters the conversation, so the cached prefix stays the
    /// same.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resize: Option<ImageResize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_per_message: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_per_request: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResize {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_width: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_height: Option<u64>,
    /// The largest base64 payload, in bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jpeg_quality: Option<u64>,
}

/// A model Anthropic may answer with instead, and its price for such answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FallbackModel {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<ModelCost>,
}

/// Prices in dollars per million tokens.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    #[serde(serialize_with = "serialize_js_f64")]
    pub input: f64,
    #[serde(serialize_with = "serialize_js_f64")]
    pub output: f64,
    #[serde(serialize_with = "serialize_js_f64")]
    pub cache_read: f64,
    #[serde(serialize_with = "serialize_js_f64")]
    pub cache_write: f64,
    /// Request-wide tiers; the highest threshold the input exceeds prices the whole request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tiers: Option<Vec<CostTier>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostTier {
    #[serde(serialize_with = "serialize_js_f64")]
    pub input_tokens_above: f64,
    #[serde(serialize_with = "serialize_js_f64")]
    pub input: f64,
    #[serde(serialize_with = "serialize_js_f64")]
    pub output: f64,
    #[serde(serialize_with = "serialize_js_f64")]
    pub cache_read: f64,
    #[serde(serialize_with = "serialize_js_f64")]
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
