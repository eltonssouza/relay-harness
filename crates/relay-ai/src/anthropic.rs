//! The Anthropic Messages request body, as `buildParams` in
//! `packages/ai/src/api/anthropic-messages.ts` builds it.
//!
//! `build_request` returns the JSON the TypeScript adapter hands to the SDK, key order included
//! (`tests/anthropic.rs` compares the two byte for byte). Sending it, the SDK's split of `betas`
//! into a header, and reading the stream come next.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::message::{AssistantMessage, InputBlock, Message, OutputBlock, Tool, ToolResultMessage};
use crate::model::Model;
use crate::options::resolve_cache_retention;
pub use crate::options::CacheRetention;
use crate::strict::{json_schema_tool_parameters, resolve_json_schema_strict_sampling};
use crate::text::{is_blank, js_trim, normalize_tool_call_id};
use crate::transcript::{
    current_tools, initial_system_message, render_system_message_update, resolve_transcript,
    system_message_text,
};
use crate::transform::transform_messages;
use crate::Content;

const FINE_GRAINED_TOOL_STREAMING_BETA: &str = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA: &str = "interleaved-thinking-2025-05-14";
const SERVER_SIDE_FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MID_CONVERSATION_OUTPUT_CONFIG_BETA: &str = "mid-conversation-output-config-2026-07-01";
const THINKING_BINDING_CONTROLS_BETA: &str = "thinking-binding-controls-2026-08-01";
const INLINE_TOOLS_BETA: &str = "inline-tools-2026-09-15";
const CLAUDE_CODE_IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

/// Claude Code's tool names; an OAuth request names matching tools the same way.
const CLAUDE_CODE_TOOLS: [&str; 17] = [
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Grep",
    "Glob",
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
    "KillShell",
    "NotebookEdit",
    "Skill",
    "Task",
    "TaskOutput",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
];

/// Keywords Anthropic's strict tool use rejects for the whole request.
const STRICT_UNSUPPORTED_KEYWORDS: [&str; 11] = [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "maxItems",
    "uniqueItems",
    "minContains",
    "maxContains",
    "minProperties",
    "maxProperties",
];
const STRICT_STRING_FORMATS: [&str; 10] = [
    "date-time",
    "time",
    "date",
    "duration",
    "email",
    "hostname",
    "uri",
    "ipv4",
    "ipv6",
    "uuid",
];

/// The options of `AnthropicOptions` that shape the body.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicOptions {
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub cache_retention: Option<CacheRetention>,
    /// Provider environment, read before the process environment.
    pub env: Option<HashMap<String, String>>,
    pub headers: Option<Map<String, Value>>,
    pub metadata: Option<Map<String, Value>>,
    pub thinking_enabled: Option<bool>,
    pub thinking_budget_tokens: Option<u64>,
    pub effort: Option<String>,
    pub thinking_display: Option<String>,
    pub interleaved_thinking: Option<bool>,
    /// `"auto"`, `"any"`, `"none"` or `{ "type": "tool", "name": ... }`.
    pub tool_choice: Option<Value>,
}

/// The defaults the adapter applies to a model's compatibility switches.
struct Compat {
    eager_tool_input_streaming: bool,
    long_cache_retention: bool,
    cache_control_on_tools: bool,
    temperature: bool,
    allow_empty_signature: bool,
    strict_tools: bool,
    mid_convo_system_messages: bool,
    mid_convo_tool_changes: bool,
    mid_convo_effort: bool,
    force_adaptive_thinking: bool,
    fallback_models: Vec<String>,
}

fn compat(model: &Model) -> Compat {
    let compat = model.compat();
    Compat {
        eager_tool_input_streaming: compat.supports_eager_tool_input_streaming.unwrap_or(true),
        long_cache_retention: compat.supports_long_cache_retention.unwrap_or(true),
        cache_control_on_tools: compat.supports_cache_control_on_tools.unwrap_or(true),
        temperature: compat.supports_temperature.unwrap_or(true),
        allow_empty_signature: compat.allow_empty_signature.unwrap_or(false),
        strict_tools: compat.supports_strict_tools.unwrap_or(false),
        mid_convo_system_messages: compat.supports_mid_convo_system_messages.unwrap_or(false),
        mid_convo_tool_changes: compat.supports_mid_convo_tool_changes.unwrap_or(false),
        mid_convo_effort: compat.supports_mid_convo_effort == Some(true),
        force_adaptive_thinking: compat.force_adaptive_thinking == Some(true),
        fallback_models: compat
            .allowed_fallback_models
            .unwrap_or_default()
            .into_iter()
            .map(|fallback| fallback.model)
            .collect(),
    }
}

