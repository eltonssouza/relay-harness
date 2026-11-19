//! The Google Gemini request, as `buildParams` in `packages/ai/src/api/google-generative-ai.ts`
//! and `convertMessages` and `convertTools` in `google-shared.ts` build it.
//!
//! `build_params` returns the `GenerateContentParameters` the TypeScript adapter hands to the
//! `@google/genai` SDK, key order included. `request_url` and `wire_body` turn them into the HTTP
//! request the SDK makes: the URL exactly, the body with the same content (the SDK orders keys by
//! its own schema, which Gemini does not depend on).

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::json::js_number;
use crate::message::{InputBlock, Message, OutputBlock, Tool};
use crate::model::Model;
use crate::strict::{json_schema_tool_parameters, resolve_json_schema_strict_sampling};
use crate::text::{is_blank, normalize_tool_call_id};
use crate::transcript::{
    collapse_system_messages, current_tools, initial_system_message, system_message_text,
};
use crate::transform::transform_messages;
use crate::Content;

const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Thinking as `stream()` takes it, after the simple layer resolved the request's level.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleThinking {
    pub enabled: bool,
    /// -1 for a dynamic budget, 0 to disable.
    pub budget_tokens: Option<i64>,
    /// `MINIMAL`, `LOW`, `MEDIUM` or `HIGH`, for models with thinking levels.
    pub level: Option<String>,
}

/// The options of `GoogleOptions` that shape the request.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleOptions {
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    /// `auto`, `none` or `any`.
    pub tool_choice: Option<String>,
    pub thinking: Option<GoogleThinking>,
}

/// The major version of a `gemini-N…` or `gemini-live-N…` model id.
fn gemini_major_version(model_id: &str) -> Option<u32> {
    let id = model_id.to_lowercase();
    let rest = id.strip_prefix("gemini-")?;
    let rest = rest.strip_prefix("live-").unwrap_or(rest);
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Models behind Google APIs that need ids on function calls and responses.
fn requires_tool_call_id(model_id: &str) -> bool {
    model_id.starts_with("claude-")
        || model_id.starts_with("gpt-oss-")
        || gemini_major_version(model_id).is_some_and(|major| major >= 3)
}

/// Gemini 3+ takes images inside function responses; older Gemini needs a separate turn.
fn supports_multimodal_function_response(model_id: &str) -> bool {
    gemini_major_version(model_id).is_none_or(|major| major >= 3)
}

/// Gemini 3+ enforces required function parameters in validated mode.
fn supports_strict_tool_sampling(model_id: &str) -> bool {
    gemini_major_version(model_id).is_some_and(|major| major >= 3)
}

/// Whether the model takes `thinkingLevel` rather than a token budget (`usesGoogleThinkingLevel`):
/// Gemini 3 Pro and Flash, the `-latest` Flash aliases, and Gemma 4.
pub fn uses_thinking_level(model: &Model) -> bool {
    let id = model.id.to_lowercase();
    let gemini_3 = id.match_indices("gemini-3").any(|(start, matched)| {
        let mut rest = &id[start + matched.len()..];
        if let Some(after_dot) = rest.strip_prefix('.') {
            let digits = after_dot.chars().take_while(char::is_ascii_digit).count();
            if digits == 0 {
                return false;
            }
            rest = &after_dot[digits..];
        }
        rest.starts_with("-pro") || rest.starts_with("-flash")
    });
    gemini_3
        || id == "gemini-flash-latest"
        || id == "gemini-flash-lite-latest"
        || id.contains("gemma-4")
        || id.contains("gemma4")
}

/// A Relay thinking level resolved to one Google supports, through the model's map.
pub(crate) fn resolve_thinking_level(model: &Model, level: &str) -> Result<&'static str, String> {
    let mapped = model.thinking_level(level);
    let resolved = match mapped {
        Some(Value::String(mapped)) => mapped.to_lowercase(),
        _ => level.to_string(),
    };
    match resolved.as_str() {
        "minimal" => Ok("MINIMAL"),
        "low" => Ok("LOW"),
        "medium" => Ok("MEDIUM"),
        "high" => Ok("HIGH"),
        _ => Err(format!(
            "Unsupported Google thinking level mapping for {}/{}: {level} -> {}",
            model.provider,
            model.id,
            match mapped {
                None => "undefined".to_string(),
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
            }
        )),
    }
}

