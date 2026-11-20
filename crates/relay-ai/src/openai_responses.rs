//! The OpenAI Responses request body, as `buildParams` in
//! `packages/ai/src/api/openai-responses.ts` and `convertResponsesMessages` and
//! `convertResponsesTools` in `openai-responses-shared.ts` build it. `tests/openai_responses.rs`
//! compares it with the TypeScript body byte for byte.
//!
//! Tool call ids carry two parts, `call_id|item_id`: the call id pairs a call with its result,
//! and the item id (`fc_*` for function calls, `ctc_*` for custom tool calls) is replayed only to
//! the model that made it.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::json::js_number;
use crate::message::{AssistantMessage, InputBlock, Message, OutputBlock, Tool};
use crate::model::Model;
use crate::options::{resolve_cache_retention, CacheRetention};
use crate::strict::{
    grammar_tool_input, grammar_tool_input_properties, json_schema_tool_parameters,
    resolve_grammar_constrained_sampling, resolve_json_schema_strict_sampling,
};
use crate::text::{js_length, replace_non_id_characters, short_hash};
use crate::transcript::{
    declared_tools, render_system_message_update, resolve_transcript, resolve_transcript_tools,
    system_message_text,
};
use crate::transform::transform_messages;
use crate::Content;

/// Providers whose tool call ids keep their item part.
const TOOL_CALL_PROVIDERS: [&str; 3] = ["openai", "openai-codex", "opencode"];
/// OpenAI rejects `max_output_tokens` below 16.
const MIN_OUTPUT_TOKENS: u64 = 16;
const PROMPT_CACHE_KEY_MAX_LENGTH: usize = 64;

/// The options of `OpenAIResponsesOptions` that shape the body.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAIResponsesOptions {
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub cache_retention: Option<CacheRetention>,
    pub env: Option<HashMap<String, String>>,
    pub session_id: Option<String>,
    pub service_tier: Option<Value>,
    pub tool_choice: Option<Value>,
    pub reasoning_effort: Option<String>,
    /// `"auto"`, `"detailed"`, `"concise"` or null.
    pub reasoning_summary: Option<Value>,
    pub sampling_params: Option<Map<String, Value>>,
}

struct Compat {
    mid_convo_system_messages: bool,
    long_cache_retention: bool,
    strict_mode: bool,
    grammar_tools: bool,
    additional_tools: bool,
    tool_search: bool,
    explicit_prompt_cache_mode: bool,
    max_output_tokens: bool,
}

fn compat(model: &Model) -> Compat {
    let compat = model.compat();
    Compat {
        mid_convo_system_messages: compat.supports_mid_convo_system_messages.unwrap_or(false),
        long_cache_retention: compat.supports_long_cache_retention.unwrap_or(true),
        strict_mode: compat.supports_strict_mode.unwrap_or(false),
        grammar_tools: compat.supports_openai_grammar_tools.unwrap_or(false),
        additional_tools: compat.supports_additional_tools.unwrap_or(false),
        tool_search: compat.supports_tool_search.unwrap_or(false),
        explicit_prompt_cache_mode: compat.supports_explicit_prompt_cache_mode.unwrap_or(false),
        max_output_tokens: compat.supports_max_output_tokens.unwrap_or(true),
    }
}

/// A token sent straight to OpenAI that is not an API key (`sk-`) is a ChatGPT sign-in, which
/// rejects some request fields.
fn is_chatgpt_sign_in(model: &Model, api_key: Option<&str>) -> bool {
    model.provider == "openai"
        && model.base_url == "https://api.openai.com/v1"
        && api_key.is_some_and(|key| !key.starts_with("sk-"))
}

/// At most 64 code points.
fn clamp_prompt_cache_key(key: &str) -> String {
    key.chars().take(PROMPT_CACHE_KEY_MAX_LENGTH).collect()
}

/// The id characters, at most 64, without trailing underscores.
fn normalize_id_part(part: &str) -> String {
    let mut normalized = replace_non_id_characters(part);
    normalized.truncate(64);
    normalized.trim_end_matches('_').to_string()
}

fn first_part(id: &str) -> &str {
    id.split('|').next().unwrap_or(id)
}

fn second_part(id: &str) -> Option<&str> {
    id.split('|').nth(1)
}

