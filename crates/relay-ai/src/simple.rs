//! The simple layer (`simple-options.ts` and each adapter's `streamSimple`): provider-neutral
//! request options, a thinking level, budgets and an output limit, mapped to an adapter's own.
//!
//! The output limit is the request's or the model's, cut to what the context window leaves after
//! the context estimate (`estimate.ts`) and a safety margin. Budget thinking (Anthropic) adds the
//! budget to that limit within the model's; level thinking passes the level the model accepts.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::anthropic::AnthropicOptions;
use crate::google::{resolve_thinking_level, uses_thinking_level, GoogleOptions, GoogleThinking};
use crate::openai_completions::OpenAICompletionsOptions;
use crate::openai_responses::OpenAIResponsesOptions;
use crate::options::CacheRetention;
use crate::text::js_length;
use crate::transcript::system_message_text;
use crate::{Content, InputBlock, Message, Model, OutputBlock, StopReason, Tool, Usage};

/// Tokens kept free of the context window besides the estimate.
const CONTEXT_SAFETY_TOKENS: i64 = 4096;
/// Tokens always left for the answer when a thinking budget shares the output limit.
pub const MIN_ANSWER_TOKENS: i64 = 1024;
const CHARS_PER_TOKEN: usize = 4;
const ESTIMATED_IMAGE_CHARS: usize = 4800;

/// `SimpleStreamOptions`, the fields that shape the request.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleOptions {
    /// `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; none, or `off`, turns thinking off.
    pub reasoning: Option<String>,
    /// Token budgets by thinking level, over the defaults.
    pub thinking_budgets: Option<Map<String, Value>>,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub sampling_params: Option<Map<String, Value>>,
    /// `auto` or `none`.
    pub tool_choice: Option<String>,
    pub cache_retention: Option<CacheRetention>,
    pub session_id: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub headers: Option<Map<String, Value>>,
    pub metadata: Option<Map<String, Value>>,
}

impl SimpleOptions {
    /// The requested level. `off` is no level, as every adapter but Anthropic's reads it.
    fn reasoning(&self) -> Option<&str> {
        self.reasoning.as_deref().filter(|level| *level != "off")
    }
}

/// The context size a response reported (`calculateContextTokens`).
pub fn context_tokens(usage: &Usage) -> u64 {
    if usage.total_tokens != 0 {
        usage.total_tokens
    } else {
        usage.input + usage.output + usage.cache_read + usage.cache_write
    }
}

fn chars_tokens(chars: usize) -> u64 {
    chars.div_ceil(CHARS_PER_TOKEN) as u64
}

fn input_chars(content: &Content<InputBlock>) -> usize {
    match content {
        Content::Text(text) => js_length(text),
        Content::Blocks(blocks) => blocks.iter().map(block_chars).sum(),
    }
}

fn block_chars(block: &InputBlock) -> usize {
    match block {
        InputBlock::Text(text) => js_length(&text.text),
        InputBlock::Image(_) => ESTIMATED_IMAGE_CHARS,
    }
}

fn tools_tokens<T: Serialize>(tools: Option<&Vec<T>>) -> u64 {
    match tools {
        Some(tools) if !tools.is_empty() => {
            chars_tokens(js_length(&serde_json::to_string(tools).unwrap_or_default()))
        }
        _ => 0,
    }
}

/// A message's size at four characters per token, an image counting as 4800 characters
/// (`estimateMessageTokens`).
pub fn estimate_message_tokens(message: &Message) -> u64 {
    match message {
        Message::System(system) => {
            chars_tokens(js_length(&system_message_text(system)))
                + tools_tokens::<Tool>(system.tools_added.as_ref())
                + tools_tokens(system.tools_removed.as_ref())
        }
        Message::User(user) => chars_tokens(input_chars(&user.content)),
        Message::ToolResult(result) => chars_tokens(result.content.iter().map(block_chars).sum()),
        Message::Assistant(assistant) => chars_tokens(
            assistant
                .content
                .iter()
                .map(|block| match block {
                    OutputBlock::Text(text) => js_length(&text.text),
                    OutputBlock::Thinking(thinking) => js_length(&thinking.thinking),
                    OutputBlock::ToolCall(call) => {
                        js_length(&call.name)
                            + js_length(&serde_json::to_string(&call.arguments).unwrap_or_default())
                    }
                })
                .sum(),
        ),
    }
}