/// Thinking turned off: a zero budget, or the lowest level of a model that cannot turn it off.
fn disabled_thinking_config(model: &Model) -> Result<Value, String> {
    if !uses_thinking_level(model) {
        return Ok(json!({ "thinkingBudget": 0 }));
    }
    let fallback = model.clamp_thinking_level("off");
    if fallback == "off" {
        return Ok(json!({ "thinkingBudget": 0 }));
    }
    Ok(json!({ "thinkingLevel": resolve_thinking_level(model, fallback)? }))
}

/// Thought signatures are base64 (`TYPE_BYTES`), and only the model that made them reads them.
fn thought_signature(same_model: bool, signature: Option<&str>) -> Option<String> {
    let signature = signature.filter(|signature| !signature.is_empty())?;
    let body = signature.trim_end_matches('=');
    let padding = signature.len() - body.len();
    let valid = same_model
        && signature.len() % 4 == 0
        && padding <= 2
        && !body.is_empty()
        && body.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '+' || character == '/'
        });
    valid.then(|| signature.to_string())
}

fn part_with_signature(mut part: Map<String, Value>, signature: Option<String>) -> Value {
    if let Some(signature) = signature {
        part.insert("thoughtSignature".into(), json!(signature));
    }
    Value::Object(part)
}

fn inline_data(mime_type: &str, data: &str) -> Value {
    json!({ "inlineData": { "mimeType": mime_type, "data": data } })
}

