//! The OpenAI Chat Completions request body, as `buildParams`, `convertMessages` and
//! `convertTools` in `packages/ai/src/api/openai-completions.ts` build it, for OpenAI and the many
//! servers that speak its API. `tests/openai_completions.rs` compares it with the TypeScript body
//! byte for byte.
//!
//! Servers differ in what they accept, so the adapter first works out a compatibility profile
//! (`detect_compat`): from the provider id and base URL, then overridden field by field by the
//! model's own `compat`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::message::{InputBlock, Message, OutputBlock, Tool};
use crate::model::Model;
use crate::options::{resolve_cache_retention, CacheRetention};
use crate::strict::{
    grammar_tool_input, grammar_tool_input_properties, json_schema_tool_parameters,
    resolve_grammar_constrained_sampling, resolve_json_schema_strict_sampling,
};
use crate::text::{is_blank, js_length, replace_non_id_characters, short_hash};
use crate::transcript::{
    declared_tools, render_system_message_update, resolve_transcript, resolve_transcript_tools,
    system_message_text,
};
use crate::transform::transform_messages;
use crate::Content;

const REASONING_FIELDS: [&str; 3] = ["reasoning", "reasoning_content", "reasoning_text"];
const TOOL_RESULT_BRIDGE: &str = "I have processed the tool results.";
/// Tokens always left for the answer when a thinking budget shares the output limit.
const MIN_ANSWER_TOKENS: i64 = 1024;
const PROMPT_CACHE_KEY_MAX_LENGTH: usize = 64;

/// The options of `OpenAICompletionsOptions` that shape the body.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAICompletionsOptions {
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub cache_retention: Option<CacheRetention>,
    pub env: Option<HashMap<String, String>>,
    pub session_id: Option<String>,
    pub tool_choice: Option<Value>,
    pub reasoning_effort: Option<String>,
    /// Token budgets by thinking level, over the defaults.
    pub thinking_budgets: Option<Map<String, Value>>,
    pub sampling_params: Option<Map<String, Value>>,
}

/// The compatibility profile: what the server accepts.
#[derive(Debug, Clone)]
struct Compat {
    supports_tools: Option<bool>,
    supports_store: bool,
    supports_developer_role: bool,
    supports_reasoning_effort: bool,
    supports_usage_in_streaming: bool,
    max_tokens_field: String,
    requires_tool_result_name: bool,
    requires_assistant_after_tool_result: bool,
    requires_thinking_as_text: bool,
    requires_reasoning_content_on_assistant_messages: bool,
    thinking_format: String,
    chat_template_kwargs: Map<String, Value>,
    chat_template_args: Map<String, Value>,
    zai_tool_stream: bool,
    supports_thinking_token_budget: bool,
    thinking_token_budget_field: Option<String>,
    supports_strict_mode: bool,
    supports_grammar_tools: bool,
    supports_mid_convo_system_messages: bool,
    supports_mid_convo_tool_additions: bool,
    cache_control_format: Option<String>,
    supports_long_cache_retention: bool,
    vllm_priority: Option<Value>,
}