#[derive(Default)]
struct ToolOptions {
    supports_strict_mode: bool,
    supports_grammar_tools: bool,
    tool_search_result: bool,
}

fn convert_tools(tools: &[Tool], options: &ToolOptions) -> Result<Vec<Value>, String> {
    let mut converted = Vec::with_capacity(tools.len());
    for tool in tools {
        let mut definition = Map::new();
        if let Some(grammar) =
            resolve_grammar_constrained_sampling(tool, options.supports_grammar_tools)?
        {
            definition.insert("type".into(), json!("custom"));
            definition.insert("name".into(), json!(tool.name));
            definition.insert("description".into(), json!(tool.description));
            definition.insert(
                "format".into(),
                json!({ "type": "grammar", "syntax": grammar.syntax, "definition": grammar.definition }),
            );
            if options.tool_search_result {
                definition.insert("defer_loading".into(), json!(true));
            }
        } else {
            let strict =
                resolve_json_schema_strict_sampling(tool, options.supports_strict_mode, None)?;
            definition.insert("type".into(), json!("function"));
            definition.insert("name".into(), json!(tool.name));
            definition.insert("description".into(), json!(tool.description));
            definition.insert(
                "parameters".into(),
                json_schema_tool_parameters(tool, strict),
            );
            if options.tool_search_result {
                definition.insert("defer_loading".into(), json!(true));
            }
            if options.supports_strict_mode {
                definition.insert("strict".into(), json!(strict));
            }
        }
        converted.push(Value::Object(definition));
    }
    Ok(converted)
}

fn image_url(mime_type: &str, data: &str) -> String {
    format!("data:{mime_type};base64,{data}")
}