fn convert_messages(model: &Model, messages: &[Message]) -> Vec<Value> {
    // Gemini has no system messages in the conversation; the prompt goes in systemInstruction.
    let collapsed = collapse_system_messages(messages);
    let conversation = if initial_system_message(&collapsed).is_some() {
        &collapsed[1..]
    } else {
        &collapsed[..]
    };
    let needs_ids = requires_tool_call_id(&model.id);
    let normalize = |id: &str, _: &crate::AssistantMessage| {
        if needs_ids {
            normalize_tool_call_id(id)
        } else {
            id.to_string()
        }
    };
    let transformed = transform_messages(conversation, model, Some(&normalize));

    let mut contents: Vec<Value> = Vec::new();
    for message in &transformed {
        match message {
            Message::User(user) => {
                let parts: Vec<Value> = match &user.content {
                    Content::Text(text) => vec![json!({ "text": text })],
                    Content::Blocks(blocks) => blocks
                        .iter()
                        .map(|block| match block {
                            InputBlock::Text(text) => json!({ "text": text.text }),
                            InputBlock::Image(image) => inline_data(&image.mime_type, &image.data),
                        })
                        .collect(),
                };
                if !parts.is_empty() {
                    contents.push(json!({ "role": "user", "parts": parts }));
                }
            }
            Message::Assistant(assistant) => {
                let same_model =
                    assistant.provider == model.provider && assistant.model == model.id;
                let mut parts = Vec::new();
                for block in &assistant.content {
                    match block {
                        OutputBlock::Text(text) => {
                            let signature =
                                thought_signature(same_model, text.text_signature.as_deref());
                            // Gemini may put the signature on an empty part and needs it back.
                            if is_blank(&text.text) && signature.is_none() {
                                continue;
                            }
                            let mut part = Map::new();
                            part.insert("text".into(), json!(text.text));
                            parts.push(part_with_signature(part, signature));
                        }
                        OutputBlock::Thinking(thinking) => {
                            if same_model {
                                let signature = thought_signature(
                                    same_model,
                                    thinking.thinking_signature.as_deref(),
                                );
                                if is_blank(&thinking.thinking) && signature.is_none() {
                                    continue;
                                }
                                let mut part = Map::new();
                                part.insert("thought".into(), json!(true));
                                part.insert("text".into(), json!(thinking.thinking));
                                parts.push(part_with_signature(part, signature));
                            } else if !is_blank(&thinking.thinking) {
                                parts.push(json!({ "text": thinking.thinking }));
                            }
                        }
                        OutputBlock::ToolCall(call) => {
                            let signature =
                                thought_signature(same_model, call.thought_signature.as_deref());
                            let mut function_call = Map::new();
                            function_call.insert("name".into(), json!(call.name));
                            function_call
                                .insert("args".into(), Value::Object(call.arguments.clone()));
                            if needs_ids {
                                function_call.insert("id".into(), json!(call.id));
                            }
                            let mut part = Map::new();
                            part.insert("functionCall".into(), Value::Object(function_call));
                            parts.push(part_with_signature(part, signature));
                        }
                    }
                }
                if !parts.is_empty() {
                    contents.push(json!({ "role": "model", "parts": parts }));
                }
            }
            Message::ToolResult(result) => {
                let text = result
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        InputBlock::Text(text) => Some(text.text.as_str()),
                        InputBlock::Image(_) => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let images: Vec<Value> = if model.accepts_images() {
                    result
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            InputBlock::Image(image) => {
                                Some(inline_data(&image.mime_type, &image.data))
                            }
                            InputBlock::Text(_) => None,
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                let multimodal = supports_multimodal_function_response(&model.id);
                let value = if !text.is_empty() {
                    text
                } else if !images.is_empty() {
                    "(see attached image)".into()
                } else {
                    String::new()
                };
                let mut response = Map::new();
                response.insert("name".into(), json!(result.tool_name));
                response.insert(
                    "response".into(),
                    if result.is_error {
                        json!({ "error": value })
                    } else {
                        json!({ "output": value })
                    },
                );
                if !images.is_empty() && multimodal {
                    response.insert("parts".into(), Value::Array(images.clone()));
                }
                if needs_ids {
                    response.insert("id".into(), json!(result.tool_call_id));
                }
                let part = json!({ "functionResponse": response });
                // All function responses of a turn go in one user content.
                let merge = contents.last().is_some_and(|last| {
                    last["role"] == "user"
                        && last["parts"].as_array().is_some_and(|parts| {
                            parts
                                .iter()
                                .any(|part| part.get("functionResponse").is_some())
                        })
                });
                if merge {
                    if let Some(Value::Array(parts)) =
                        contents.last_mut().and_then(|last| last.get_mut("parts"))
                    {
                        parts.push(part);
                    }
                } else {
                    contents.push(json!({ "role": "user", "parts": [part] }));
                }
                if !images.is_empty() && !multimodal {
                    let mut parts = vec![json!({ "text": "Tool result image:" })];
                    parts.extend(images);
                    contents.push(json!({ "role": "user", "parts": parts }));
                }
            }
            Message::System(_) => {}
        }
    }
    contents
}

fn convert_tools(tools: &[Tool], supports_strict_mode: bool) -> Result<Value, String> {
    let mut declarations = Vec::with_capacity(tools.len());
    for tool in tools {
        let strict = resolve_json_schema_strict_sampling(tool, supports_strict_mode, None)?;
        declarations.push(json!({
            "name": tool.name,
            "description": tool.description,
            "parametersJsonSchema": json_schema_tool_parameters(tool, strict),
        }));
    }
    Ok(json!([{ "functionDeclarations": declarations }]))
}

fn tool_choice_mode(choice: &str) -> &'static str {
    match choice {
        "none" => "NONE",
        "any" => "ANY",
        _ => "AUTO",
    }
}