/// The profile detected from the provider id and the base URL (`detectCompat`).
fn detect_compat(model: &Model) -> Compat {
    let provider = model.provider.as_str();
    let url = model.base_url.as_str();
    let zai = matches!(provider, "zai" | "zai-coding-cn")
        || url.contains("api.z.ai")
        || url.contains("open.bigmodel.cn");
    let together = provider == "together"
        || url.contains("api.together.ai")
        || url.contains("api.together.xyz");
    let moonshot =
        matches!(provider, "moonshotai" | "moonshotai-cn") || url.contains("api.moonshot.");
    let openrouter = provider == "openrouter" || url.contains("openrouter.ai");
    let cloudflare_workers =
        provider == "cloudflare-workers-ai" || url.contains("api.cloudflare.com");
    let cloudflare_gateway =
        provider == "cloudflare-ai-gateway" || url.contains("gateway.ai.cloudflare.com");
    let nvidia = provider == "nvidia" || url.contains("integrate.api.nvidia.com");
    let ant_ling = provider == "ant-ling" || url.contains("api.ant-ling.com");
    let cerebras = provider == "cerebras" || url.contains("cerebras.ai");
    let deepseek = provider == "deepseek" || url.to_lowercase().contains("deepseek.com");
    let grok = provider == "xai" || url.contains("api.x.ai");
    let chutes = url.contains("chutes.ai");
    let opencode = provider == "opencode" || url.contains("opencode.ai");
    let non_standard = nvidia
        || cerebras
        || grok
        || together
        || chutes
        || deepseek
        || zai
        || moonshot
        || opencode
        || cloudflare_workers
        || cloudflare_gateway
        || ant_ling;
    let max_tokens = chutes
        || deepseek
        || moonshot
        || cloudflare_gateway
        || together
        || nvidia
        || ant_ling
        || zai;
    let openrouter_developer_role =
        openrouter && (model.id.starts_with("anthropic/") || model.id.starts_with("openai/"));
    let thinking_format = if deepseek {
        "deepseek"
    } else if zai {
        "zai"
    } else if together {
        "together"
    } else if ant_ling {
        "ant-ling"
    } else if openrouter {
        "openrouter"
    } else {
        "openai"
    };
    Compat {
        supports_tools: None,
        supports_store: !non_standard,
        supports_developer_role: openrouter_developer_role || (!non_standard && !openrouter),
        supports_reasoning_effort: !grok
            && !zai
            && !moonshot
            && !together
            && !cloudflare_gateway
            && !nvidia
            && !ant_ling,
        supports_usage_in_streaming: true,
        max_tokens_field: if max_tokens {
            "max_tokens"
        } else {
            "max_completion_tokens"
        }
        .into(),
        requires_tool_result_name: false,
        requires_assistant_after_tool_result: false,
        requires_thinking_as_text: false,
        requires_reasoning_content_on_assistant_messages: deepseek,
        thinking_format: thinking_format.into(),
        chat_template_kwargs: Map::new(),
        chat_template_args: Map::new(),
        zai_tool_stream: false,
        supports_thinking_token_budget: false,
        thinking_token_budget_field: None,
        supports_strict_mode: false,
        supports_grammar_tools: false,
        supports_mid_convo_system_messages: false,
        supports_mid_convo_tool_additions: false,
        cache_control_format: (provider == "openrouter" && model.id.starts_with("anthropic/"))
            .then(|| "anthropic".to_string()),
        supports_long_cache_retention: !(together
            || cloudflare_workers
            || cloudflare_gateway
            || nvidia
            || ant_ling),
        vllm_priority: None,
    }
}

/// The detected profile with the model's own settings over it (`getCompat`).
fn compat(model: &Model) -> Compat {
    let detected = detect_compat(model);
    let Some(own) = &model.compat else {
        return detected;
    };
    Compat {
        supports_tools: own.supports_tools,
        supports_store: own.supports_store.unwrap_or(detected.supports_store),
        supports_developer_role: own
            .supports_developer_role
            .unwrap_or(detected.supports_developer_role),
        supports_reasoning_effort: own
            .supports_reasoning_effort
            .unwrap_or(detected.supports_reasoning_effort),
        supports_usage_in_streaming: own
            .supports_usage_in_streaming
            .unwrap_or(detected.supports_usage_in_streaming),
        max_tokens_field: own
            .max_tokens_field
            .clone()
            .unwrap_or(detected.max_tokens_field),
        requires_tool_result_name: own
            .requires_tool_result_name
            .unwrap_or(detected.requires_tool_result_name),
        requires_assistant_after_tool_result: own
            .requires_assistant_after_tool_result
            .unwrap_or(detected.requires_assistant_after_tool_result),
        requires_thinking_as_text: own
            .requires_thinking_as_text
            .unwrap_or(detected.requires_thinking_as_text),
        requires_reasoning_content_on_assistant_messages: own
            .requires_reasoning_content_on_assistant_messages
            .unwrap_or(detected.requires_reasoning_content_on_assistant_messages),
        thinking_format: own
            .thinking_format
            .clone()
            .unwrap_or(detected.thinking_format),
        chat_template_kwargs: own
            .chat_template_kwargs
            .clone()
            .unwrap_or(detected.chat_template_kwargs),
        chat_template_args: own
            .chat_template_args
            .clone()
            .unwrap_or(detected.chat_template_args),
        zai_tool_stream: own.zai_tool_stream.unwrap_or(detected.zai_tool_stream),
        supports_thinking_token_budget: own
            .supports_thinking_token_budget
            .unwrap_or(detected.supports_thinking_token_budget),
        thinking_token_budget_field: own
            .thinking_token_budget_field
            .clone()
            .or(detected.thinking_token_budget_field),
        supports_strict_mode: own
            .supports_strict_mode
            .unwrap_or(detected.supports_strict_mode),
        supports_grammar_tools: own
            .supports_openai_grammar_tools
            .unwrap_or(detected.supports_grammar_tools),
        supports_mid_convo_system_messages: own
            .supports_mid_convo_system_messages
            .unwrap_or(detected.supports_mid_convo_system_messages),
        supports_mid_convo_tool_additions: own
            .supports_mid_convo_tool_additions
            .unwrap_or(detected.supports_mid_convo_tool_additions),
        cache_control_format: own
            .cache_control_format
            .clone()
            .or(detected.cache_control_format),
        supports_long_cache_retention: own
            .supports_long_cache_retention
            .unwrap_or(detected.supports_long_cache_retention),
        vllm_priority: own.vllm_priority.clone(),
    }
}

