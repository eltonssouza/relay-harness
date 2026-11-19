//! Reading an OpenAI Chat Completions stream into events and an assistant message, as the
//! OpenAI SDK parses the server-sent events and the chunk loop of `stream()` in
//! `packages/ai/src/api/openai-completions.ts` handles them.
//!
//! Unlike the other adapters, a response has at most one text block and one thinking block:
//! every text and reasoning delta goes into them, and the blocks end together when the stream
//! does. Feed the body with `push` and call `finish` at its end; the last event is `Done` or
//! `Error`.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::event::AssistantEvent;
use crate::json::parse_streaming_json;
use crate::message::{
    AssistantMessage, Cost, Message, OutputBlock, StopReason, TextContent, ThinkingContent,
    ToolCall, Usage,
};
use crate::model::{calculate_cost, Model};
use crate::openai_sdk::{
    is_truthy, js_string, sdk_message, token_count, GrammarInput, SdkError, SdkMessage,
};
use crate::sse::{ServerSentEvent, SseDecoder};
use crate::strict::grammar_tool_input_properties;
use crate::transcript::{declared_tools, resolve_transcript};

const REASONING_FIELDS: [&str; 3] = ["reasoning_content", "reasoning", "reasoning_text"];

/// A tool call while it streams: its content index, stream index, the argument JSON so far, or
/// its grammar input.
#[derive(Debug)]
struct ToolState {
    content_index: usize,
    stream_index: Option<i64>,
    partial_args: Option<String>,
    grammar: Option<GrammarInput>,
}

pub struct OpenAICompletionsStream {
    model: Model,
    supports_finish_reason: bool,
    grammar_properties: Vec<(String, String)>,
    output: AssistantMessage,
    text: Option<usize>,
    thinking: Option<usize>,
    tools: Vec<ToolState>,
    by_index: HashMap<i64, usize>,
    by_id: HashMap<String, usize>,
    /// Streamed reasoning details, saved as the thinking signature when the block ends.
    reasoning_details: Option<Vec<Value>>,
    has_finish_reason: bool,
    sse: SseDecoder,
    sentinel: bool,
    finished: bool,
}

/// A reasoning detail the adapter keeps: a summary, encrypted data or text, with optional id,
/// format and index fields of the right types.
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

/// `target[key] = source[key]`: a missing source value leaves the key without a value, which
/// JSON omits.
fn assign(target: &mut Map<String, Value>, key: &str, source: &Value) {
    match source.get(key) {
        Some(value) => {
            target.insert(key.to_string(), value.clone());
        }
        None => {
            target.shift_remove(key);
        }
    }
}

fn is_nullish(value: Option<&Value>) -> bool {
    value.is_none_or(Value::is_null)
}

/// `id ??=`, `format ||=`, `index ??=` from the next delta of the same entry.
fn fill_common_fields(target: &mut Map<String, Value>, source: &Value) {
    if is_nullish(target.get("id")) {
        assign(target, "id", source);
    }
    if !target.get("format").is_some_and(is_truthy) {
        assign(target, "format", source);
    }
    if is_nullish(target.get("index")) {
        assign(target, "index", source);
    }
}

/// Consecutive text or summary deltas merge into one entry; encrypted entries stay discrete.
fn append_reasoning_detail(details: &mut Vec<Value>, detail: &Value) {
    let kind = detail.get("type").and_then(Value::as_str);
    if let Some(Value::Object(last)) = details.last_mut() {
        let last_kind = last.get("type").and_then(Value::as_str);
        for (merged, field) in [("reasoning.text", "text"), ("reasoning.summary", "summary")] {
            if kind == Some(merged) && last_kind == Some(merged) {
                let joined = format!(
                    "{}{}",
                    last.get(field).and_then(Value::as_str).unwrap_or_default(),
                    detail
                        .get(field)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                );
                last.insert(field.to_string(), json!(joined));
                if field == "text" && !last.get("signature").is_some_and(is_truthy) {
                    assign(last, "signature", detail);
                }
                fill_common_fields(last, detail);
                return;
            }
        }
    }
    details.push(detail.clone());
}

