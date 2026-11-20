//! Reading an Anthropic Messages response stream into events and an assistant message, as the
//! event loop of `stream()` in `packages/ai/src/api/anthropic-messages.ts` does.
//!
//! Feed the response body with `push` as it arrives and call `finish` when it ends. Each call
//! returns the events it completed; the last one is `Done` or `Error`. After an error the stream
//! ignores further input, as the TypeScript stream stops reading.

use serde_json::{json, Map, Value};

use crate::event::AssistantEvent;
use crate::json::{parse_json_with_repair, parse_streaming_json};
use crate::message::{
    AssistantMessage, Cost, Message, OutputBlock, StopReason, TextContent, ThinkingContent,
    ToolCall, Usage,
};
use crate::model::{calculate_cost, Model, ModelCost};
use crate::sse::{ServerSentEvent, SseDecoder};
use crate::transcript::{current_tools, resolve_transcript};

const MESSAGE_EVENTS: [&str; 6] = [
    "message_start",
    "message_delta",
    "message_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
];

/// Per content block: the provider's block index while the block is open, and the tool
/// arguments received so far.
#[derive(Debug, Default)]
struct BlockState {
    open_index: Option<u64>,
    partial_json: String,
}

pub struct AnthropicStream {
    model: Model,
    oauth: bool,
    tool_names: Vec<String>,
    output: AssistantMessage,
    blocks: Vec<BlockState>,
    usage_cost: ModelCost,
    sse: SseDecoder,
    saw_message_start: bool,
    saw_message_stop: bool,
    input_transformations: Option<Vec<Value>>,
    clock: fn() -> u64,
    finished: bool,
}

fn number(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_f64().map(|float| float as u64))
}

/// `value || 0` for a token count.
fn count_or_zero(value: Option<&Value>) -> u64 {
    value.and_then(number).unwrap_or(0)
}

/// Claude Code's tool name mapped back to the session's tool of the same name, ignoring case.
fn from_claude_code_name(name: &str, tools: &[String]) -> String {
    let lower = name.to_lowercase();
    tools
        .iter()
        .find(|tool| tool.to_lowercase() == lower)
        .cloned()
        .unwrap_or_else(|| name.to_string())
}

fn map_stop_reason(
    reason: &str,
    details: Option<&Value>,
) -> Result<(StopReason, Option<String>), String> {
    Ok(match reason {
        "end_turn" | "pause_turn" | "stop_sequence" => (StopReason::Stop, None),
        "max_tokens" => (StopReason::Length, None),
        "tool_use" => (StopReason::ToolUse, None),
        "refusal" => {
            let explanation = details
                .and_then(|details| details.get("explanation"))
                .and_then(Value::as_str)
                .filter(|explanation| !explanation.is_empty());
            (
                StopReason::Error,
                Some(
                    explanation
                        .unwrap_or("The model refused to complete the request")
                        .to_string(),
                ),
            )
        }
        "sensitive" => (
            StopReason::Error,
            Some("Provider stopped with: sensitive".to_string()),
        ),
        other => return Err(format!("Unhandled stop reason: {other}")),
    })
}

impl AnthropicStream {
    /// `messages` is the request's transcript, whose tools map OAuth tool names back; `effort`
    /// is the requested effort, recorded on managed-effort models. `clock` gives the time in
    /// milliseconds.
    pub fn new(
        model: &Model,
        messages: &[Message],
        oauth: bool,
        effort: Option<&str>,
        clock: fn() -> u64,
    ) -> Self {
        let compat = model.compat();
        let resolved = resolve_transcript(
            messages,
            compat.supports_mid_convo_system_messages.unwrap_or(false),
        );
        let tool_names = current_tools(&resolved)
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        let provider_thinking_level = (compat.supports_mid_convo_effort == Some(true))
            .then(|| effort.unwrap_or("high").to_string());
        let output = AssistantMessage {
            content: Vec::new(),
            api: model.api.clone(),
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            provider_thinking_level,
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
        };
        AnthropicStream {
            usage_cost: model.cost.clone().unwrap_or_default(),
            model: model.clone(),
            oauth,
            tool_names,
            output,
            blocks: Vec::new(),
            sse: SseDecoder::default(),
            saw_message_start: false,
            saw_message_stop: false,
            input_transformations: None,
            clock,
            finished: false,
        }
    }