/// `thinkingLevelMap[level] ?? level`: the mapped value unless absent or null.
fn mapped_or(model: &Model, level: &str) -> Value {
    match model.thinking_level(level) {
        Some(value) if !value.is_null() => value.clone(),
        _ => json!(level),
    }
}

/// The token budget for a thinking level: the request's budgets over the defaults, with
/// `xhigh` and `max` counted as `high` (`thinkingBudgetForLevel`).
fn thinking_budget_for_level(level: &str, custom: Option<&Map<String, Value>>) -> Option<i64> {
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

/// One chat template value: a literal, or a `$var` resolved from the request's effort.
fn chat_template_value(
    model: &Model,
    effort: Option<&str>,
    value: &Value,
    thinking_budget: Option<i64>,
) -> Option<Value> {
    let Value::Object(variable) = value else {
        return Some(value.clone());
    };
    if effort.is_none()
        && variable
            .get("omitWhenOff")
            .is_some_and(|omit| omit == &json!(true))
    {
        return None;
    }
    match variable.get("$var").and_then(Value::as_str) {
        Some("thinking.enabled") => Some(json!(effort.is_some())),
        Some("thinking.budget") => thinking_budget.map(|budget| json!(budget)),
        _ => {
            let mapped = model.thinking_level(effort.unwrap_or("off"));
            match mapped {
                None => effort.map(|effort| json!(effort)),
                Some(Value::String(mapped)) => Some(json!(mapped)),
                Some(_) => None,
            }
        }
    }
}

fn chat_template_values(
    model: &Model,
    effort: Option<&str>,
    values: &Map<String, Value>,
    thinking_budget: Option<i64>,
) -> Option<Value> {
    let mut resolved = Map::new();
    for (key, value) in values {
        if let Some(value) = chat_template_value(model, effort, value, thinking_budget) {
            resolved.insert(key.clone(), value);
        }
    }
    (!resolved.is_empty()).then_some(Value::Object(resolved))
}

fn convert_tools(tools: &[Tool], compat: &Compat) -> Result<Vec<Value>, String> {
    let mut converted = Vec::with_capacity(tools.len());
    for tool in tools {
        if let Some(grammar) =
            resolve_grammar_constrained_sampling(tool, compat.supports_grammar_tools)?
        {
            converted.push(json!({
                "type": "custom",
                "custom": {
                    "name": tool.name,
                    "description": tool.description,
                    "format": {
                        "type": "grammar",
                        "grammar": { "syntax": grammar.syntax, "definition": grammar.definition },
                    },
                },
            }));
            continue;
        }
        let strict = resolve_json_schema_strict_sampling(tool, compat.supports_strict_mode, None)?;
        let mut function = Map::new();
        function.insert("name".into(), json!(tool.name));
        function.insert("description".into(), json!(tool.description));
        function.insert(
            "parameters".into(),
            json_schema_tool_parameters(tool, strict),
        );
        if compat.supports_strict_mode {
            function.insert("strict".into(), json!(strict));
        }
        converted.push(json!({ "type": "function", "function": function }));
    }
    Ok(converted)
}

fn image_part(mime_type: &str, data: &str) -> Value {
    json!({ "type": "image_url", "image_url": { "url": format!("data:{mime_type};base64,{data}") } })
}

/// A reasoning detail replayed to the server: a summary, encrypted data or text, with optional
/// id, format and index fields of the right types.
fn is_reasoning_detail(detail: &Value) -> bool {
    let Value::Object(detail) = detail else {
        return false;
    };
    let common = detail
        .get("id")
        .is_none_or(|id| id.is_null() || id.is_string())
        && detail.get("format").is_none_or(Value::is_string)
        && detail.get("index").is_none_or(Value::is_number);
    if !common {
        return false;
    }
    match detail.get("type").and_then(Value::as_str) {
        Some("reasoning.summary") => detail.get("summary").is_some_and(Value::is_string),
        Some("reasoning.encrypted") => detail.get("data").is_some_and(Value::is_string),
        Some("reasoning.text") => {
            detail.get("text").is_some_and(Value::is_string)
                && detail
                    .get("signature")
                    .is_none_or(|signature| signature.is_null() || signature.is_string())
        }
        _ => false,
    }
}

/// A thinking signature holding a list of reasoning details.
fn reasoning_details(signature: Option<&str>) -> Option<Vec<Value>> {
    let parsed: Value = serde_json::from_str(signature.filter(|s| !s.is_empty())?).ok()?;
    let details = parsed.as_array()?;
    (!details.is_empty() && details.iter().all(is_reasoning_detail)).then(|| details.clone())
}

/// An older form: one encrypted reasoning detail in a tool call's thought signature.
fn legacy_encrypted_detail(signature: Option<&str>) -> Option<Value> {
    let parsed: Value = serde_json::from_str(signature.filter(|s| !s.is_empty())?).ok()?;
    let encrypted = is_reasoning_detail(&parsed)
        && parsed.get("type") == Some(&json!("reasoning.encrypted"))
        && parsed
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        && parsed
            .get("data")
            .and_then(Value::as_str)
            .is_some_and(|data| !data.is_empty());
    encrypted.then_some(parsed)
}

/// The first `units` UTF-16 code units, never splitting a character.
fn take_utf16(text: &str, units: usize) -> String {
    let mut taken = String::new();
    let mut count = 0;
    for character in text.chars() {
        count += character.len_utf16();
        if count > units {
            break;
        }
        taken.push(character);
    }
    taken
}

/// A tool call id for Chat Completions: a Responses `call_id|item_id` becomes one id of at
/// most 40 characters, and OpenAI's own ids are cut to 40.
fn normalize_tool_call_id(model: &Model, id: &str) -> String {
    if let Some(separator) = id.find('|') {
        let call_id = replace_non_id_characters(&id[..separator]);
        let item_id = replace_non_id_characters(&id[separator + 1..]);
        let combined = if item_id.is_empty() {
            call_id.clone()
        } else {
            format!("{call_id}_{item_id}")
        };
        if combined.len() <= 40 {
            return combined;
        }
        let hash: String = short_hash(id).chars().take(8).collect();
        let prefix: String = call_id.chars().take((40 - hash.len() - 1).max(1)).collect();
        return format!("{prefix}_{hash}");
    }
    if model.provider == "openai" && js_length(id) > 40 {
        return take_utf16(id, 40);
    }
    id.to_string()
}

fn has_tool_history(messages: &[Message]) -> bool {
    messages.iter().any(|message| match message {
        Message::ToolResult(_) => true,
        Message::Assistant(assistant) => assistant
            .content
            .iter()
            .any(|block| matches!(block, OutputBlock::ToolCall(_))),
        _ => false,
    })
}

fn convert_messages(
    model: &Model,
    messages: &[Message],
    compat: &Compat,
    grammar_properties: &[(String, String)],
) -> Result<Vec<Value>, String> {
    let messages = resolve_transcript(messages, compat.supports_mid_convo_system_messages);
    let normalize = |id: &str, _: &crate::AssistantMessage| normalize_tool_call_id(model, id);
    let transformed = transform_messages(&messages, model, Some(&normalize));
    let (_, anchors_additions) = resolve_transcript_tools(
        &messages,
        compat.supports_mid_convo_system_messages && compat.supports_mid_convo_tool_additions,
    );
    let instruction_role = if model.reasoning && compat.supports_developer_role {
        "developer"
    } else {
        "system"
    };
    let grammar_property = |name: &str| {
        grammar_properties
            .iter()
            .find(|(tool, _)| tool == name)
            .map(|(_, property)| property.as_str())
    };

    let mut params: Vec<Value> = Vec::new();
    let mut last_role: Option<&'static str> = None;
    let mut index = 0;
    while index < transformed.len() {
        let message = &transformed[index];
        // Some servers want an assistant message between tool results and a user message.
        if compat.requires_assistant_after_tool_result
            && last_role == Some("toolResult")
            && matches!(message, Message::User(_))
        {
            params.push(json!({ "role": "assistant", "content": TOOL_RESULT_BRIDGE }));
        }
        match message {
            Message::System(system) => {
                let added = if index > 0 && anchors_additions {
                    system.tools_added.clone().unwrap_or_default()
                } else {
                    Vec::new()
                };
                if !added.is_empty() {
                    params
                        .push(json!({ "role": "system", "tools": convert_tools(&added, compat)? }));
                }
                let text = if index == 0 {
                    system_message_text(system)
                } else {
                    render_system_message_update(system)
                };
                if !text.is_empty() {
                    params.push(json!({ "role": instruction_role, "content": text }));
                }
                last_role = Some("system");
            }
            Message::User(user) => {
                match &user.content {
                    Content::Text(text) => params.push(json!({ "role": "user", "content": text })),
                    Content::Blocks(blocks) => {
                        let content: Vec<Value> = blocks
                            .iter()
                            .filter(|block| !matches!(block, InputBlock::Text(text) if text.text.is_empty()))
                            .map(|block| match block {
                                InputBlock::Text(text) => json!({ "type": "text", "text": text.text }),
                                InputBlock::Image(image) => image_part(&image.mime_type, &image.data),
                            })
                            .collect();
                        if content.is_empty() {
                            index += 1;
                            continue;
                        }
                        params.push(json!({ "role": "user", "content": content }));
                    }
                }
                last_role = Some("user");
            }
            Message::Assistant(assistant) => {
                let mut item = Map::new();
                item.insert("role".into(), json!("assistant"));
                item.insert(
                    "content".into(),
                    if compat.requires_assistant_after_tool_result {
                        json!("")
                    } else {
                        Value::Null
                    },
                );
                let text_parts: Vec<&str> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        OutputBlock::Text(text) if !is_blank(&text.text) => {
                            Some(text.text.as_str())
                        }
                        _ => None,
                    })
                    .collect();
                let text = text_parts.concat();
                let thinking: Vec<&crate::ThinkingContent> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        OutputBlock::Thinking(thinking) => Some(thinking),
                        _ => None,
                    })
                    .collect();
                let calls: Vec<&crate::ToolCall> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        OutputBlock::ToolCall(call) => Some(call),
                        _ => None,
                    })
                    .collect();
                let signed_details = thinking
                    .iter()
                    .find_map(|block| reasoning_details(block.thinking_signature.as_deref()));
                let legacy_details: Vec<Value> = calls
                    .iter()
                    .filter_map(|call| legacy_encrypted_detail(call.thought_signature.as_deref()))
                    .collect();
                let preserved =
                    signed_details.or((!legacy_details.is_empty()).then_some(legacy_details));

                let thought: Vec<&&crate::ThinkingContent> = thinking
                    .iter()
                    .filter(|block| !is_blank(&block.thinking))
                    .collect();
                if !thought.is_empty() {
                    if compat.requires_thinking_as_text {
                        let thinking_text = thought
                            .iter()
                            .map(|block| block.thinking.as_str())
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        let mut parts = vec![json!({ "type": "text", "text": thinking_text })];
                        parts.extend(
                            text_parts
                                .iter()
                                .map(|part| json!({ "type": "text", "text": part })),
                        );
                        item.insert("content".into(), Value::Array(parts));
                    } else {
                        if !text.is_empty() {
                            item.insert("content".into(), json!(text));
                        }
                        // Reasoning details replace the raw reasoning field.
                        if preserved.is_none() {
                            let mut signature =
                                thought[0].thinking_signature.clone().unwrap_or_default();
                            if model.provider == "opencode-go" && signature == "reasoning" {
                                signature = "reasoning_content".into();
                            }
                            if REASONING_FIELDS.contains(&signature.as_str()) {
                                let joined = thought
                                    .iter()
                                    .map(|block| block.thinking.as_str())
                                    .collect::<Vec<_>>()
                                    .join("\n");
                                item.insert(signature, json!(joined));
                            }
                        }
                    }
                } else if !text.is_empty() {
                    item.insert("content".into(), json!(text));
                }
                if !calls.is_empty() {
                    let mut tool_calls = Vec::with_capacity(calls.len());
                    for call in &calls {
                        tool_calls.push(match grammar_property(&call.name) {
                            Some(property) => json!({
                                "id": call.id,
                                "type": "custom",
                                "custom": {
                                    "name": call.name,
                                    "input": grammar_tool_input(&call.name, &call.arguments, property)?,
                                },
                            }),
                            None => json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": serde_json::to_string(&call.arguments).unwrap_or_default(),
                                },
                            }),
                        });
                    }
                    item.insert("tool_calls".into(), Value::Array(tool_calls));
                }
                if let Some(details) = preserved {
                    item.insert("reasoning_details".into(), Value::Array(details));
                }
                if compat.requires_reasoning_content_on_assistant_messages
                    && model.reasoning
                    && !item.contains_key("reasoning_content")
                {
                    item.insert("reasoning_content".into(), json!(""));
                }
                // Servers reject an assistant message with neither content nor tool calls.
                let has_content = match &item["content"] {
                    Value::String(text) => !text.is_empty(),
                    Value::Array(parts) => !parts.is_empty(),
                    _ => false,
                };
                if !has_content && !item.contains_key("tool_calls") {
                    index += 1;
                    continue;
                }
                params.push(Value::Object(item));
                last_role = Some("assistant");
            }
            Message::ToolResult(_) => {
                let mut images = Vec::new();
                while let Some(Message::ToolResult(result)) = transformed.get(index) {
                    let text = result
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            InputBlock::Text(text) => Some(text.text.as_str()),
                            InputBlock::Image(_) => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    let has_images = result
                        .content
                        .iter()
                        .any(|block| matches!(block, InputBlock::Image(_)));
                    let content = if !text.is_empty() {
                        text
                    } else if has_images {
                        "(see attached image)".into()
                    } else {
                        "(no tool output)".into()
                    };
                    let mut tool_message = Map::new();
                    tool_message.insert("role".into(), json!("tool"));
                    tool_message.insert("content".into(), json!(content));
                    tool_message.insert("tool_call_id".into(), json!(result.tool_call_id));
                    if compat.requires_tool_result_name && !result.tool_name.is_empty() {
                        tool_message.insert("name".into(), json!(result.tool_name));
                    }
                    params.push(Value::Object(tool_message));
                    if has_images && model.accepts_images() {
                        for block in &result.content {
                            if let InputBlock::Image(image) = block {
                                images.push(image_part(&image.mime_type, &image.data));
                            }
                        }
                    }
                    index += 1;
                }
                if images.is_empty() {
                    last_role = Some("toolResult");
                } else {
                    // Tool messages carry no images, so they follow as a user message.
                    if compat.requires_assistant_after_tool_result {
                        params.push(json!({ "role": "assistant", "content": TOOL_RESULT_BRIDGE }));
                    }
                    let mut content = vec![
                        json!({ "type": "text", "text": "Attached image(s) from tool result:" }),
                    ];
                    content.extend(images);
                    params.push(json!({ "role": "user", "content": content }));
                    last_role = Some("user");
                }
                continue;
            }
        }
        index += 1;
    }
    Ok(params)
}