/// The usage a chunk reports (`parseChunkUsage`). Servers put cache hits in different places:
/// `prompt_tokens_details.cached_tokens` (OpenAI, OpenRouter), `prompt_cache_hit_tokens`
/// (DeepSeek) or a top-level `cached_tokens` (Kimi).
fn chunk_usage(raw: &Value, model: &Model) -> Usage {
    let details = raw.get("prompt_tokens_details");
    let cache_read = [
        details.and_then(|details| details.get("cached_tokens")),
        raw.get("prompt_cache_hit_tokens"),
        raw.get("cached_tokens"),
    ]
    .into_iter()
    .find(|value| !is_nullish(*value))
    .map_or(0, token_count);
    let cache_write = token_count(details.and_then(|details| details.get("cache_write_tokens")));
    let prompt = token_count(raw.get("prompt_tokens"));
    let input = prompt.saturating_sub(cache_read + cache_write);
    let output = token_count(raw.get("completion_tokens"));
    let mut usage = Usage {
        input,
        output,
        cache_read,
        cache_write,
        cache_write_1h: None,
        reasoning: Some(token_count(
            raw.get("completion_tokens_details")
                .and_then(|details| details.get("reasoning_tokens")),
        )),
        total_tokens: input + output + cache_read + cache_write,
        cost: Cost {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            total: 0.0,
        },
    };
    calculate_cost(&model.cost.clone().unwrap_or_default(), &mut usage);
    usage
}

fn map_stop_reason(reason: &str) -> (StopReason, Option<String>) {
    match reason {
        "stop" | "end" => (StopReason::Stop, None),
        "length" => (StopReason::Length, None),
        "function_call" | "tool_calls" => (StopReason::ToolUse, None),
        other => (
            StopReason::Error,
            Some(format!("Provider finish_reason: {other}")),
        ),
    }
}

impl OpenAICompletionsStream {
    /// `messages` is the request's transcript, whose grammar tools name the property their
    /// input fills. Fails where the request would: a grammar tool that cannot be used.
    pub fn new(model: &Model, messages: &[Message], clock: fn() -> u64) -> Result<Self, String> {
        let compat = model.compat();
        let resolved = resolve_transcript(
            messages,
            compat.supports_mid_convo_system_messages.unwrap_or(false),
        );
        let grammar_properties = grammar_tool_input_properties(
            &declared_tools(&resolved),
            compat.supports_openai_grammar_tools.unwrap_or(false),
        )?;
        Ok(OpenAICompletionsStream {
            model: model.clone(),
            supports_finish_reason: compat.supports_finish_reason.unwrap_or(true),
            grammar_properties,
            output: AssistantMessage {
                content: Vec::new(),
                api: model.api.clone(),
                provider: model.provider.clone(),
                model: model.id.clone(),
                response_model: None,
                response_id: None,
                provider_thinking_level: None,
                thinking_level: None,
                diagnostics: None,
                usage: Usage {
                    input: 0,
                    output: 0,
                    cache_read: 0,
                    cache_write: 0,
                    cache_write_1h: None,
                    reasoning: None,
                    total_tokens: 0,
                    cost: Cost {
                        input: 0.0,
                        output: 0.0,
                        cache_read: 0.0,
                        cache_write: 0.0,
                        total: 0.0,
                    },
                },
                stop_reason: StopReason::Pending,
                deferred: None,
                error_message: None,
                raw_stop_reason: None,
                end_turn: None,
                timestamp: clock(),
            },
            text: None,
            thinking: None,
            tools: Vec::new(),
            by_index: HashMap::new(),
            by_id: HashMap::new(),
            reasoning_details: None,
            has_finish_reason: false,
            sse: SseDecoder::joining_split_crlf(),
            sentinel: false,
            finished: false,
        })
    }

