//! Reading an OpenAI Responses stream into events and an assistant message, as the OpenAI SDK
//! (7.19.0, `Stream.fromSSEResponse`) parses the server-sent events and `processResponsesStream`
//! in `packages/ai/src/api/openai-responses-shared.ts` handles them.
//!
//! Feed the response body with `push` as it arrives and call `finish` when it ends. Each call
//! returns the events it completed; the last one is `Done` or `Error`.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::event::AssistantEvent;
use crate::json::parse_streaming_json;
use crate::message::{
    AssistantMessage, Cost, Message, OutputBlock, StopReason, TextContent, ThinkingContent,
    ToolCall, Usage,
};
use crate::model::{calculate_cost, Model};
use crate::sse::{ServerSentEvent, SseDecoder};
use crate::strict::grammar_tool_input_properties;
use crate::transcript::{declared_tools, resolve_transcript};

const CHATGPT_USAGE_URL: &str = "https://chatgpt.com/settings/usage";

/// The JSON-encoded deltas of a grammar tool's input, as `appendGrammarToolInputJsonDelta` writes
/// them: `{"<property>":"` first, the escaped input as it grows, `"}` when it closes.
#[derive(Debug, Default)]
struct GrammarInput {
    property: String,
    input: String,
    started: bool,
    closed: bool,
}

impl GrammarInput {
    fn append(&mut self, next_input: &str, close: bool) -> Result<Option<String>, String> {
        if self.closed {
            if close && next_input == self.input {
                return Ok(None);
            }
            return Err(format!(
                "grammar tool input for property \"{}\" changed after it was closed",
                self.property
            ));
        }
        if !next_input.starts_with(&self.input) {
            return Err(format!(
                "grammar tool input for property \"{}\" changed non-monotonically",
                self.property
            ));
        }
        let input_delta = &next_input[self.input.len()..];
        if !close && input_delta.is_empty() {
            return Ok(None);
        }
        let mut delta = String::new();
        if !self.started {
            delta.push('{');
            delta.push_str(&json!(self.property).to_string());
            delta.push_str(":\"");
            self.started = true;
        }
        let escaped = json!(input_delta).to_string();
        delta.push_str(&escaped[1..escaped.len() - 1]);
        self.input = next_input.to_string();
        if close {
            delta.push_str("\"}");
            self.closed = true;
        }
        Ok(Some(delta))
    }
}

/// What an open output item streams into.
#[derive(Debug)]
enum Slot {
    Thinking(usize),
    Text(usize),
    /// A tool call: the content index, its argument JSON so far (function calls) or its grammar
    /// input (custom tool calls). Both are dropped when the item finishes.
    ToolCall {
        index: usize,
        partial_json: Option<String>,
        grammar: Option<GrammarInput>,
    },
}

pub struct OpenAIResponsesStream {
    model: Model,
    service_tier: Option<Value>,
    grammar_properties: Vec<(String, String)>,
    output: AssistantMessage,
    slots: HashMap<i64, Slot>,
    /// Tool calls whose item never finished, by content index.
    unfinished: Vec<usize>,
    reasoning_by_id: HashMap<String, usize>,
    sse: SseDecoder,
    saw_terminal: bool,
    sentinel: bool,
    finished: bool,
}

fn text_of(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// `` `${value}` `` for an id part: `undefined` when it is missing.
fn template(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".into(),
        Some(other) => other.to_string(),
    }
}

fn token_count(value: Option<&Value>) -> u64 {
    value
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_f64().map(|float| float as u64))
        })
        .unwrap_or(0)
}