/// Put the cache marker on the last text part of a message, turning string content into a part.
fn mark_text_content(message: &mut Value, cache_control: &Value) -> bool {
    let Some(content) = message.get_mut("content") else {
        return false;
    };
    match content {
        Value::String(text) => {
            if text.is_empty() {
                return false;
            }
            *content =
                json!([{ "type": "text", "text": text.clone(), "cache_control": cache_control }]);
            true
        }
        Value::Array(parts) => {
            for part in parts.iter_mut().rev() {
                if part.get("type") == Some(&json!("text")) {
                    if let Value::Object(part) = part {
                        part.insert("cache_control".into(), cache_control.clone());
                    }
                    return true;
                }
            }
            false
        }
        _ => false,
    }
}

/// Anthropic-style cache markers: on the instructions, the last tool and the last message that
/// can carry one.
fn apply_cache_control(
    messages: &mut [Value],
    tools: Option<&mut Vec<Value>>,
    cache_control: &Value,
) {
    let role = |message: &Value| {
        message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    if let Some(instructions) = messages
        .iter_mut()
        .find(|message| matches!(role(message).as_str(), "system" | "developer"))
    {
        mark_text_content(instructions, cache_control);
    }
    if let Some(Value::Object(last)) = tools.and_then(|tools| tools.last_mut()) {
        last.insert("cache_control".into(), cache_control.clone());
    }
    for message in messages.iter_mut().rev() {
        if matches!(role(message).as_str(), "user" | "assistant" | "tool")
            && mark_text_content(message, cache_control)
        {
            return;
        }
    }
}

/// The body for `messages` (a transcript whose system messages carry the prompt and tools).
/// Fails where the TypeScript adapter throws: a tool whose constrained sampling cannot be
/// honored, or a grammar call without its string input.
pub fn build_request(
    model: &Model,
    messages: &[Message],
    options: &OpenAICompletionsOptions,
) -> Result<Value, String> {
    let compat = compat(model);
    let messages = resolve_transcript(messages, compat.supports_mid_convo_system_messages);
    let grammar_properties =
        grammar_tool_input_properties(&declared_tools(&messages), compat.supports_grammar_tools)?;
    let retention = resolve_cache_retention(options.cache_retention, options.env.as_ref());
    let (request_tools, _) = resolve_transcript_tools(
        &messages,
        compat.supports_mid_convo_system_messages && compat.supports_mid_convo_tool_additions,
    );
    let mut wire_messages = convert_messages(model, &messages, &compat, &grammar_properties)?;
    let cache_control = (compat.cache_control_format.as_deref() == Some("anthropic")
        && retention != CacheRetention::None)
        .then(|| {
            if retention == CacheRetention::Long && compat.supports_long_cache_retention {
                json!({ "type": "ephemeral", "ttl": "1h" })
            } else {
                json!({ "type": "ephemeral" })
            }
        });
    let long = retention == CacheRetention::Long && compat.supports_long_cache_retention;

    let mut tools: Option<Vec<Value>> = None;
    let mut tool_stream = false;
    if compat.supports_tools != Some(false) {
        if !request_tools.is_empty() {
            tools = Some(convert_tools(&request_tools, &compat)?);
            tool_stream = compat.zai_tool_stream;
        } else if has_tool_history(&messages) {
            // Anthropic behind a proxy wants the tool field whenever the history has tool calls.
            tools = Some(Vec::new());
        }
    }
    if let Some(cache_control) = &cache_control {
        apply_cache_control(&mut wire_messages, tools.as_mut(), cache_control);
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(model.id));
    body.insert("messages".into(), Value::Array(wire_messages));
    body.insert("stream".into(), json!(true));
    let cache_key_wanted =
        (model.base_url.contains("api.openai.com") && retention != CacheRetention::None) || long;
    if let Some(session_id) = options.session_id.as_ref().filter(|_| cache_key_wanted) {
        let key: String = session_id
            .chars()
            .take(PROMPT_CACHE_KEY_MAX_LENGTH)
            .collect();
        body.insert("prompt_cache_key".into(), json!(key));
    }
    if long {
        body.insert("prompt_cache_retention".into(), json!("24h"));
    }
    if compat.supports_usage_in_streaming {
        body.insert("stream_options".into(), json!({ "include_usage": true }));
    }
    if compat.supports_store {
        body.insert("store".into(), json!(false));
    }
    if let Some(max_tokens) = options.max_tokens.filter(|tokens| *tokens > 0) {
        let field = if compat.max_tokens_field == "max_tokens" {
            "max_tokens"
        } else {
            "max_completion_tokens"
        };
        body.insert(field.into(), json!(max_tokens));
    }
    if let Some(temperature) = options.temperature {
        body.insert("temperature".into(), json!(temperature));
    }
    if let Some(tools) = tools {
        body.insert("tools".into(), Value::Array(tools));
        if tool_stream {
            body.insert("tool_stream".into(), json!(true));
        }
    }
    if let Some(choice) = options
        .tool_choice
        .as_ref()
        .filter(|choice| is_truthy(choice))
    {
        body.insert("tool_choice".into(), choice.clone());
    }
    if let Some(priority) = &compat.vllm_priority {
        body.insert("priority".into(), priority.clone());
    }

    let effort = options
        .reasoning_effort
        .as_deref()
        .filter(|effort| !effort.is_empty());
    let budget_field = compat.thinking_token_budget_field.clone().or_else(|| {
        compat
            .supports_thinking_token_budget
            .then(|| "thinking_token_budget".to_string())
    });
    let thinking_budget = match effort.filter(|_| model.reasoning) {
        Some(effort) => {
            let ceiling = body
                .get("max_tokens")
                .or_else(|| body.get("max_completion_tokens"))
                .and_then(Value::as_i64)
                .unwrap_or(model.max_tokens as i64);
            thinking_budget_for_level(effort, options.thinking_budgets.as_ref())
                .map(|budget| budget.min((ceiling - MIN_ANSWER_TOKENS).max(0)))
                .filter(|budget| *budget > 0)
        }
        None => None,
    };
    apply_thinking(model, &compat, effort, thinking_budget, &mut body);
    if let (Some(field), Some(budget)) = (budget_field, thinking_budget) {
        body.insert(field, json!(budget));
    }

    if let Some(routing) = model
        .compat
        .as_ref()
        .and_then(|own| own.open_router_routing.as_ref())
        .filter(|routing| is_truthy(routing))
    {
        body.insert("provider".into(), routing.clone());
    }
    if let Some(routing) = model
        .compat
        .as_ref()
        .and_then(|own| own.vercel_gateway_routing.as_ref())
        .filter(|routing| is_truthy(routing))
    {
        let only = routing.get("only").filter(|only| is_truthy(only));
        let order = routing.get("order").filter(|order| is_truthy(order));
        if only.is_some() || order.is_some() {
            let mut gateway = Map::new();
            if let Some(only) = only {
                gateway.insert("only".into(), only.clone());
            }
            if let Some(order) = order {
                gateway.insert("order".into(), order.clone());
            }
            body.insert("providerOptions".into(), json!({ "gateway": gateway }));
        }
    }

    // Last, so sampling parameters override the named fields.
    if let Some(sampling) =
        model.sampling_params(effort.unwrap_or("off"), options.sampling_params.as_ref())
    {
        for (key, value) in sampling {
            body.insert(key, value);
        }
    }
    Ok(Value::Object(body))
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The reasoning settings, in the form the server's thinking format takes.
fn apply_thinking(
    model: &Model,
    compat: &Compat,
    effort: Option<&str>,
    thinking_budget: Option<i64>,
    body: &mut Map<String, Value>,
) {
    let reasoning = model.reasoning;
    let supports_effort = compat.supports_reasoning_effort;
    let off = model.thinking_level("off");
    let off_allowed = off != Some(&Value::Null);
    let mut insert = |key: &str, value: Value| {
        body.insert(key.to_string(), value);
    };
    match compat.thinking_format.as_str() {
        "zai" if reasoning => {
            insert(
                "thinking",
                if effort.is_some() {
                    json!({ "type": "enabled", "clear_thinking": false })
                } else {
                    json!({ "type": "disabled" })
                },
            );
            if let Some(effort) = effort.filter(|_| supports_effort) {
                let value = model
                    .thinking_level(effort)
                    .cloned()
                    .unwrap_or_else(|| json!(effort));
                if value.is_string() {
                    insert("reasoning_effort", value);
                }
            }
        }
        "qwen" if reasoning => {
            insert("enable_thinking", json!(effort.is_some()));
            if let Some(effort) = effort.filter(|_| supports_effort) {
                let value = mapped_or(model, effort);
                if value.is_string() {
                    insert("reasoning_effort", value);
                }
            }
        }
        "qwen-chat-template" if reasoning => {
            insert(
                "chat_template_kwargs",
                json!({ "enable_thinking": effort.is_some(), "preserve_thinking": true }),
            );
        }
        "chat-template" if reasoning => {
            if let Some(values) =
                chat_template_values(model, effort, &compat.chat_template_kwargs, thinking_budget)
            {
                insert("chat_template_kwargs", values);
            }
        }
        "baseten" if reasoning => {
            if let Some(values) =
                chat_template_values(model, effort, &compat.chat_template_args, thinking_budget)
            {
                insert("chat_template_args", values);
            }
            if supports_effort {
                let mapped = model.thinking_level(effort.unwrap_or("off"));
                let value = match mapped {
                    None => effort.map(|effort| json!(effort)),
                    Some(mapped) => Some(mapped.clone()),
                };
                if let Some(value) = value.filter(Value::is_string) {
                    insert("reasoning_effort", value);
                }
            }
        }
        "deepseek" if reasoning => {
            if effort.is_some() {
                insert("thinking", json!({ "type": "enabled" }));
            } else if off_allowed {
                insert("thinking", json!({ "type": "disabled" }));
            }
            if let Some(effort) = effort.filter(|_| supports_effort) {
                insert("reasoning_effort", mapped_or(model, effort));
            }
        }
        "openrouter" if reasoning => {
            if let Some(effort) = effort {
                insert("reasoning", json!({ "effort": mapped_or(model, effort) }));
            } else if off_allowed {
                insert(
                    "reasoning",
                    json!({ "effort": off.cloned().unwrap_or_else(|| json!("none")) }),
                );
            }
        }
        "ant-ling" if reasoning && effort.is_some() => {
            if let Some(Value::String(mapped)) = model.thinking_level(effort.unwrap_or_default()) {
                insert("reasoning", json!({ "effort": mapped }));
            }
        }
        "together" if reasoning => {
            insert("reasoning", json!({ "enabled": effort.is_some() }));
            if let Some(effort) = effort.filter(|_| supports_effort) {
                insert("reasoning_effort", mapped_or(model, effort));
            }
        }
        "string-thinking" if reasoning => {
            if let Some(effort) = effort {
                insert("thinking", mapped_or(model, effort));
            } else if off_allowed {
                insert("thinking", off.cloned().unwrap_or_else(|| json!("none")));
            }
        }
        _ => match effort {
            Some(effort) if reasoning && supports_effort => {
                insert("reasoning_effort", mapped_or(model, effort))
            }
            None if reasoning && supports_effort => {
                if let Some(off) = off.filter(|off| off.is_string()) {
                    insert("reasoning_effort", off.clone());
                }
            }
            _ => {}
        },
    }
}