/// The context size (`estimateContextTokens`): the last usage that still describes the
/// conversation before it, plus estimates of what came after; else estimates of every message.
///
/// A usage counts unless its response failed or was aborted, reported nothing, or a message
/// with a later time came before it (a compaction summary inserted after the response).
pub fn estimate_context_tokens(messages: &[Message]) -> u64 {
    let mut latest_prefix: Option<u64> = None;
    let mut last_usage: Option<(u64, usize)> = None;
    for (index, message) in messages.iter().enumerate() {
        let timestamp = match message {
            Message::System(system) => system.timestamp,
            Message::User(user) => user.timestamp,
            Message::ToolResult(result) => result.timestamp,
            Message::Assistant(assistant) => {
                let applies = latest_prefix.is_none_or(|latest| assistant.timestamp >= latest);
                let tokens = context_tokens(&assistant.usage);
                if applies
                    && !matches!(
                        assistant.stop_reason,
                        StopReason::Aborted | StopReason::Error
                    )
                    && tokens > 0
                {
                    last_usage = Some((tokens, index));
                }
                assistant.timestamp
            }
        };
        latest_prefix = Some(latest_prefix.map_or(timestamp, |latest| latest.max(timestamp)));
    }
    match last_usage {
        Some((tokens, index)) => {
            tokens
                + messages[index + 1..]
                    .iter()
                    .map(estimate_message_tokens)
                    .sum::<u64>()
        }
        None => messages.iter().map(estimate_message_tokens).sum(),
    }
}

/// The output limit cut to what the context window leaves, at least 1
/// (`clampMaxTokensToContext`). A model without a window keeps the limit.
pub fn clamp_max_tokens_to_context(model: &Model, messages: &[Message], max_tokens: i64) -> i64 {
    let window = model.context_window.unwrap_or(0) as i64;
    if window <= 0 {
        return max_tokens.max(1);
    }
    let available = window - estimate_context_tokens(messages) as i64 - CONTEXT_SAFETY_TOKENS;
    max_tokens.min(available.max(1))
}

/// What `buildBaseOptions` resolves for every adapter.
struct Base {
    max_tokens: i64,
    sampling_params: Option<Map<String, Value>>,
}

fn base(model: &Model, messages: &[Message], options: &SimpleOptions) -> Base {
    let requested = options.max_tokens.unwrap_or(model.max_tokens) as i64;
    Base {
        max_tokens: clamp_max_tokens_to_context(model, messages, requested),
        sampling_params: model.sampling_params(
            options.reasoning.as_deref().unwrap_or("off"),
            options.sampling_params.as_ref(),
        ),
    }
}

/// A level's token budget: the custom one, else the default; `xhigh` and `max` use `high`'s
/// (`thinkingBudgetForLevel`).
pub fn thinking_budget_for_level(level: &str, custom: Option<&Map<String, Value>>) -> Option<i64> {
    let level = if matches!(level, "xhigh" | "max") {
        "high"
    } else {
        level
    };
    if let Some(budget) = custom.and_then(|budgets| budgets.get(level)) {
        return budget
            .as_i64()
            .or_else(|| budget.as_f64().map(|float| float as i64));
    }
    match level {
        "minimal" => Some(1024),
        "low" => Some(2048),
        "medium" => Some(8192),
        "high" => Some(16384),
        _ => None,
    }
}

fn answer_room(budget: i64, ceiling: i64) -> i64 {
    budget.min((ceiling - MIN_ANSWER_TOKENS).max(0))
}

/// Anthropic's effort for adaptive thinking: the model's mapped level, else the nearest effort.
fn anthropic_effort(model: &Model, level: &str) -> String {
    if let Some(Value::String(mapped)) = model.thinking_level(level) {
        return mapped.clone();
    }
    match level {
        "minimal" | "low" => "low",
        "medium" => "medium",
        _ => "high",
    }
    .to_string()
}

fn non_negative(tokens: i64) -> u64 {
    tokens.max(0) as u64
}

/// Anthropic's `streamSimple`: no level turns thinking off; adaptive models take an effort;
/// others get a budget, added to the output limit within the model's, that leaves 1024 tokens
/// for the answer.
pub fn anthropic_options(
    model: &Model,
    messages: &[Message],
    options: &SimpleOptions,
) -> AnthropicOptions {
    let base = base(model, messages, options);
    let mut result = AnthropicOptions {
        max_tokens: Some(non_negative(base.max_tokens)),
        temperature: options.temperature,
        cache_retention: options.cache_retention,
        env: options.env.clone(),
        headers: options.headers.clone(),
        metadata: options.metadata.clone(),
        tool_choice: options.tool_choice.clone().map(Value::String),
        ..AnthropicOptions::default()
    };
    let Some(level) = options.reasoning() else {
        result.thinking_enabled = Some(false);
        return result;
    };
    result.thinking_enabled = Some(true);
    if model.compat().force_adaptive_thinking == Some(true) {
        result.effort = Some(anthropic_effort(model, level));
        return result;
    }
    let mut budget =
        thinking_budget_for_level(level, options.thinking_budgets.as_ref()).unwrap_or(0);
    let max_tokens = (base.max_tokens + budget).min(model.max_tokens as i64);
    if max_tokens <= budget {
        budget = answer_room(budget, max_tokens);
    }
    let max_tokens = clamp_max_tokens_to_context(model, messages, max_tokens);
    result.max_tokens = Some(non_negative(max_tokens));
    result.thinking_budget_tokens = Some(non_negative(answer_room(budget, max_tokens)));
    result
}