/// A tool result's output: text alone, or text and images for a model that reads images.
fn tool_result_output(model: &Model, content: &[InputBlock]) -> Value {
    let text = content
        .iter()
        .filter_map(|block| match block {
            InputBlock::Text(text) => Some(text.text.as_str()),
            InputBlock::Image(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let images: Vec<_> = content
        .iter()
        .filter_map(|block| match block {
            InputBlock::Image(image) => Some(image),
            InputBlock::Text(_) => None,
        })
        .collect();
    if images.is_empty() || !model.accepts_images() {
        return json!(if !text.is_empty() {
            text.as_str()
        } else if !images.is_empty() {
            "(see attached image)"
        } else {
            "(no tool output)"
        });
    }
    let mut output = Vec::new();
    if !text.is_empty() {
        output.push(json!({ "type": "input_text", "text": text }));
    }
    for image in images {
        output.push(json!({
            "type": "input_image",
            "detail": "auto",
            "image_url": image_url(&image.mime_type, &image.data),
        }));
    }
    Value::Array(output)
}

/// A text block's signature: a v1 JSON payload with an id and a phase, or a plain legacy id.
fn parse_text_signature(signature: Option<&str>) -> Option<(String, Option<String>)> {
    let signature = signature.filter(|signature| !signature.is_empty())?;
    if signature.starts_with('{') {
        if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(signature) {
            if parsed.get("v") == Some(&json!(1)) {
                if let Some(Value::String(id)) = parsed.get("id") {
                    let phase = parsed
                        .get("phase")
                        .and_then(Value::as_str)
                        .filter(|phase| matches!(*phase, "commentary" | "final_answer"))
                        .map(str::to_string);
                    return Some((id.clone(), phase));
                }
            }
        }
    }
    Some((signature.to_string(), None))
}

struct Converter<'a> {
    model: &'a Model,
    compat: &'a Compat,
    grammar_properties: &'a [(String, String)],
    tool_options: ToolOptions,
}

impl Converter<'_> {
    fn grammar_property(&self, tool_name: &str) -> Option<&str> {
        self.grammar_properties
            .iter()
            .find(|(name, _)| name == tool_name)
            .map(|(_, property)| property.as_str())
    }

    /// Tools a later system message adds, loaded in place where the model can.
    fn tool_additions(
        &self,
        tools: &[Tool],
        seed: &str,
        input: &mut Vec<Value>,
    ) -> Result<(), String> {
        if tools.is_empty() {
            return Ok(());
        }
        if self.compat.additional_tools {
            input.push(json!({
                "type": "additional_tools",
                "role": "developer",
                "tools": convert_tools(tools, &self.tool_options)?,
            }));
            return Ok(());
        }
        if !self.compat.tool_search {
            return Ok(());
        }
        let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
        let call_id = format!(
            "pi_tool_load_{}",
            short_hash(&format!("{seed}:{}", names.join(",")))
        );
        input.push(json!({
            "type": "tool_search_call",
            "call_id": call_id,
            "execution": "client",
            "status": "completed",
            "arguments": { "query": names.join(" "), "limit": names.len() },
        }));
        let search_options = ToolOptions {
            supports_strict_mode: self.tool_options.supports_strict_mode,
            supports_grammar_tools: self.tool_options.supports_grammar_tools,
            tool_search_result: true,
        };
        input.push(json!({
            "type": "tool_search_output",
            "call_id": call_id,
            "execution": "client",
            "status": "completed",
            "tools": convert_tools(tools, &search_options)?,
        }));
        Ok(())
    }

    fn convert(&self, messages: &[Message]) -> Result<Vec<Value>, String> {
        let model = self.model;
        let messages = resolve_transcript(messages, self.compat.mid_convo_system_messages);
        let keeps_item_ids = TOOL_CALL_PROVIDERS.contains(&model.provider.as_str());
        let normalize = |id: &str, source: &AssistantMessage| {
            if !keeps_item_ids || !id.contains('|') {
                return normalize_id_part(id);
            }
            let call_id = normalize_id_part(first_part(id));
            let item_id = second_part(id).unwrap_or_default();
            let foreign = source.provider != model.provider || source.api != model.api;
            let mut item_id = if foreign {
                format!("fc_{}", short_hash(item_id))
            } else {
                normalize_id_part(item_id)
            };
            if !item_id.starts_with("fc_") {
                item_id = normalize_id_part(&format!("fc_{item_id}"));
            }
            format!("{call_id}|{item_id}")
        };
        let transformed = transform_messages(&messages, model, Some(&normalize));
        let (_, anchors_additions) = resolve_transcript_tools(
            &messages,
            self.compat.additional_tools || self.compat.tool_search,
        );
        let instruction_role =
            if model.reasoning && model.compat().supports_developer_role != Some(false) {
                "developer"
            } else {
                "system"
            };

        let mut input = Vec::new();
        let mut message_index = 0;
        for (source_index, message) in transformed.iter().enumerate() {
            let leading = source_index == 0 && matches!(message, Message::System(_));
            match message {
                Message::System(system) => {
                    if !leading && anchors_additions {
                        let tools = system.tools_added.clone().unwrap_or_default();
                        self.tool_additions(
                            &tools,
                            &format!("system:{message_index}"),
                            &mut input,
                        )?;
                    }
                    let text = if leading {
                        system_message_text(system)
                    } else {
                        render_system_message_update(system)
                    };
                    if !text.is_empty() {
                        input.push(json!({ "role": instruction_role, "content": text }));
                    }
                }
                Message::User(user) => match &user.content {
                    Content::Text(text) => input.push(json!({
                        "role": "user",
                        "content": [{ "type": "input_text", "text": text }],
                    })),
                    Content::Blocks(blocks) => {
                        // An empty message is skipped, and does not count for message ids.
                        if blocks.is_empty() {
                            continue;
                        }
                        let content: Vec<Value> = blocks
                            .iter()
                            .map(|block| match block {
                                InputBlock::Text(text) => {
                                    json!({ "type": "input_text", "text": text.text })
                                }
                                InputBlock::Image(image) => json!({
                                    "type": "input_image",
                                    "detail": "auto",
                                    "image_url": image_url(&image.mime_type, &image.data),
                                }),
                            })
                            .collect();
                        input.push(json!({ "role": "user", "content": content }));
                    }
                },
                Message::Assistant(assistant) => {
                    let output = self.assistant_items(assistant, message_index)?;
                    if output.is_empty() {
                        continue;
                    }
                    input.extend(output);
                }
                Message::ToolResult(result) => {
                    let kind = if self.grammar_property(&result.tool_name).is_some() {
                        "custom_tool_call_output"
                    } else {
                        "function_call_output"
                    };
                    input.push(json!({
                        "type": kind,
                        "call_id": first_part(&result.tool_call_id),
                        "output": tool_result_output(model, &result.content),
                    }));
                }
            }
            if !leading {
                message_index += 1;
            }
        }
        Ok(input)
    }

    fn assistant_items(
        &self,
        assistant: &AssistantMessage,
        message_index: usize,
    ) -> Result<Vec<Value>, String> {
        let model = self.model;
        let same_provider_and_api =
            assistant.provider == model.provider && assistant.api == model.api;
        let same_model = same_provider_and_api && assistant.model == model.id;
        let different_model = same_provider_and_api && assistant.model != model.id;
        let mut output = Vec::new();
        let mut text_index = 0;
        for block in &assistant.content {
            match block {
                OutputBlock::Thinking(thinking) => {
                    // The signature is the reasoning item itself, replayed as it came.
                    if let Some(signature) = thinking
                        .thinking_signature
                        .as_deref()
                        .filter(|s| !s.is_empty())
                    {
                        output.push(
                            serde_json::from_str::<Value>(signature).map_err(|error| {
                                format!("reasoning item does not parse: {error}")
                            })?,
                        );
                    }
                }
                OutputBlock::Text(text) => {
                    let signature = parse_text_signature(text.text_signature.as_deref());
                    let fallback_id = if text_index == 0 {
                        format!("msg_pi_{message_index}")
                    } else {
                        format!("msg_pi_{message_index}_{text_index}")
                    };
                    text_index += 1;
                    let id = match &signature {
                        Some((id, _)) if !id.is_empty() && js_length(id) > 64 => {
                            format!("msg_{}", short_hash(id))
                        }
                        Some((id, _)) if !id.is_empty() => id.clone(),
                        _ => fallback_id,
                    };
                    let mut item = Map::new();
                    item.insert("type".into(), json!("message"));
                    item.insert("role".into(), json!("assistant"));
                    item.insert(
                        "content".into(),
                        json!([{ "type": "output_text", "text": text.text, "annotations": [] }]),
                    );
                    item.insert("status".into(), json!("completed"));
                    item.insert("id".into(), json!(id));
                    if let Some((_, Some(phase))) = &signature {
                        item.insert("phase".into(), json!(phase));
                    }
                    output.push(Value::Object(item));
                }
                OutputBlock::ToolCall(call) => {
                    let call_id = first_part(&call.id);
                    let custom_property = self.grammar_property(&call.name);
                    let prefix = if custom_property.is_none() {
                        "fc_"
                    } else {
                        "ctc_"
                    };
                    // An item id is replayed only to the model that made it, and only with the
                    // prefix of the item type it is sent as.
                    let item_id = second_part(&call.id)
                        .filter(|item_id| !different_model && item_id.starts_with(prefix));
                    let mut item = Map::new();
                    match custom_property {
                        Some(property) => {
                            item.insert("type".into(), json!("custom_tool_call"));
                            if let Some(item_id) = item_id {
                                item.insert("id".into(), json!(item_id));
                            }
                            item.insert("call_id".into(), json!(call_id));
                            item.insert("name".into(), json!(call.name));
                            item.insert(
                                "input".into(),
                                json!(grammar_tool_input(&call.name, &call.arguments, property)?),
                            );
                        }
                        None => {
                            item.insert("type".into(), json!("function_call"));
                            if let Some(item_id) = item_id {
                                item.insert("id".into(), json!(item_id));
                            }
                            item.insert("call_id".into(), json!(call_id));
                            item.insert("name".into(), json!(call.name));
                            item.insert(
                                "arguments".into(),
                                json!(serde_json::to_string(&call.arguments).unwrap_or_default()),
                            );
                        }
                    }
                    if let Some(namespace) = call.namespace.as_ref().filter(|_| same_model) {
                        item.insert("namespace".into(), json!(namespace));
                    }
                    output.push(Value::Object(item));
                }
            }
        }
        Ok(output)
    }
}

/// The body for `messages` (a transcript whose system messages carry the prompt and tools).
/// `api_key` decides whether this is a ChatGPT sign-in. Fails where the TypeScript adapter
/// throws: a tool whose constrained sampling cannot be honored, a grammar call without its
/// string input, a reasoning item that does not parse.
pub fn build_request(
    model: &Model,
    messages: &[Message],
    api_key: Option<&str>,
    options: &OpenAIResponsesOptions,
) -> Result<Value, String> {
    let compat = compat(model);
    let messages = resolve_transcript(messages, compat.mid_convo_system_messages);
    let grammar_properties =
        grammar_tool_input_properties(&declared_tools(&messages), compat.grammar_tools)?;
    let (request_tools, _) =
        resolve_transcript_tools(&messages, compat.additional_tools || compat.tool_search);
    let tool_options = ToolOptions {
        supports_strict_mode: compat.strict_mode,
        supports_grammar_tools: compat.grammar_tools,
        tool_search_result: false,
    };
    let converter = Converter {
        model,
        compat: &compat,
        grammar_properties: &grammar_properties,
        tool_options,
    };
    let input = converter.convert(&messages)?;

    let retention = resolve_cache_retention(options.cache_retention, options.env.as_ref());
    let omit_unsupported = is_chatgpt_sign_in(model, api_key);
    let mut body = Map::new();
    body.insert("model".into(), json!(model.id));
    body.insert("input".into(), Value::Array(input));
    body.insert("stream".into(), json!(true));
    if retention != CacheRetention::None {
        if let Some(session_id) = &options.session_id {
            body.insert(
                "prompt_cache_key".into(),
                json!(clamp_prompt_cache_key(session_id)),
            );
        }
    }
    if !omit_unsupported {
        if retention == CacheRetention::Long
            && compat.long_cache_retention
            && !compat.explicit_prompt_cache_mode
        {
            body.insert("prompt_cache_retention".into(), json!("24h"));
        }
        if compat.explicit_prompt_cache_mode {
            if retention == CacheRetention::None {
                body.insert("prompt_cache_options".into(), json!({ "mode": "explicit" }));
            } else if retention == CacheRetention::Long && compat.long_cache_retention {
                body.insert("prompt_cache_options".into(), json!({ "ttl": "30m" }));
            }
        }
    }
    body.insert("store".into(), json!(false));

    if let Some(max_tokens) = options.max_tokens.filter(|tokens| *tokens > 0) {
        if compat.max_output_tokens && !omit_unsupported {
            body.insert(
                "max_output_tokens".into(),
                json!(max_tokens.max(MIN_OUTPUT_TOKENS)),
            );
        }
    }
    if let Some(temperature) = options.temperature.filter(|_| !omit_unsupported) {
        body.insert("temperature".into(), js_number(temperature));
    }
    if let Some(tier) = &options.service_tier {
        body.insert("service_tier".into(), tier.clone());
    }
    if !request_tools.is_empty() {
        body.insert(
            "tools".into(),
            Value::Array(convert_tools(&request_tools, &converter.tool_options)?),
        );
    }
    if let Some(choice) = &options.tool_choice {
        body.insert("tool_choice".into(), choice.clone());
    }

    let summary = options
        .reasoning_summary
        .as_ref()
        .and_then(Value::as_str)
        .filter(|summary| !summary.is_empty());
    let reasoning_effort = options
        .reasoning_effort
        .clone()
        .or_else(|| summary.map(|_| "medium".to_string()));
    if model.reasoning {
        match reasoning_effort
            .as_deref()
            .filter(|effort| !effort.is_empty())
        {
            Some(effort) => {
                let effort = match &options.reasoning_effort {
                    Some(requested) if !requested.is_empty() => model
                        .thinking_level(requested)
                        .and_then(Value::as_str)
                        .unwrap_or(requested)
                        .to_string(),
                    _ => effort.to_string(),
                };
                body.insert(
                    "reasoning".into(),
                    json!({ "effort": effort, "summary": summary.unwrap_or("auto") }),
                );
                body.insert("include".into(), json!(["reasoning.encrypted_content"]));
            }
            None => {
                if model.provider != "github-copilot"
                    && model.thinking_level("off") != Some(&Value::Null)
                {
                    let off = model
                        .thinking_level("off")
                        .and_then(Value::as_str)
                        .unwrap_or("none");
                    body.insert("reasoning".into(), json!({ "effort": off }));
                }
            }
        }
        if model.provider == "xai" {
            body.insert("include".into(), json!(["reasoning.encrypted_content"]));
        }
    }

    // Last, so sampling parameters override the named fields.
    let level = reasoning_effort.as_deref().unwrap_or("off");
    if let Some(sampling) = model.sampling_params(level, options.sampling_params.as_ref()) {
        for (key, value) in sampling {
            body.insert(key, value);
        }
    }
    Ok(Value::Object(body))
}