/// Whether an API key is a Claude subscription's OAuth token.
pub fn is_oauth_token(api_key: &str) -> bool {
    api_key.contains("sk-ant-oat")
}

/// Whether a request with this key takes the OAuth form. GitHub Copilot sends every key as a
/// bearer token without it.
pub fn uses_oauth(model: &Model, api_key: &str) -> bool {
    model.provider != "github-copilot" && is_oauth_token(api_key)
}

fn cache_control(compat: &Compat, options: &AnthropicOptions) -> Option<Value> {
    match resolve_cache_retention(options.cache_retention, options.env.as_ref()) {
        CacheRetention::None => None,
        retention => {
            let mut control = Map::new();
            control.insert("type".into(), json!("ephemeral"));
            if retention == CacheRetention::Long && compat.long_cache_retention {
                control.insert("ttl".into(), json!("1h"));
            }
            Some(Value::Object(control))
        }
    }
}

fn claude_code_name(name: &str) -> String {
    CLAUDE_CODE_TOOLS
        .iter()
        .find(|tool| tool.to_lowercase() == name.to_lowercase())
        .map_or_else(|| name.to_string(), |tool| tool.to_string())
}

fn tool_name(name: &str, oauth: bool) -> String {
    if oauth {
        claude_code_name(name)
    } else {
        name.to_string()
    }
}