    /// The first event, sent once the response arrives.
    pub fn start(&self) -> AssistantEvent {
        AssistantEvent::Start
    }

    pub fn push(&mut self, bytes: &[u8]) -> Vec<AssistantEvent> {
        if self.finished {
            return Vec::new();
        }
        let events = self.sse.push(bytes);
        self.handle(events, false)
    }

    pub fn finish(&mut self) -> Vec<AssistantEvent> {
        if self.finished {
            return Vec::new();
        }
        let events = self.sse.finish();
        self.handle(events, true)
    }

    fn handle(&mut self, events: Vec<ServerSentEvent>, last: bool) -> Vec<AssistantEvent> {
        let mut emitted = Vec::new();
        let result = (|| {
            for event in events {
                if self.sentinel {
                    break;
                }
                match sdk_message(&event)? {
                    SdkMessage::Sentinel => self.sentinel = true,
                    SdkMessage::Ignored => {}
                    SdkMessage::Data(chunk) => self.chunk(&chunk, &mut emitted)?,
                }
            }
            if last {
                self.end(&mut emitted)?;
            }
            Ok::<(), SdkError>(())
        })();
        if let Err(error) = result {
            self.finished = true;
            self.apply_reasoning_details();
            self.output.stop_reason = StopReason::Error;
            let mut message = error.message;
            // OpenRouter gives the upstream provider's answer in metadata.raw.
            if let Some(raw) = error
                .error
                .as_ref()
                .and_then(|error| error.get("metadata"))
                .and_then(|metadata| metadata.get("raw"))
                .filter(|raw| is_truthy(raw))
            {
                let raw = js_string(raw);
                if !message.contains(&raw) {
                    message = format!("{message}\n{raw}");
                }
            }
            self.output.error_message = Some(message);
            emitted.push(AssistantEvent::Error {
                reason: StopReason::Error,
                error: Message::Assistant(Box::new(self.output.clone())),
            });
        }
        emitted
    }

    fn apply_reasoning_details(&mut self) {
        let (Some(index), Some(details)) = (self.thinking, &self.reasoning_details) else {
            return;
        };
        if let OutputBlock::Thinking(thinking) = &mut self.output.content[index] {
            thinking.thinking_signature = Some(Value::Array(details.clone()).to_string());
        }
    }

    /// End every block in content order, then check the stop reason.
    fn end(&mut self, emitted: &mut Vec<AssistantEvent>) -> Result<(), SdkError> {
        for index in 0..self.output.content.len() {
            let text = match &self.output.content[index] {
                OutputBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            };
            if let Some(content) = text {
                emitted.push(AssistantEvent::TextEnd {
                    content_index: index,
                    content,
                });
            } else if matches!(self.output.content[index], OutputBlock::Thinking(_)) {
                self.apply_reasoning_details();
                if let OutputBlock::Thinking(thinking) = &self.output.content[index] {
                    emitted.push(AssistantEvent::ThinkingEnd {
                        content_index: index,
                        content: thinking.thinking.clone(),
                    });
                }
            } else {
                self.end_tool_call(index, emitted)?;
            }
        }
        if !self.has_finish_reason && !self.supports_finish_reason {
            let has_tool_call = self
                .output
                .content
                .iter()
                .any(|block| matches!(block, OutputBlock::ToolCall(_)));
            self.output.stop_reason = if has_tool_call {
                StopReason::ToolUse
            } else {
                StopReason::Stop
            };
        }
        if self.output.stop_reason == StopReason::Error {
            return Err(self
                .output
                .error_message
                .clone()
                .filter(|message| !message.is_empty())
                .unwrap_or_else(|| "Provider returned an error stop reason".into())
                .into());
        }
        if (self.supports_finish_reason && !self.has_finish_reason)
            || self.output.stop_reason == StopReason::Pending
        {
            return Err("Stream ended without finish_reason".to_string().into());
        }
        self.finished = true;
        emitted.push(AssistantEvent::Done {
            reason: self.output.stop_reason,
            message: Message::Assistant(Box::new(self.output.clone())),
        });
        Ok(())
    }