/// The level the model accepts, none when that is `off`.
fn reasoning_effort(model: &Model, options: &SimpleOptions) -> Option<String> {
    let level = model.clamp_thinking_level(options.reasoning.as_deref()?);
    (level != "off").then(|| level.to_string())
}

/// The OpenAI Responses `streamSimple`.
pub fn openai_responses_options(
    model: &Model,
    messages: &[Message],
    options: &SimpleOptions,
) -> OpenAIResponsesOptions {
    let base = base(model, messages, options);
    OpenAIResponsesOptions {
        max_tokens: Some(non_negative(base.max_tokens)),
        temperature: options.temperature,
        cache_retention: options.cache_retention,
        env: options.env.clone(),
        session_id: options.session_id.clone(),
        tool_choice: options.tool_choice.clone().map(Value::String),
        reasoning_effort: reasoning_effort(model, options),
        sampling_params: base.sampling_params,
        ..OpenAIResponsesOptions::default()
    }
}

/// The OpenAI Chat Completions `streamSimple`: the Responses mapping plus the custom budgets.
pub fn openai_completions_options(
    model: &Model,
    messages: &[Message],
    options: &SimpleOptions,
) -> OpenAICompletionsOptions {
    let base = base(model, messages, options);
    OpenAICompletionsOptions {
        max_tokens: Some(non_negative(base.max_tokens)),
        temperature: options.temperature,
        cache_retention: options.cache_retention,
        env: options.env.clone(),
        session_id: options.session_id.clone(),
        tool_choice: options.tool_choice.clone().map(Value::String),
        reasoning_effort: reasoning_effort(model, options),
        thinking_budgets: options.thinking_budgets.clone(),
        sampling_params: base.sampling_params,
    }
}

/// Gemini 2.5's budgets per level; other models think dynamically (-1).
fn google_budget(model: &Model, level: &str, custom: Option<&Map<String, Value>>) -> i64 {
    if let Some(budget) = custom.and_then(|budgets| budgets.get(level)) {
        return budget
            .as_i64()
            .or_else(|| budget.as_f64().map(|float| float as i64))
            .unwrap_or(-1);
    }
    let budgets: [i64; 4] = if model.id.contains("2.5-pro") {
        [128, 2048, 8192, 32768]
    } else if model.id.contains("2.5-flash-lite") {
        [512, 2048, 8192, 24576]
    } else if model.id.contains("2.5-flash") {
        [128, 2048, 8192, 24576]
    } else {
        return -1;
    };
    match level {
        "minimal" => budgets[0],
        "low" => budgets[1],
        "medium" => budgets[2],
        _ => budgets[3],
    }
}

/// Google's `streamSimple`: no level, or one the model clamps to `off`, turns thinking off;
/// Gemini 3 takes the level, others a budget. Fails when the model maps the level to nothing
/// Google knows.
pub fn google_options(
    model: &Model,
    messages: &[Message],
    options: &SimpleOptions,
) -> Result<GoogleOptions, String> {
    let base = base(model, messages, options);
    let off = GoogleThinking {
        enabled: false,
        ..GoogleThinking::default()
    };
    let thinking = match options.reasoning() {
        None => off,
        Some(level) => match model.clamp_thinking_level(level) {
            "off" => off,
            clamped => {
                let api_level = resolve_thinking_level(model, clamped)?;
                if uses_thinking_level(model) {
                    GoogleThinking {
                        enabled: true,
                        budget_tokens: None,
                        level: Some(api_level.to_string()),
                    }
                } else {
                    GoogleThinking {
                        enabled: true,
                        budget_tokens: Some(google_budget(
                            model,
                            &api_level.to_lowercase(),
                            options.thinking_budgets.as_ref(),
                        )),
                        level: None,
                    }
                }
            }
        },
    };
    Ok(GoogleOptions {
        max_tokens: Some(non_negative(base.max_tokens)),
        temperature: options.temperature,
        tool_choice: options.tool_choice.clone(),
        thinking: Some(thinking),
    })
}