    /// The first event, sent once the response arrives.
    pub fn start(&self) -> AssistantEvent {
        AssistantEvent::Start
    }

    /// The message as decoded so far: what the TypeScript adapter's events carry as
    /// `partial`.
    pub fn output(&self) -> &AssistantMessage {
        &self.output
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

    /// End the stream with a failure the decoder did not see: the request failed, the connection
    /// dropped, or the request was aborted. The output keeps what arrived.
    pub fn end_with_error(&mut self, reason: StopReason, message: String) -> AssistantEvent {
        self.finished = true;
        self.output.stop_reason = reason;
        self.output.error_message = Some(message);
        AssistantEvent::Error {
            reason,
            error: Message::Assistant(Box::new(self.output.clone())),
        }
    }

    fn handle(&mut self, events: Vec<ServerSentEvent>, last: bool) -> Vec<AssistantEvent> {
        let mut emitted = Vec::new();
        let result = (|| {
            for event in events {
                self.event(&event, &mut emitted)?;
            }
            if last {
                self.end(&mut emitted)?;
            }
            Ok::<(), String>(())
        })();
        if let Err(message) = result {
            self.finished = true;
            self.output.stop_reason = StopReason::Error;
            self.output.error_message = Some(message);
            emitted.push(AssistantEvent::Error {
                reason: StopReason::Error,
                error: Message::Assistant(Box::new(self.output.clone())),
            });
        }
        emitted
    }

    fn end(&mut self, emitted: &mut Vec<AssistantEvent>) -> Result<(), String> {
        if self.saw_message_start && !self.saw_message_stop {
            return Err("Anthropic stream ended before message_stop".into());
        }
        if self.output.stop_reason == StopReason::Pending {
            return Err("Anthropic stream ended without a stop reason".into());
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
        if let Some(transformations) = self
            .input_transformations
            .as_ref()
            .filter(|list| !list.is_empty())
        {
            let transformations: Vec<Value> = transformations
                .iter()
                .map(|transformation| {
                    let mut entry = Map::new();
                    for field in ["type", "path", "reason"] {
                        match transformation.get(field) {
                            None | Some(Value::Null) => {}
                            Some(value) => {
                                entry.insert(field.into(), value.clone());
                            }
                        }
                    }
                    Value::Object(entry)
                })
                .collect();
            self.output
                .diagnostics
                .get_or_insert_with(Vec::new)
                .push(json!({
                    "type": "anthropic_input_transformations",
                    "timestamp": (self.clock)(),
                    "details": { "transformations": transformations },
                }));
        }
        self.finished = true;
        emitted.push(AssistantEvent::Done {
            reason: self.output.stop_reason,
            message: Message::Assistant(Box::new(self.output.clone())),
        });
        Ok(())
    }

    fn open_block(&self, index: Option<u64>) -> Option<usize> {
        index.and_then(|index| {
            self.blocks
                .iter()
                .position(|block| block.open_index == Some(index))
        })
    }

    fn push_block(&mut self, block: OutputBlock, index: Option<u64>) -> usize {
        self.output.content.push(block);
        self.blocks.push(BlockState {
            open_index: index,
            partial_json: String::new(),
        });
        self.output.content.len() - 1
    }

    fn refresh_usage(&mut self) {
        self.output.usage.total_tokens = self.output.usage.input
            + self.output.usage.output
            + self.output.usage.cache_read
            + self.output.usage.cache_write;
        calculate_cost(&self.usage_cost, &mut self.output.usage);
    }

    fn event(
        &mut self,
        sse: &ServerSentEvent,
        emitted: &mut Vec<AssistantEvent>,
    ) -> Result<(), String> {
        if sse.event.as_deref() == Some("error") {
            return Err(sse.data.clone());
        }
        let name = sse.event.as_deref().unwrap_or_default();
        if !MESSAGE_EVENTS.contains(&name) {
            return Ok(());
        }
        let event = parse_json_with_repair(&sse.data).map_err(|error| {
            format!(
                "Could not parse Anthropic SSE event {name}: {error}; data={}; raw={}",
                sse.data,
                sse.raw.join("\\n")
            )
        })?;
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "message_start" => {
                self.saw_message_start = true;
                self.message_start(&event["message"]);
            }
            "message_stop" => self.saw_message_stop = true,
            "content_block_start" => self.block_start(&event, emitted)?,
            "content_block_delta" => self.block_delta(&event, emitted),
            "content_block_stop" => self.block_stop(&event, emitted),
            "message_delta" => self.message_delta(&event)?,
            _ => {}
        }
        Ok(())
    }

    fn message_start(&mut self, message: &Value) {
        self.output.response_id = message
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(Value::Array(transformations)) = message.get("input_transformations") {
            self.input_transformations = Some(transformations.clone());
        }
        let response_model = message.get("model").and_then(Value::as_str);
        if response_model != Some(self.model.id.as_str()) {
            self.output.response_model = response_model.map(str::to_string);
        }
        let fallback_cost = response_model
            .filter(|response_model| *response_model != self.model.id)
            .and_then(|response_model| {
                self.model
                    .compat()
                    .allowed_fallback_models
                    .unwrap_or_default()
                    .into_iter()
                    .find(|fallback| {
                        fallback.provider.as_deref() == Some(self.model.provider.as_str())
                            && fallback.model == response_model
                    })
                    .and_then(|fallback| fallback.cost)
            });
        self.usage_cost =
            fallback_cost.unwrap_or_else(|| self.model.cost.clone().unwrap_or_default());
        let usage = &message["usage"];
        self.output.usage.input = count_or_zero(usage.get("input_tokens"));
        self.output.usage.output = count_or_zero(usage.get("output_tokens"));
        self.output.usage.cache_read = count_or_zero(usage.get("cache_read_input_tokens"));
        self.output.usage.cache_write = count_or_zero(usage.get("cache_creation_input_tokens"));
        self.output.usage.cache_write_1h =
            Some(count_or_zero(usage.get("cache_creation").and_then(
                |creation| creation.get("ephemeral_1h_input_tokens"),
            )));
        self.refresh_usage();
    }

    fn block_start(
        &mut self,
        event: &Value,
        emitted: &mut Vec<AssistantEvent>,
    ) -> Result<(), String> {
        let index = event.get("index").and_then(number);
        let block = &event["content_block"];
        let text_of = |field: &str| {
            block
                .get(field)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        match block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "fallback" => {
                if !self.output.content.is_empty() {
                    return Err(
                        "Anthropic performed an unsupported mid-output model fallback".into(),
                    );
                }
            }
            "text" => {
                let content_index = self.push_block(
                    OutputBlock::Text(TextContent {
                        text: text_of("text"),
                        text_signature: None,
                        volatile: None,
                    }),
                    index,
                );
                emitted.push(AssistantEvent::TextStart { content_index });
            }
            "thinking" => {
                let content_index = self.push_block(
                    OutputBlock::Thinking(ThinkingContent {
                        thinking: text_of("thinking"),
                        thinking_signature: Some(text_of("signature")),
                        redacted: None,
                    }),
                    index,
                );
                emitted.push(AssistantEvent::ThinkingStart { content_index });
            }
            "redacted_thinking" => {
                let content_index = self.push_block(
                    OutputBlock::Thinking(ThinkingContent {
                        thinking: "[Reasoning redacted]".into(),
                        thinking_signature: block
                            .get("data")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        redacted: Some(true),
                    }),
                    index,
                );
                emitted.push(AssistantEvent::ThinkingStart { content_index });
            }
            "tool_use" => {
                let name = text_of("name");
                let name = if self.oauth {
                    from_claude_code_name(&name, &self.tool_names)
                } else {
                    name
                };
                let arguments = match block.get("input") {
                    Some(Value::Object(input)) => input.clone(),
                    _ => Map::new(),
                };
                let content_index = self.push_block(
                    OutputBlock::ToolCall(ToolCall {
                        id: text_of("id"),
                        name,
                        arguments,
                        thought_signature: None,
                        namespace: None,
                    }),
                    index,
                );
                emitted.push(AssistantEvent::ToolcallStart { content_index });
            }
            _ => {}
        }
        Ok(())
    }

    fn block_delta(&mut self, event: &Value, emitted: &mut Vec<AssistantEvent>) {
        let Some(position) = self.open_block(event.get("index").and_then(number)) else {
            return;
        };
        let delta = &event["delta"];
        let text_of = |field: &str| {
            delta
                .get(field)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        match (
            delta.get("type").and_then(Value::as_str),
            &mut self.output.content[position],
        ) {
            (Some("text_delta"), OutputBlock::Text(block)) => {
                let text = text_of("text");
                block.text.push_str(&text);
                emitted.push(AssistantEvent::TextDelta {
                    content_index: position,
                    delta: text,
                });
            }
            (Some("thinking_delta"), OutputBlock::Thinking(block)) => {
                let thinking = text_of("thinking");
                block.thinking.push_str(&thinking);
                emitted.push(AssistantEvent::ThinkingDelta {
                    content_index: position,
                    delta: thinking,
                });
            }
            (Some("input_json_delta"), OutputBlock::ToolCall(call)) => {
                let partial = text_of("partial_json");
                let state = &mut self.blocks[position];
                state.partial_json.push_str(&partial);
                call.arguments = match parse_streaming_json(&state.partial_json) {
                    Value::Object(arguments) => arguments,
                    _ => Map::new(),
                };
                emitted.push(AssistantEvent::ToolcallDelta {
                    content_index: position,
                    delta: partial,
                });
            }
            (Some("signature_delta"), OutputBlock::Thinking(block)) => {
                block
                    .thinking_signature
                    .get_or_insert_with(String::new)
                    .push_str(&text_of("signature"));
            }
            _ => {}
        }
    }

    fn block_stop(&mut self, event: &Value, emitted: &mut Vec<AssistantEvent>) {
        let Some(position) = self.open_block(event.get("index").and_then(number)) else {
            return;
        };
        self.blocks[position].open_index = None;
        match &mut self.output.content[position] {
            OutputBlock::Text(block) => emitted.push(AssistantEvent::TextEnd {
                content_index: position,
                content: block.text.clone(),
            }),
            OutputBlock::Thinking(block) => emitted.push(AssistantEvent::ThinkingEnd {
                content_index: position,
                content: block.thinking.clone(),
            }),
            OutputBlock::ToolCall(call) => {
                call.arguments = match parse_streaming_json(&self.blocks[position].partial_json) {
                    Value::Object(arguments) => arguments,
                    _ => Map::new(),
                };
                emitted.push(AssistantEvent::ToolcallEnd {
                    content_index: position,
                    tool_call: OutputBlock::ToolCall(call.clone()),
                });
            }
        }
    }

    fn message_delta(&mut self, event: &Value) -> Result<(), String> {
        if let Some(Value::Array(transformations)) = event.get("input_transformations") {
            self.input_transformations = Some(transformations.clone());
        }
        let delta = &event["delta"];
        if let Some(reason) = delta
            .get("stop_reason")
            .and_then(Value::as_str)
            .filter(|reason| !reason.is_empty())
        {
            self.output.raw_stop_reason = Some(reason.to_string());
            let (stop_reason, error_message) = map_stop_reason(reason, delta.get("stop_details"))?;
            self.output.stop_reason = stop_reason;
            if error_message.is_some() {
                self.output.error_message = error_message;
            }
        }
        // Counts a proxy leaves out (null) keep the values from message_start.
        if let Some(usage) = event.get("usage").filter(|usage| usage.is_object()) {
            let present = |field: &str| usage.get(field).and_then(number);
            if let Some(input) = present("input_tokens") {
                self.output.usage.input = input;
            }
            if let Some(output) = present("output_tokens") {
                self.output.usage.output = output;
            }
            if let Some(cache_read) = present("cache_read_input_tokens") {
                self.output.usage.cache_read = cache_read;
            }
            if let Some(cache_write) = present("cache_creation_input_tokens") {
                self.output.usage.cache_write = cache_write;
            }
            if let Some(long_write) = usage
                .get("cache_creation")
                .and_then(|creation| creation.get("ephemeral_1h_input_tokens"))
                .and_then(number)
            {
                self.output.usage.cache_write_1h = Some(long_write);
            }
            if let Some(reasoning) = usage
                .get("output_tokens_details")
                .and_then(|details| details.get("thinking_tokens"))
                .and_then(number)
            {
                self.output.usage.reasoning = Some(reasoning);
            }
        }
        self.refresh_usage();
        Ok(())
    }
}