    fn end_tool_call(
        &mut self,
        index: usize,
        emitted: &mut Vec<AssistantEvent>,
    ) -> Result<(), SdkError> {
        let Some(state) = self
            .tools
            .iter_mut()
            .find(|tool| tool.content_index == index)
        else {
            return Ok(());
        };
        if let Some(grammar) = state.grammar.as_mut() {
            let property = grammar.property.clone();
            let current = match &self.output.content[index] {
                OutputBlock::ToolCall(call) => call
                    .arguments
                    .get(&property)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                _ => String::new(),
            };
            let delta = grammar.append(&current, true)?;
            if let OutputBlock::ToolCall(call) = &mut self.output.content[index] {
                let mut arguments = Map::new();
                arguments.insert(property, json!(current));
                call.arguments = arguments;
            }
            if let Some(delta) = delta {
                emitted.push(AssistantEvent::ToolcallDelta {
                    content_index: index,
                    delta,
                });
            }
        } else {
            let parsed = parse_streaming_json(state.partial_args.as_deref().unwrap_or_default());
            if let OutputBlock::ToolCall(call) = &mut self.output.content[index] {
                call.arguments = parsed.as_object().cloned().unwrap_or_default();
            }
        }
        emitted.push(AssistantEvent::ToolcallEnd {
            content_index: index,
            tool_call: self.output.content[index].clone(),
        });
        Ok(())
    }