fn strict_unsupported(key: &str, value: &Value) -> bool {
    if STRICT_UNSUPPORTED_KEYWORDS.contains(&key) {
        return true;
    }
    if key == "minItems" {
        return value != &json!(0) && value != &json!(1);
    }
    if key == "format" {
        return !value
            .as_str()
            .is_some_and(|format| STRICT_STRING_FORMATS.contains(&format));
    }
    false
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn convert_tools(
    tools: &[Tool],
    oauth: bool,
    compat: &Compat,
    cache_control: Option<&Value>,
) -> Result<Vec<Value>, String> {
    let mut converted = Vec::with_capacity(tools.len());
    for (index, tool) in tools.iter().enumerate() {
        let strict = resolve_json_schema_strict_sampling(
            tool,
            compat.strict_tools,
            Some(strict_unsupported),
        )?;
        let parameters = json_schema_tool_parameters(tool, strict);
        let legacy = [
            ("type", json!("object")),
            (
                "properties",
                parameters.get("properties").cloned().unwrap_or(json!({})),
            ),
            (
                "required",
                parameters.get("required").cloned().unwrap_or(json!([])),
            ),
        ];
        let input_schema = if strict {
            let mut schema = parameters.as_object().cloned().unwrap_or_default();
            for (key, value) in legacy {
                schema.insert(key.to_string(), value);
            }
            Value::Object(schema)
        } else {
            object(legacy.to_vec())
        };
        let mut definition = Map::new();
        definition.insert("name".into(), json!(tool_name(&tool.name, oauth)));
        definition.insert("description".into(), json!(tool.description));
        if compat.eager_tool_input_streaming {
            definition.insert("eager_input_streaming".into(), json!(true));
        }
        if strict {
            definition.insert("strict".into(), json!(true));
        }
        definition.insert("input_schema".into(), input_schema);
        if let Some(control) = cache_control.filter(|_| index == tools.len() - 1) {
            definition.insert("cache_control".into(), control.clone());
        }
        converted.push(Value::Object(definition));
    }
    Ok(converted)
}

fn image(media_type: &str, data: &str) -> Value {
    json!({
        "type": "image",
        "source": { "type": "base64", "media_type": media_type, "data": data },
    })
}

/// A tool result's content: one string when it is all text, blocks when it has images.
fn tool_result_content(content: &[&InputBlock]) -> Value {
    if !content
        .iter()
        .any(|block| matches!(block, InputBlock::Image(_)))
    {
        let texts: Vec<&str> = content
            .iter()
            .filter_map(|block| match block {
                InputBlock::Text(text) => Some(text.text.as_str()),
                InputBlock::Image(_) => None,
            })
            .collect();
        return json!(texts.join("\n"));
    }
    let mut blocks: Vec<Value> = content
        .iter()
        .map(|block| match block {
            InputBlock::Text(text) => json!({ "type": "text", "text": text.text }),
            InputBlock::Image(image_block) => image(&image_block.mime_type, &image_block.data),
        })
        .collect();
    if !content
        .iter()
        .any(|block| matches!(block, InputBlock::Text(_)))
    {
        blocks.insert(0, json!({ "type": "text", "text": "(see attached image)" }));
    }
    Value::Array(blocks)
}

fn tool_result(result: &ToolResultMessage) -> Value {
    let content: Vec<&InputBlock> = result
        .content
        .iter()
        .filter(|block| !matches!(block, InputBlock::Text(text) if text.volatile == Some(true)))
        .collect();
    json!({
        "type": "tool_result",
        "tool_use_id": result.tool_call_id,
        "content": tool_result_content(&content),
        "is_error": result.is_error,
    })
}

/// A converted message, and which of its blocks are volatile text.
struct Converted {
    message: Value,
    volatile: Vec<bool>,
}

struct ConvertedMessages {
    messages: Vec<Converted>,
    /// Effort of earlier responses, by message index, for managed-effort models.
    assistant_levels: HashMap<usize, String>,
}

fn is_effort(level: &str) -> bool {
    matches!(level, "low" | "medium" | "high" | "xhigh" | "max")
}

fn convert_messages(
    messages: &[Message],
    oauth: bool,
    cache_control: Option<&Value>,
    compat: &Compat,
    managed_provider: Option<&str>,
    native_tool_changes: bool,
) -> Result<ConvertedMessages, String> {
    let mut converted: Vec<Converted> = Vec::new();
    let mut assistant_levels = HashMap::new();
    // Later system messages wait for the next assistant message: a tool result must follow its
    // tool use directly.
    let mut pending_system: Vec<Converted> = Vec::new();
    let mut index = 0;
    while index < messages.len() {
        match &messages[index] {
            Message::System(system) => {
                let text = render_system_message_update(system);
                let mut blocks = Vec::new();
                if !text.is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                if native_tool_changes {
                    let added = system.tools_added.clone().unwrap_or_default();
                    for removed in system.tools_removed.iter().flatten() {
                        // A new definition under the same name replaces the old one.
                        if added.iter().any(|tool| tool.name == removed.name) {
                            continue;
                        }
                        blocks.push(json!({
                            "type": "tool_removal",
                            "tool": { "type": "tool_reference", "name": tool_name(&removed.name, oauth) },
                        }));
                    }
                    for definition in convert_tools(&added, oauth, compat, None)? {
                        blocks.push(json!({
                            "type": "tool_addition",
                            "tool": { "type": "tool_definition", "definition": definition },
                        }));
                    }
                }
                if !blocks.is_empty() {
                    let volatile = vec![false; blocks.len()];
                    pending_system.push(Converted {
                        message: json!({ "role": "system", "content": blocks }),
                        volatile,
                    });
                }
            }
            Message::User(user) => match &user.content {
                Content::Text(text) => {
                    if !is_blank(text) {
                        converted.push(Converted {
                            message: json!({ "role": "user", "content": text }),
                            volatile: Vec::new(),
                        });
                    }
                }
                Content::Blocks(content) => {
                    let mut blocks = Vec::new();
                    let mut volatile = Vec::new();
                    for block in content {
                        match block {
                            InputBlock::Text(text) => {
                                if is_blank(&text.text) {
                                    continue;
                                }
                                blocks.push(json!({ "type": "text", "text": text.text }));
                                volatile.push(text.volatile == Some(true));
                            }
                            InputBlock::Image(image_block) => {
                                blocks.push(image(&image_block.mime_type, &image_block.data));
                                volatile.push(false);
                            }
                        }
                    }
                    if !blocks.is_empty() {
                        converted.push(Converted {
                            message: json!({ "role": "user", "content": blocks }),
                            volatile,
                        });
                    }
                }
            },
            Message::Assistant(assistant) => {
                converted.append(&mut pending_system);
                let mut blocks = Vec::new();
                for block in &assistant.content {
                    match block {
                        OutputBlock::Text(text) => {
                            if !is_blank(&text.text) {
                                blocks.push(json!({ "type": "text", "text": text.text }));
                            }
                        }
                        OutputBlock::Thinking(thinking) => {
                            if thinking.redacted == Some(true) {
                                // The opaque payload goes back as it came.
                                let mut block = Map::new();
                                block.insert("type".into(), json!("redacted_thinking"));
                                if let Some(data) = &thinking.thinking_signature {
                                    block.insert("data".into(), json!(data));
                                }
                                blocks.push(Value::Object(block));
                                continue;
                            }
                            let signature = thinking.thinking_signature.clone().unwrap_or_default();
                            let signed = !is_blank(&signature);
                            if is_blank(&thinking.thinking) && !signed {
                                continue;
                            }
                            // An unsigned thinking block, such as one from an aborted stream, is
                            // sent as text unless the provider accepts an empty signature.
                            blocks.push(if signed {
                                json!({ "type": "thinking", "thinking": thinking.thinking, "signature": signature })
                            } else if compat.allow_empty_signature {
                                json!({ "type": "thinking", "thinking": thinking.thinking, "signature": "" })
                            } else {
                                json!({ "type": "text", "text": thinking.thinking })
                            });
                        }
                        OutputBlock::ToolCall(call) => {
                            blocks.push(json!({
                                "type": "tool_use",
                                "id": call.id,
                                "name": tool_name(&call.name, oauth),
                                "input": call.arguments,
                            }));
                        }
                    }
                }
                if !blocks.is_empty() {
                    let level = assistant.provider_thinking_level.as_deref();
                    if managed_provider.is_some_and(|provider| provider == assistant.provider)
                        && assistant.api == "anthropic-messages"
                        && level.is_some_and(is_effort)
                    {
                        assistant_levels
                            .insert(converted.len(), level.unwrap_or_default().to_string());
                    }
                    converted.push(Converted {
                        message: json!({ "role": "assistant", "content": blocks }),
                        volatile: Vec::new(),
                    });
                }
            }
            Message::ToolResult(_) => {
                // Consecutive results go out in one user message; their volatile text follows them.
                let mut results = Vec::new();
                let mut volatile_texts = Vec::new();
                while let Some(Message::ToolResult(result)) = messages.get(index) {
                    results.push(tool_result(result));
                    for block in &result.content {
                        if let InputBlock::Text(text) = block {
                            if text.volatile == Some(true) && !is_blank(&text.text) {
                                volatile_texts.push(json!({ "type": "text", "text": text.text }));
                            }
                        }
                    }
                    index += 1;
                }
                index -= 1;
                let volatile = results
                    .iter()
                    .map(|_| false)
                    .chain(volatile_texts.iter().map(|_| true))
                    .collect();
                results.append(&mut volatile_texts);
                converted.push(Converted {
                    message: json!({ "role": "user", "content": results }),
                    volatile,
                });
            }
        }
        index += 1;
    }
    converted.append(&mut pending_system);

    // The cache breakpoint goes on the last block of the last user or system message that is
    // not volatile text: volatile text is gone from the next request.
    if let (Some(control), Some(last)) = (cache_control, converted.last_mut()) {
        let role = last.message["role"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if role == "user" || role == "system" {
            let content = &mut last.message["content"];
            if let Value::String(text) = content {
                *content =
                    json!([{ "type": "text", "text": text.clone(), "cache_control": control }]);
            } else if let Value::Array(blocks) = content {
                let position = (0..blocks.len())
                    .rev()
                    .find(|&position| !last.volatile.get(position).copied().unwrap_or(false));
                if let Some(block) = position.and_then(|position| blocks.get_mut(position)) {
                    let kind = block["type"].as_str().unwrap_or_default();
                    if matches!(
                        kind,
                        "text" | "image" | "tool_result" | "tool_addition" | "tool_removal"
                    ) {
                        if let Value::Object(block) = block {
                            block.insert("cache_control".into(), control.clone());
                        }
                    }
                }
            }
        }
    }
    Ok(ConvertedMessages {
        messages: converted,
        assistant_levels,
    })
}

fn configured_betas(model: &Model, options: &AnthropicOptions) -> Option<Option<String>> {
    let mut configured = None;
    for headers in [model.headers.as_ref(), options.headers.as_ref()]
        .into_iter()
        .flatten()
    {
        for (name, value) in headers {
            if name.to_lowercase() == "anthropic-beta" {
                configured = Some(value.as_str().map(str::to_string));
            }
        }
    }
    configured
}

fn beta_features(
    model: &Model,
    compat: &Compat,
    messages: &[Message],
    oauth: bool,
    native_tool_changes: bool,
    options: &AnthropicOptions,
) -> Vec<String> {
    let mut features: Vec<String> = Vec::new();
    match configured_betas(model, options) {
        Some(None) => return Vec::new(),
        Some(Some(configured)) => {
            for feature in configured
                .split(',')
                .map(js_trim)
                .filter(|feature| !feature.is_empty())
            {
                if !features.iter().any(|existing| existing == feature) {
                    features.push(feature.to_string());
                }
            }
            return features;
        }
        None => {}
    }
    let mut add = |feature: &str| {
        if !features.iter().any(|existing| existing == feature) {
            features.push(feature.to_string());
        }
    };
    if oauth {
        add("claude-code-20250219");
        add("oauth-2025-04-20");
    }
    if !current_tools(messages).is_empty() && !compat.eager_tool_input_streaming {
        add(FINE_GRAINED_TOOL_STREAMING_BETA);
    }
    if model.reasoning
        && options.thinking_enabled == Some(true)
        && options.interleaved_thinking.unwrap_or(true)
        && !compat.force_adaptive_thinking
    {
        add(INTERLEAVED_THINKING_BETA);
    }
    if !compat.fallback_models.is_empty() {
        add(SERVER_SIDE_FALLBACK_BETA);
    }
    if compat.mid_convo_effort {
        add(MID_CONVERSATION_OUTPUT_CONFIG_BETA);
        add(THINKING_BINDING_CONTROLS_BETA);
    }
    if native_tool_changes {
        add(INLINE_TOOLS_BETA);
    }
    features
}

/// The body for `messages` (a transcript whose system messages carry the prompt and tools).
/// `oauth` is whether the API key is an OAuth token. Fails when a tool requires strict mode the
/// model cannot give it.
pub fn build_request(
    model: &Model,
    messages: &[Message],
    oauth: bool,
    options: &AnthropicOptions,
) -> Result<Value, String> {
    let compat = compat(model);
    let messages = resolve_transcript(messages, compat.mid_convo_system_messages);
    let cache_control = cache_control(&compat, options);
    let initial = initial_system_message(&messages);
    let initial_text = initial.map(system_message_text).unwrap_or_default();
    let normalize = |id: &str, _: &AssistantMessage| normalize_tool_call_id(id);
    let transformed = transform_messages(&messages, model, Some(&normalize));
    let conversation = if initial.is_some() {
        &transformed[1..]
    } else {
        &transformed[..]
    };
    // Native tool changes keep the request's tool list fixed and define later tools in place;
    // Anthropic needs an initial active tool to anchor the deferred placeholder.
    let initial_tools = initial
        .and_then(|system| system.tools_added.clone())
        .unwrap_or_default();
    let native_tool_changes = compat.mid_convo_system_messages
        && compat.mid_convo_tool_changes
        && !initial_tools.is_empty();
    let managed_provider = compat.mid_convo_effort.then_some(model.provider.as_str());
    let converted = convert_messages(
        conversation,
        oauth,
        cache_control.as_ref(),
        &compat,
        managed_provider,
        native_tool_changes,
    )?;
    let active_effort = options.effort.clone().unwrap_or_else(|| "high".to_string());
    let betas = beta_features(
        model,
        &compat,
        &messages,
        oauth,
        native_tool_changes,
        options,
    );

    let mut wire_messages = Vec::new();
    for (position, message) in converted.messages.into_iter().enumerate() {
        if compat.mid_convo_effort {
            if let Some(level) = converted.assistant_levels.get(&position) {
                wire_messages.push(json!({ "role": "system", "content": [], "output_config": { "effort": level } }));
            }
        }
        wire_messages.push(message.message);
    }
    if compat.mid_convo_effort {
        wire_messages.push(json!({ "role": "system", "content": [], "output_config": { "effort": active_effort } }));
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(model.id));
    body.insert("messages".into(), Value::Array(wire_messages));
    body.insert(
        "max_tokens".into(),
        json!(options.max_tokens.unwrap_or(model.max_tokens)),
    );
    body.insert("stream".into(), json!(true));
    if !betas.is_empty() {
        body.insert("betas".into(), json!(betas));
    }

    let system_block = |text: &str| {
        let mut block = Map::new();
        block.insert("type".into(), json!("text"));
        block.insert("text".into(), json!(text));
        if let Some(control) = &cache_control {
            block.insert("cache_control".into(), control.clone());
        }
        Value::Object(block)
    };
    if oauth {
        // A subscription token is accepted only with Claude Code's identity first.
        let mut system = vec![system_block(CLAUDE_CODE_IDENTITY)];
        if !initial_text.is_empty() {
            system.push(system_block(&initial_text));
        }
        body.insert("system".into(), Value::Array(system));
    } else if !initial_text.is_empty() {
        body.insert("system".into(), json!([system_block(&initial_text)]));
    }

    // Temperature does not combine with extended thinking.
    if let Some(temperature) = options.temperature {
        if options.thinking_enabled != Some(true) && !compat.mid_convo_effort && compat.temperature
        {
            body.insert("temperature".into(), json!(temperature));
        }
    }

    let tool_cache_control = cache_control
        .as_ref()
        .filter(|_| compat.cache_control_on_tools);
    if native_tool_changes {
        let mut tools = convert_tools(&initial_tools, oauth, &compat, tool_cache_control)?;
        tools.push(json!({
            "name": "__pi_deferred_placeholder__",
            "description": "Reserved placeholder. Never available. Never call this.",
            "input_schema": { "type": "object", "properties": {}, "required": [] },
            "defer_loading": true,
        }));
        body.insert("tools".into(), Value::Array(tools));
    } else {
        let tools = current_tools(&messages);
        if !tools.is_empty() {
            body.insert(
                "tools".into(),
                Value::Array(convert_tools(&tools, oauth, &compat, tool_cache_control)?),
            );
        }
    }

    let display = options
        .thinking_display
        .clone()
        .unwrap_or_else(|| "summarized".to_string());
    if compat.mid_convo_effort {
        // Managed effort always uses adaptive thinking, so a prefix mismatch drops the block
        // instead of failing the request.
        body.insert(
            "thinking".into(),
            json!({
                "type": "adaptive",
                "display": display,
                "block_binding": { "prefix_mismatch_behavior": "drop_block" },
            }),
        );
        body.insert("output_config".into(), json!({ "effort": "high" }));
    } else if model.reasoning {
        if options.thinking_enabled == Some(true) {
            if compat.force_adaptive_thinking {
                body.insert(
                    "thinking".into(),
                    json!({ "type": "adaptive", "display": display }),
                );
                if let Some(effort) = options.effort.as_ref().filter(|effort| !effort.is_empty()) {
                    body.insert("output_config".into(), json!({ "effort": effort }));
                }
            } else {
                let budget = options
                    .thinking_budget_tokens
                    .filter(|budget| *budget > 0)
                    .unwrap_or(1024);
                body.insert(
                    "thinking".into(),
                    json!({ "type": "enabled", "budget_tokens": budget, "display": display }),
                );
            }
        } else if options.thinking_enabled == Some(false)
            && model
                .thinking_level_map
                .as_ref()
                .and_then(|map| map.get("off"))
                != Some(&Value::Null)
        {
            body.insert("thinking".into(), json!({ "type": "disabled" }));
        }
    }

    if let Some(Value::String(user_id)) = options
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("user_id"))
    {
        body.insert("metadata".into(), json!({ "user_id": user_id }));
    }

    match &options.tool_choice {
        Some(Value::String(choice)) => {
            body.insert("tool_choice".into(), json!({ "type": choice }));
        }
        Some(choice) => {
            body.insert("tool_choice".into(), choice.clone());
        }
        None => {}
    }

    if !compat.fallback_models.is_empty() {
        let fallbacks: Vec<Value> = compat
            .fallback_models
            .iter()
            .map(|fallback| json!({ "model": fallback }))
            .collect();
        body.insert("fallbacks".into(), Value::Array(fallbacks));
    }

    Ok(Value::Object(body))
}