/// `resolveGoogleFunctionCallingMode`: an explicit `none` or `any`, else validated mode when a
/// tool is strict, else the requested choice.
fn function_calling_mode(
    tools: &[Tool],
    choice: Option<&str>,
    supports_strict_mode: bool,
) -> Result<Option<&'static str>, String> {
    let mut strict = false;
    for tool in tools {
        if resolve_json_schema_strict_sampling(tool, supports_strict_mode, None)? {
            strict = true;
        }
    }
    Ok(match choice {
        Some(choice @ ("none" | "any")) => Some(tool_choice_mode(choice)),
        _ if strict => Some("VALIDATED"),
        Some(choice) if !choice.is_empty() => Some(tool_choice_mode(choice)),
        _ => None,
    })
}

/// The `GenerateContentParameters` for `messages` (a transcript whose system messages carry the
/// prompt and tools). Fails where the TypeScript adapter throws: a strict tool the model cannot
/// honor, or a thinking level the model's map resolves to nothing Google knows.
pub fn build_params(
    model: &Model,
    messages: &[Message],
    options: &GoogleOptions,
) -> Result<Value, String> {
    let messages = collapse_system_messages(messages);
    let contents = convert_messages(model, &messages);
    let system_instruction = initial_system_message(&messages)
        .map(system_message_text)
        .unwrap_or_default();
    let tools = current_tools(&messages);
    let strict = supports_strict_tool_sampling(&model.id);
    let mode = if tools.is_empty() {
        None
    } else {
        function_calling_mode(&tools, options.tool_choice.as_deref(), strict)?
    };

    let mut config = Map::new();
    if let Some(temperature) = options.temperature {
        config.insert("temperature".into(), js_number(temperature));
    }
    if let Some(max_tokens) = options.max_tokens {
        config.insert("maxOutputTokens".into(), json!(max_tokens));
    }
    if !system_instruction.is_empty() {
        config.insert("systemInstruction".into(), json!(system_instruction));
    }
    if !tools.is_empty() {
        config.insert("tools".into(), convert_tools(&tools, strict)?);
    }
    if let Some(mode) = mode {
        config.insert(
            "toolConfig".into(),
            json!({ "functionCallingConfig": { "mode": mode } }),
        );
    }
    match &options.thinking {
        Some(thinking) if thinking.enabled && model.reasoning => {
            let mut thinking_config = Map::new();
            thinking_config.insert("includeThoughts".into(), json!(true));
            if let Some(level) = &thinking.level {
                thinking_config.insert("thinkingLevel".into(), json!(level));
            } else if let Some(budget) = thinking.budget_tokens {
                thinking_config.insert("thinkingBudget".into(), json!(budget));
            }
            config.insert("thinkingConfig".into(), Value::Object(thinking_config));
        }
        Some(thinking) if !thinking.enabled && model.reasoning => {
            config.insert("thinkingConfig".into(), disabled_thinking_config(model)?);
        }
        _ => {}
    }
    Ok(json!({ "model": model.id, "contents": contents, "config": config }))
}

/// The streaming endpoint. A model's base URL already includes the API version.
pub fn request_url(model: &Model) -> String {
    let base = if model.base_url.is_empty() {
        DEFAULT_BASE_URL
    } else {
        model.base_url.trim_end_matches('/')
    };
    format!("{base}/models/{}:streamGenerateContent?alt=sse", model.id)
}

/// The HTTP body the SDK sends for `params`: the system instruction as a user content, the
/// generation settings in `generationConfig`.
pub fn wire_body(params: &Value) -> Value {
    let config = &params["config"];
    let mut body = Map::new();
    body.insert("contents".into(), params["contents"].clone());
    if let Some(Value::String(instruction)) = config.get("systemInstruction") {
        body.insert(
            "systemInstruction".into(),
            json!({ "parts": [{ "text": instruction }], "role": "user" }),
        );
    }
    for field in ["tools", "toolConfig"] {
        if let Some(value) = config.get(field) {
            body.insert(field.into(), value.clone());
        }
    }
    let mut generation = Map::new();
    for field in ["temperature", "maxOutputTokens", "thinkingConfig"] {
        if let Some(value) = config.get(field) {
            generation.insert(field.into(), value.clone());
        }
    }
    body.insert("generationConfig".into(), Value::Object(generation));
    Value::Object(body)
}