    fn chunk(&mut self, chunk: &Value, emitted: &mut Vec<AssistantEvent>) -> Result<(), SdkError> {
        if !chunk.is_object() {
            return Ok(());
        }
        if self.output.response_id.as_deref().is_none_or(str::is_empty) {
            if let Some(id) = chunk.get("id").and_then(Value::as_str) {
                self.output.response_id = Some(id.to_string());
            }
        }
        if let Some(response_model) = chunk
            .get("model")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty() && *name != self.model.id)
        {
            if self
                .output
                .response_model
                .as_deref()
                .is_none_or(str::is_empty)
            {
                self.output.response_model = Some(response_model.to_string());
            }
        }
        let chunk_usage_value = chunk.get("usage").filter(|usage| is_truthy(usage));
        if let Some(usage) = chunk_usage_value {
            self.output.usage = chunk_usage(usage, &self.model);
        }
        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return Ok(());
        };
        if !is_truthy(choice) {
            return Ok(());
        }
        // Some servers (Moonshot) report usage inside the choice.
        if chunk_usage_value.is_none() {
            if let Some(usage) = choice.get("usage").filter(|usage| is_truthy(usage)) {
                self.output.usage = chunk_usage(usage, &self.model);
            }
        }
        if let Some(reason) = choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .filter(|reason| !reason.is_empty())
        {
            self.output.raw_stop_reason = Some(reason.to_string());
            let (stop_reason, error_message) = map_stop_reason(reason);
            self.output.stop_reason = stop_reason;
            if error_message.is_some() {
                self.output.error_message = error_message;
            }
            self.has_finish_reason = true;
        }
        let Some(delta) = choice.get("delta").filter(|delta| is_truthy(delta)) else {
            return Ok(());
        };
        if let Some(content) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|content| !content.is_empty())
        {
            let index = self.text_block(emitted);
            if let OutputBlock::Text(text) = &mut self.output.content[index] {
                text.text.push_str(content);
            }
            emitted.push(AssistantEvent::TextDelta {
                content_index: index,
                delta: content.to_string(),
            });
        }
        // Servers name the reasoning field differently; the first non-empty one counts (chutes
        // sends two with the same text).
        if let Some((field, reasoning)) = REASONING_FIELDS.iter().find_map(|field| {
            delta
                .get(*field)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(|text| (*field, text))
        }) {
            let signature = if self.model.provider == "opencode-go" && field == "reasoning" {
                "reasoning_content"
            } else {
                field
            };
            let index = self.thinking_block(signature, emitted);
            if let OutputBlock::Thinking(thinking) = &mut self.output.content[index] {
                thinking.thinking.push_str(reasoning);
            }
            emitted.push(AssistantEvent::ThinkingDelta {
                content_index: index,
                delta: reasoning.to_string(),
            });
        }
        if let Some(calls) = delta.get("tool_calls").filter(|calls| is_truthy(calls)) {
            for call in calls.as_array().into_iter().flatten() {
                self.tool_call_delta(call, emitted)?;
            }
        }
        if let Some(details) = delta.get("reasoning_details").and_then(Value::as_array) {
            for detail in details.iter().filter(|detail| is_reasoning_detail(detail)) {
                self.thinking_block("", emitted);
                append_reasoning_detail(
                    self.reasoning_details.get_or_insert_with(Vec::new),
                    detail,
                );
            }
        }
        Ok(())
    }

    fn text_block(&mut self, emitted: &mut Vec<AssistantEvent>) -> usize {
        if let Some(index) = self.text {
            return index;
        }
        self.output.content.push(OutputBlock::Text(TextContent {
            text: String::new(),
            text_signature: None,
            volatile: None,
        }));
        let index = self.output.content.len() - 1;
        self.text = Some(index);
        emitted.push(AssistantEvent::TextStart {
            content_index: index,
        });
        index
    }

    fn thinking_block(&mut self, signature: &str, emitted: &mut Vec<AssistantEvent>) -> usize {
        if let Some(index) = self.thinking {
            return index;
        }
        self.output
            .content
            .push(OutputBlock::Thinking(ThinkingContent {
                thinking: String::new(),
                thinking_signature: Some(signature.to_string()),
                redacted: None,
            }));
        let index = self.output.content.len() - 1;
        self.thinking = Some(index);
        emitted.push(AssistantEvent::ThinkingStart {
            content_index: index,
        });
        index
    }

    fn call_mut(&mut self, content_index: usize) -> &mut ToolCall {
        match &mut self.output.content[content_index] {
            OutputBlock::ToolCall(call) => call,
            _ => unreachable!("tool states point at tool calls"),
        }
    }

    fn grammar_property(&self, name: &str) -> String {
        self.grammar_properties
            .iter()
            .find(|(tool, _)| tool == name)
            .map_or_else(|| "input".to_string(), |(_, property)| property.clone())
    }

    /// The tool call a delta belongs to (`ensureToolCallBlock`): by stream index, else by id,
    /// else a new one.
    fn tool_block(&mut self, call: &Value, emitted: &mut Vec<AssistantEvent>) -> usize {
        let stream_index = call.get("index").and_then(Value::as_i64);
        let id = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        let function = call.get("function").filter(|function| is_truthy(function));
        let custom = call.get("custom").filter(|custom| is_truthy(custom));
        let name = function
            .and_then(|function| function.get("name"))
            .filter(|name| !name.is_null())
            .or_else(|| custom.and_then(|custom| custom.get("name")))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let custom_only = custom.is_some() && function.is_none();
        let found = stream_index
            .and_then(|stream_index| self.by_index.get(&stream_index).copied())
            .or_else(|| id.as_ref().and_then(|id| self.by_id.get(id).copied()));
        let slot = match found {
            Some(slot) => slot,
            None => {
                let property = custom_only.then(|| self.grammar_property(&name));
                let mut arguments = Map::new();
                if let Some(property) = &property {
                    arguments.insert(property.clone(), json!(""));
                }
                self.output.content.push(OutputBlock::ToolCall(ToolCall {
                    id: id.clone().unwrap_or_default(),
                    name: name.clone(),
                    arguments,
                    thought_signature: None,
                    namespace: None,
                }));
                let content_index = self.output.content.len() - 1;
                self.tools.push(ToolState {
                    content_index,
                    stream_index,
                    partial_args: property.is_none().then(String::new),
                    grammar: property.map(GrammarInput::new),
                });
                let slot = self.tools.len() - 1;
                if let Some(stream_index) = stream_index {
                    self.by_index.insert(stream_index, slot);
                }
                if let Some(id) = &id {
                    self.by_id.insert(id.clone(), slot);
                }
                emitted.push(AssistantEvent::ToolcallStart { content_index });
                slot
            }
        };
        if let Some(stream_index) = stream_index {
            if self.tools[slot].stream_index.is_none() {
                self.tools[slot].stream_index = Some(stream_index);
                self.by_index.insert(stream_index, slot);
            }
        }
        if let Some(id) = &id {
            self.by_id.insert(id.clone(), slot);
        }
        let content_index = self.tools[slot].content_index;
        if self.call_mut(content_index).name.is_empty() && !name.is_empty() {
            self.call_mut(content_index).name = name;
        }
        if custom_only && self.tools[slot].grammar.is_none() {
            let tool_name = self.call_mut(content_index).name.clone();
            let property = self.grammar_property(&tool_name);
            let mut arguments = Map::new();
            arguments.insert(property.clone(), json!(""));
            self.call_mut(content_index).arguments = arguments;
            self.tools[slot].grammar = Some(GrammarInput::new(property));
            self.tools[slot].partial_args = None;
        }
        slot
    }

    fn tool_call_delta(
        &mut self,
        call: &Value,
        emitted: &mut Vec<AssistantEvent>,
    ) -> Result<(), SdkError> {
        let slot = self.tool_block(call, emitted);
        let content_index = self.tools[slot].content_index;
        if let Some(id) = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            if self.call_mut(content_index).id.is_empty() {
                self.call_mut(content_index).id = id.to_string();
                self.by_id.insert(id.to_string(), slot);
            }
        }
        let name = call
            .get("function")
            .and_then(|function| function.get("name"))
            .filter(|name| !name.is_null())
            .or_else(|| call.get("custom").and_then(|custom| custom.get("name")))
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty());
        if let Some(name) = name {
            if self.call_mut(content_index).name.is_empty() {
                self.call_mut(content_index).name = name.to_string();
            }
        }
        let arguments_delta = call
            .get("function")
            .and_then(|function| function.get("arguments"))
            .and_then(Value::as_str)
            .filter(|arguments| !arguments.is_empty());
        let input_delta = call
            .get("custom")
            .and_then(|custom| custom.get("input"))
            .and_then(Value::as_str)
            .filter(|input| !input.is_empty());
        let mut delta = String::new();
        if let Some(arguments) = arguments_delta {
            delta = arguments.to_string();
            let state = &mut self.tools[slot];
            let partial = state.partial_args.get_or_insert_with(String::new);
            partial.push_str(arguments);
            let parsed = parse_streaming_json(partial);
            self.call_mut(content_index).arguments =
                parsed.as_object().cloned().unwrap_or_default();
        } else if let Some(input) = input_delta {
            if self.tools[slot].grammar.is_some() {
                let property = self.tools[slot]
                    .grammar
                    .as_ref()
                    .map(|grammar| grammar.property.clone())
                    .unwrap_or_default();
                let current = self
                    .call_mut(content_index)
                    .arguments
                    .get(&property)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let next = format!("{current}{input}");
                let appended = self.tools[slot]
                    .grammar
                    .as_mut()
                    .map(|grammar| grammar.append(&next, false))
                    .transpose()?
                    .flatten();
                let mut arguments = Map::new();
                arguments.insert(property, json!(next));
                self.call_mut(content_index).arguments = arguments;
                delta = appended.unwrap_or_default();
            }
        }
        emitted.push(AssistantEvent::ToolcallDelta {
            content_index,
            delta,
        });
        Ok(())
    }
}