/// `APIError.makeMessage` for an error object without an HTTP status.
fn api_error_message(error: &Value) -> String {
    match error.get("message") {
        Some(Value::String(message)) if !message.is_empty() => message.clone(),
        Some(message) if is_truthy(message) => message.to_string(),
        _ if is_truthy(error) => error.to_string(),
        _ => "(no status code or body)".into(),
    }
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

fn map_stop_reason(
    status: Option<&str>,
    incomplete_reason: Option<&str>,
) -> Result<(StopReason, Option<String>), String> {
    Ok(match status {
        None | Some("") | Some("completed") | Some("in_progress") | Some("queued") => {
            (StopReason::Stop, None)
        }
        Some("incomplete") => match incomplete_reason {
            Some("max_output_tokens") => (StopReason::Length, None),
            Some(reason) => (
                StopReason::Error,
                Some(format!("Response incomplete: {reason}")),
            ),
            None => (
                StopReason::Error,
                Some("Response incomplete without a provider reason".into()),
            ),
        },
        Some("failed") | Some("cancelled") => (StopReason::Error, None),
        Some(other) => return Err(format!("Unhandled stop reason: {other}")),
    })
}

fn service_tier_multiplier(model_id: &str, tier: Option<&str>) -> f64 {
    match tier {
        Some("flex") => 0.5,
        Some("priority") | Some("fast") if model_id == "gpt-5.5" => 2.5,
        Some("priority") | Some("fast") => 2.0,
        _ => 1.0,
    }
}

impl OpenAIResponsesStream {
    /// `messages` is the request's transcript, whose grammar tools name the property their
    /// input fills; `service_tier` is the requested tier, which prices the response when it
    /// names none. Fails where the request would: a grammar tool that cannot be used.
    pub fn new(
        model: &Model,
        messages: &[Message],
        service_tier: Option<Value>,
        clock: fn() -> u64,
    ) -> Result<Self, String> {
        let compat = model.compat();
        let resolved = resolve_transcript(
            messages,
            compat.supports_mid_convo_system_messages.unwrap_or(false),
        );
        let grammar_properties = grammar_tool_input_properties(
            &declared_tools(&resolved),
            compat.supports_openai_grammar_tools.unwrap_or(false),
        )?;
        Ok(OpenAIResponsesStream {
            model: model.clone(),
            service_tier,
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
            slots: HashMap::new(),
            unfinished: Vec::new(),
            reasoning_by_id: HashMap::new(),
            sse: SseDecoder::joining_split_crlf(),
            saw_terminal: false,
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
                // The SDK stops reading at the completion sentinel.
                if self.sentinel {
                    break;
                }
                self.message(&event, &mut emitted)?;
            }
            if last {
                self.end(&mut emitted)?;
            }
            Ok::<(), String>(())
        })();
        if let Err(message) = result {
            self.finished = true;
            self.output.stop_reason = StopReason::Error;
            // A ChatGPT sign-in shares its usage limit with other apps.
            self.output.error_message = Some(
                if message.contains("subscription_sharing_usage_limit_exceeded") {
                    format!("{message}\nCheck your ChatGPT usage: {CHATGPT_USAGE_URL}")
                } else {
                    message
                },
            );
            emitted.push(AssistantEvent::Error {
                reason: StopReason::Error,
                error: Message::Assistant(Box::new(self.output.clone())),
            });
        }
        emitted
    }

    /// One server-sent event as the SDK delivers it.
    fn message(
        &mut self,
        sse: &ServerSentEvent,
        emitted: &mut Vec<AssistantEvent>,
    ) -> Result<(), String> {
        if sse.data == "[DONE]" {
            self.sentinel = true;
            return Ok(());
        }
        let data: Value = serde_json::from_str(&sse.data)
            .map_err(|_| "Error reading response: malformed server-sent event JSON.".to_string())?;
        let named = sse.event.as_deref();
        if named.is_some_and(|name| name.starts_with("thread.")) {
            return Ok(());
        }
        if named == Some("error") {
            let error = data
                .get("error")
                .filter(|error| !error.is_null())
                .unwrap_or(&data);
            return Err(api_error_message(error));
        }
        if let Some(error) = data.get("error").filter(|error| is_truthy(error)) {
            return Err(api_error_message(error));
        }
        self.event(&data, emitted)
    }

    fn end(&mut self, emitted: &mut Vec<AssistantEvent>) -> Result<(), String> {
        if !self.saw_terminal {
            return Err("OpenAI Responses stream ended before a terminal response event".into());
        }
        // The agent runs every tool call in the final message, so a call whose item never
        // finished (its arguments may be cut off) is refused.
        if self.output.stop_reason == StopReason::ToolUse {
            if let Some(&index) = self.unfinished.first() {
                if let OutputBlock::ToolCall(call) = &self.output.content[index] {
                    return Err(format!(
                        "OpenAI Responses stream completed with an unfinished tool call: {} ({})",
                        call.name, call.id
                    ));
                }
            }
        }
        if self.output.stop_reason == StopReason::Pending {
            return Err("OpenAI Responses stream ended without a stop reason".into());
        }
        if matches!(
            self.output.stop_reason,
            StopReason::Aborted | StopReason::Error
        ) {
            return Err(self
                .output
                .error_message
                .clone()
                .filter(|message| !message.is_empty())
                .unwrap_or_else(|| "An unknown error occurred".into()));
        }
        self.finished = true;
        emitted.push(AssistantEvent::Done {
            reason: self.output.stop_reason,
            message: Message::Assistant(Box::new(self.output.clone())),
        });
        Ok(())
    }

    fn push_block(&mut self, block: OutputBlock) -> usize {
        self.output.content.push(block);
        self.output.content.len() - 1
    }

    fn final_answer(&mut self, item: &Value) {
        if item.get("type").and_then(Value::as_str) == Some("message")
            && item.get("phase").and_then(Value::as_str) == Some("final_answer")
        {
            self.output.stop_reason = StopReason::Stop;
        }
    }

    fn create_slot(
        &mut self,
        output_index: i64,
        item: &Value,
        emitted: &mut Vec<AssistantEvent>,
    ) -> bool {
        let namespace = item
            .get("namespace")
            .map(|namespace| template(Some(namespace)));
        let id = format!(
            "{}|{}",
            template(item.get("call_id")),
            template(item.get("id"))
        );
        let slot = match item.get("type").and_then(Value::as_str) {
            Some("reasoning") => {
                let index = self.push_block(OutputBlock::Thinking(ThinkingContent {
                    thinking: String::new(),
                    thinking_signature: None,
                    redacted: None,
                }));
                emitted.push(AssistantEvent::ThinkingStart {
                    content_index: index,
                });
                Slot::Thinking(index)
            }
            Some("message") => {
                self.final_answer(item);
                let index = self.push_block(OutputBlock::Text(TextContent {
                    text: String::new(),
                    text_signature: None,
                    volatile: None,
                }));
                emitted.push(AssistantEvent::TextStart {
                    content_index: index,
                });
                Slot::Text(index)
            }
            Some("function_call") => {
                let index = self.push_block(OutputBlock::ToolCall(ToolCall {
                    id,
                    name: text_of(item, "name"),
                    arguments: Map::new(),
                    thought_signature: None,
                    namespace,
                }));
                self.unfinished.push(index);
                emitted.push(AssistantEvent::ToolcallStart {
                    content_index: index,
                });
                Slot::ToolCall {
                    index,
                    partial_json: Some(text_of(item, "arguments")),
                    grammar: None,
                }
            }
            Some("custom_tool_call") => {
                let name = text_of(item, "name");
                let property = self
                    .grammar_properties
                    .iter()
                    .find(|(tool, _)| *tool == name)
                    .map_or_else(|| "input".to_string(), |(_, property)| property.clone());
                let mut arguments = Map::new();
                arguments.insert(property.clone(), json!(text_of(item, "input")));
                let index = self.push_block(OutputBlock::ToolCall(ToolCall {
                    id,
                    name,
                    arguments,
                    thought_signature: None,
                    namespace,
                }));
                self.unfinished.push(index);
                emitted.push(AssistantEvent::ToolcallStart {
                    content_index: index,
                });
                Slot::ToolCall {
                    index,
                    partial_json: None,
                    grammar: Some(GrammarInput {
                        property,
                        ..GrammarInput::default()
                    }),
                }
            }
            _ => return false,
        };
        self.slots.insert(output_index, slot);
        true
    }

    fn tool_call(&mut self, index: usize) -> Option<&mut ToolCall> {
        match self.output.content.get_mut(index) {
            Some(OutputBlock::ToolCall(call)) => Some(call),
            _ => None,
        }
    }

    /// Feed a grammar tool's whole input so far; returns the JSON delta to emit.
    fn grammar_input(
        &mut self,
        output_index: i64,
        next_input: &str,
        close: bool,
    ) -> Result<Option<String>, String> {
        let Some(Slot::ToolCall {
            index,
            grammar: Some(grammar),
            ..
        }) = self.slots.get_mut(&output_index)
        else {
            return Ok(None);
        };
        let index = *index;
        let property = grammar.property.clone();
        let delta = grammar.append(next_input, close)?;
        if let Some(call) = self.tool_call(index) {
            let mut arguments = Map::new();
            arguments.insert(property, json!(next_input));
            call.arguments = arguments;
        }
        Ok(delta)
    }

    fn grammar_current(&self, output_index: i64) -> String {
        let Some(Slot::ToolCall {
            index,
            grammar: Some(grammar),
            ..
        }) = self.slots.get(&output_index)
        else {
            return String::new();
        };
        match self.output.content.get(*index) {
            Some(OutputBlock::ToolCall(call)) => call
                .arguments
                .get(&grammar.property)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            _ => String::new(),
        }
    }

    fn event(&mut self, event: &Value, emitted: &mut Vec<AssistantEvent>) -> Result<(), String> {
        let output_index = event
            .get("output_index")
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        let delta = text_of(event, "delta");
        match event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "response.created" => {
                self.output.response_id = event["response"]
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            "response.output_item.added" => {
                self.create_slot(output_index, &event["item"], emitted);
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                self.append_thinking(output_index, &delta, emitted);
            }
            "response.reasoning_summary_part.done" => {
                self.append_thinking(output_index, "\n\n", emitted)
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                if let Some(Slot::Text(index)) = self.slots.get(&output_index) {
                    let index = *index;
                    if let OutputBlock::Text(text) = &mut self.output.content[index] {
                        text.text.push_str(&delta);
                    }
                    emitted.push(AssistantEvent::TextDelta {
                        content_index: index,
                        delta,
                    });
                }
            }
            "response.function_call_arguments.delta" => {
                if let Some(Slot::ToolCall {
                    index,
                    partial_json: Some(partial),
                    ..
                }) = self.slots.get_mut(&output_index)
                {
                    let index = *index;
                    partial.push_str(&delta);
                    let parsed = parse_streaming_json(partial);
                    if let Some(call) = self.tool_call(index) {
                        call.arguments = parsed.as_object().cloned().unwrap_or_default();
                    }
                    if event.get("delta").is_some() {
                        emitted.push(AssistantEvent::ToolcallDelta {
                            content_index: index,
                            delta,
                        });
                    }
                }
            }
            "response.function_call_arguments.done" => {
                if let Some(Slot::ToolCall {
                    index,
                    partial_json: Some(partial),
                    ..
                }) = self.slots.get_mut(&output_index)
                {
                    let index = *index;
                    let arguments = text_of(event, "arguments");
                    let previous = std::mem::replace(partial, arguments.clone());
                    let parsed = parse_streaming_json(&arguments);
                    if let Some(call) = self.tool_call(index) {
                        call.arguments = parsed.as_object().cloned().unwrap_or_default();
                    }
                    if let Some(rest) = arguments
                        .strip_prefix(previous.as_str())
                        .filter(|rest| !rest.is_empty())
                    {
                        emitted.push(AssistantEvent::ToolcallDelta {
                            content_index: index,
                            delta: rest.to_string(),
                        });
                    }
                }
            }
            "response.custom_tool_call_input.delta" => {
                if let Some(Slot::ToolCall {
                    index,
                    grammar: Some(_),
                    ..
                }) = self.slots.get(&output_index)
                {
                    let index = *index;
                    let next = format!("{}{delta}", self.grammar_current(output_index));
                    if let Some(json_delta) = self.grammar_input(output_index, &next, false)? {
                        emitted.push(AssistantEvent::ToolcallDelta {
                            content_index: index,
                            delta: json_delta,
                        });
                    }
                }
            }
            "response.custom_tool_call_input.done" => {
                if let Some(Slot::ToolCall {
                    index,
                    grammar: Some(_),
                    ..
                }) = self.slots.get(&output_index)
                {
                    let index = *index;
                    let input = text_of(event, "input");
                    if let Some(json_delta) = self.grammar_input(output_index, &input, true)? {
                        emitted.push(AssistantEvent::ToolcallDelta {
                            content_index: index,
                            delta: json_delta,
                        });
                    }
                }
            }
            "response.output_item.done" => self.item_done(output_index, &event["item"], emitted)?,
            "response.completed" | "response.incomplete" => self.finalize(&event["response"])?,
            "error" => {
                return Err(format!(
                    "Error Code {}: {}",
                    template(event.get("code")),
                    template(event.get("message"))
                ));
            }
            "response.failed" => {
                self.saw_terminal = true;
                let response = &event["response"];
                self.output.raw_stop_reason = response
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let error = response.get("error").filter(|error| is_truthy(error));
                let reason = response
                    .get("incomplete_details")
                    .and_then(|details| details.get("reason"))
                    .filter(|reason| is_truthy(reason));
                return Err(match (error, reason) {
                    (Some(error), _) => {
                        let part = |field: &str, fallback: &str| match error.get(field) {
                            Some(value) if is_truthy(value) => template(Some(value)),
                            _ => fallback.to_string(),
                        };
                        format!(
                            "{}: {}",
                            part("code", "unknown"),
                            part("message", "no message")
                        )
                    }
                    (None, Some(reason)) => format!("incomplete: {}", template(Some(reason))),
                    (None, None) => "Unknown error (no error details in response)".into(),
                });
            }
            _ => {}
        }
        Ok(())
    }

    fn append_thinking(
        &mut self,
        output_index: i64,
        delta: &str,
        emitted: &mut Vec<AssistantEvent>,
    ) {
        if let Some(Slot::Thinking(index)) = self.slots.get(&output_index) {
            let index = *index;
            if let OutputBlock::Thinking(thinking) = &mut self.output.content[index] {
                thinking.thinking.push_str(delta);
            }
            emitted.push(AssistantEvent::ThinkingDelta {
                content_index: index,
                delta: delta.to_string(),
            });
        }
    }

    fn item_done(
        &mut self,
        output_index: i64,
        item: &Value,
        emitted: &mut Vec<AssistantEvent>,
    ) -> Result<(), String> {
        self.final_answer(item);
        if !self.slots.contains_key(&output_index) && !self.create_slot(output_index, item, emitted)
        {
            return Ok(());
        }
        let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
        let joined = |field: &str, text: &dyn Fn(&Value) -> String, separator: &str| {
            item.get(field)
                .and_then(Value::as_array)
                .map(|parts| parts.iter().map(text).collect::<Vec<_>>().join(separator))
                .unwrap_or_default()
        };
        match (kind, self.slots.get_mut(&output_index)) {
            ("reasoning", Some(Slot::Thinking(index))) => {
                let index = *index;
                let summary = joined("summary", &|part| text_of(part, "text"), "\n\n");
                let content = joined("content", &|part| text_of(part, "text"), "\n\n");
                if let OutputBlock::Thinking(thinking) = &mut self.output.content[index] {
                    if !summary.is_empty() {
                        thinking.thinking = summary;
                    } else if !content.is_empty() {
                        thinking.thinking = content;
                    }
                    thinking.thinking_signature = Some(item.to_string());
                    emitted.push(AssistantEvent::ThinkingEnd {
                        content_index: index,
                        content: thinking.thinking.clone(),
                    });
                }
                if let Some(id) = item.get("id") {
                    self.reasoning_by_id.insert(template(Some(id)), index);
                }
                self.slots.remove(&output_index);
            }
            ("message", Some(Slot::Text(index))) => {
                let index = *index;
                let text = joined(
                    "content",
                    &|part| {
                        let field =
                            if part.get("type").and_then(Value::as_str) == Some("output_text") {
                                "text"
                            } else {
                                "refusal"
                            };
                        text_of(part, field)
                    },
                    "",
                );
                let mut signature = Map::new();
                signature.insert("v".into(), json!(1));
                if let Some(id) = item.get("id") {
                    signature.insert("id".into(), id.clone());
                }
                if let Some(phase) = item.get("phase").filter(|phase| is_truthy(phase)) {
                    signature.insert("phase".into(), phase.clone());
                }
                if let OutputBlock::Text(block) = &mut self.output.content[index] {
                    block.text = text;
                    block.text_signature = Some(Value::Object(signature).to_string());
                    emitted.push(AssistantEvent::TextEnd {
                        content_index: index,
                        content: block.text.clone(),
                    });
                }
                self.slots.remove(&output_index);
            }
            (
                "function_call",
                Some(Slot::ToolCall {
                    index,
                    partial_json: Some(partial),
                    ..
                }),
            ) => {
                let index = *index;
                let source = [text_of(item, "arguments"), partial.clone()]
                    .into_iter()
                    .find(|text| !text.is_empty())
                    .unwrap_or_else(|| "{}".into());
                let parsed = parse_streaming_json(&source);
                if let Some(call) = self.tool_call(index) {
                    call.arguments = parsed.as_object().cloned().unwrap_or_default();
                    if let Some(namespace) = item.get("namespace") {
                        call.namespace = Some(template(Some(namespace)));
                    }
                }
                self.finish_tool_call(output_index, index, emitted);
            }
            (
                "custom_tool_call",
                Some(Slot::ToolCall {
                    index,
                    grammar: Some(_),
                    ..
                }),
            ) => {
                let index = *index;
                let input = match item.get("input") {
                    Some(Value::Null) | None => self.grammar_current(output_index),
                    Some(input) => template(Some(input)),
                };
                if let Some(json_delta) = self.grammar_input(output_index, &input, true)? {
                    emitted.push(AssistantEvent::ToolcallDelta {
                        content_index: index,
                        delta: json_delta,
                    });
                }
                if let (Some(namespace), Some(call)) =
                    (item.get("namespace"), self.tool_call(index))
                {
                    call.namespace = Some(template(Some(namespace)));
                }
                self.finish_tool_call(output_index, index, emitted);
            }
            _ => {}
        }
        Ok(())
    }

    fn finish_tool_call(
        &mut self,
        output_index: i64,
        index: usize,
        emitted: &mut Vec<AssistantEvent>,
    ) {
        self.unfinished.retain(|open| *open != index);
        self.slots.remove(&output_index);
        emitted.push(AssistantEvent::ToolcallEnd {
            content_index: index,
            tool_call: self.output.content[index].clone(),
        });
    }

    fn finalize(&mut self, response: &Value) -> Result<(), String> {
        self.saw_terminal = true;
        // Some servers (Azure) send encrypted reasoning only in the terminal response.
        for item in response
            .get("output")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let encrypted = item
                .get("encrypted_content")
                .filter(|value| is_truthy(value));
            let (Some("reasoning"), Some(encrypted), Some(id)) = (
                item.get("type").and_then(Value::as_str),
                encrypted,
                item.get("id"),
            ) else {
                continue;
            };
            let Some(&index) = self.reasoning_by_id.get(&template(Some(id))) else {
                continue;
            };
            if let OutputBlock::Thinking(thinking) = &mut self.output.content[index] {
                let Some(signature) = thinking
                    .thinking_signature
                    .as_deref()
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                let mut stored: Map<String, Value> =
                    serde_json::from_str(signature).map_err(|error| error.to_string())?;
                if stored.get("encrypted_content").is_some_and(is_truthy) {
                    continue;
                }
                stored.insert("encrypted_content".into(), encrypted.clone());
                thinking.thinking_signature = Some(Value::Object(stored).to_string());
            }
        }
        if let Some(id) = response.get("id").filter(|id| is_truthy(id)) {
            self.output.response_id = Some(template(Some(id)));
        }
        if let Some(usage) = response.get("usage").filter(|usage| is_truthy(usage)) {
            let details = usage.get("input_tokens_details");
            let cached = token_count(details.and_then(|details| details.get("cached_tokens")));
            let cache_write =
                token_count(details.and_then(|details| details.get("cache_write_tokens")));
            let input = token_count(usage.get("input_tokens"));
            self.output.usage = Usage {
                // OpenAI counts cached and cache-write tokens in input_tokens.
                input: input.saturating_sub(cached + cache_write),
                output: token_count(usage.get("output_tokens")),
                cache_read: cached,
                cache_write,
                cache_write_1h: None,
                reasoning: Some(token_count(
                    usage
                        .get("output_tokens_details")
                        .and_then(|details| details.get("reasoning_tokens")),
                )),
                total_tokens: token_count(usage.get("total_tokens")),
                cost: Cost {
                    input: 0.0,
                    output: 0.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                    total: 0.0,
                },
            };
        }
        calculate_cost(
            &self.model.cost.clone().unwrap_or_default(),
            &mut self.output.usage,
        );
        let tier = response
            .get("service_tier")
            .filter(|tier| !tier.is_null())
            .or(self.service_tier.as_ref())
            .and_then(Value::as_str);
        let multiplier = service_tier_multiplier(&self.model.id, tier);
        if multiplier != 1.0 {
            let cost = &mut self.output.usage.cost;
            cost.input *= multiplier;
            cost.output *= multiplier;
            cost.cache_read *= multiplier;
            cost.cache_write *= multiplier;
            cost.total = cost.input + cost.output + cost.cache_read + cost.cache_write;
        }
        let status = response.get("status").and_then(Value::as_str);
        let reason = response
            .get("incomplete_details")
            .and_then(|details| details.get("reason"))
            .and_then(Value::as_str);
        self.output.raw_stop_reason = match (status, reason) {
            (Some(status), Some(reason)) if !reason.is_empty() => {
                Some(format!("{status}.{reason}"))
            }
            (None, Some(reason)) if !reason.is_empty() => Some(format!("undefined.{reason}")),
            (status, _) => status.map(str::to_string),
        };
        let (stop_reason, error_message) =
            map_stop_reason(status, reason.filter(|reason| !reason.is_empty()))?;
        self.output.stop_reason = stop_reason;
        self.output.error_message = error_message;
        if stop_reason == StopReason::Stop
            && self
                .output
                .content
                .iter()
                .any(|block| matches!(block, OutputBlock::ToolCall(_)))
        {
            self.output.stop_reason = StopReason::ToolUse;
        }
        Ok(())
    }
}
