//! Reading a Google Gemini stream into events and an assistant message, as the `@google/genai`
//! SDK (2.21.0, `processStreamResponse`) splits the server-sent events and the chunk loop of
//! `streamWithGoogleTransport` in `packages/ai/src/api/google-generative-ai.ts` handles them.
//!
//! Text and thinking parts open a new block whenever the kind changes; each function call is a
//! complete tool call. Feed the body with `push` and call `finish` at its end; the last event is
//! `Done` or `Error`.

use serde_json::{json, Map, Value};

use crate::event::AssistantEvent;
use crate::message::{
    AssistantMessage, Cost, Message, OutputBlock, StopReason, TextContent, ThinkingContent,
    ToolCall, Usage,
};
use crate::model::{calculate_cost, Model};
use crate::sse::Utf8Decoder;
use crate::text::js_trim;

const DELIMITERS: [&str; 3] = ["\n\n", "\r\r", "\r\n\r\n"];

/// The SDK's event splitting: at the first blank line of any kind, keeping `data:` events.
#[derive(Debug, Default)]
struct GoogleEvents {
    utf8: Utf8Decoder,
    buffer: String,
}

fn template(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

impl GoogleEvents {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        let chunk = self.utf8.decode(bytes, false);
        // A network chunk that is a whole JSON error with an HTTP code fails the stream.
        if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(&chunk) {
            if let Some(error) = parsed.get("error") {
                let code = error.get("code").and_then(Value::as_f64);
                if code.is_some_and(|code| (400.0..600.0).contains(&code)) {
                    return Err(format!(
                        "got status: {}. {}",
                        template(error.get("status")),
                        Value::Object(parsed.clone())
                    ));
                }
            }
        }
        self.buffer.push_str(&chunk);
        let mut events = Vec::new();
        loop {
            let found = DELIMITERS
                .iter()
                .filter_map(|delimiter| {
                    self.buffer
                        .find(delimiter)
                        .map(|index| (index, delimiter.len()))
                })
                .min_by_key(|(index, _)| *index);
            let Some((index, length)) = found else {
                break;
            };
            let event = self.buffer[..index].to_string();
            self.buffer.drain(..index + length);
            let trimmed = js_trim(&event);
            if let Some(data) = trimmed.strip_prefix("data:") {
                let data = js_trim(data);
                events.push(
                    serde_json::from_str(data).map_err(|error| {
                        format!("exception parsing stream chunk {data}. {error}")
                    })?,
                );
            }
        }
        Ok(events)
    }

    fn finish(&mut self) -> Result<(), String> {
        if js_trim(&self.buffer).is_empty() {
            Ok(())
        } else {
            Err("Incomplete JSON segment at the end".into())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Open {
    Text,
    Thinking,
}

pub struct GoogleStream {
    model: Model,
    output: AssistantMessage,
    current: Option<Open>,
    events: GoogleEvents,
    clock: fn() -> u64,
    /// Counts the tool call ids this stream generates.
    generated: u64,
    finished: bool,
}

fn map_stop_reason(reason: &str) -> Result<StopReason, String> {
    match reason {
        "STOP" => Ok(StopReason::Stop),
        "MAX_TOKENS" => Ok(StopReason::Length),
        "BLOCKLIST"
        | "PROHIBITED_CONTENT"
        | "SPII"
        | "SAFETY"
        | "IMAGE_SAFETY"
        | "IMAGE_PROHIBITED_CONTENT"
        | "IMAGE_RECITATION"
        | "IMAGE_OTHER"
        | "RECITATION"
        | "FINISH_REASON_UNSPECIFIED"
        | "OTHER"
        | "LANGUAGE"
        | "MALFORMED_FUNCTION_CALL"
        | "UNEXPECTED_TOOL_CALL"
        | "TOO_MANY_TOOL_CALLS"
        | "NO_IMAGE" => Ok(StopReason::Error),
        other => Err(format!("Unhandled stop reason: {other}")),
    }
}

fn count(value: Option<&Value>) -> u64 {
    value
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_f64().map(|float| float as u64))
        })
        .unwrap_or(0)
}

impl GoogleStream {
    /// `clock` gives the time in milliseconds, for the message and generated tool call ids
    /// (`<name>_<time>_<n>`).
    pub fn new(model: &Model, clock: fn() -> u64) -> Self {
        GoogleStream {
            model: model.clone(),
            output: AssistantMessage {
                content: Vec::new(),
                api: "google-generative-ai".into(),
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
            current: None,
            events: GoogleEvents::default(),
            clock,
            generated: 0,
            finished: false,
        }
    }

    /// The first event, sent once the response arrives.
    pub fn start(&self) -> AssistantEvent {
        AssistantEvent::Start
    }

    pub fn push(&mut self, bytes: &[u8]) -> Vec<AssistantEvent> {
        if self.finished {
            return Vec::new();
        }
        let mut emitted = Vec::new();
        let result = self.events.push(bytes).and_then(|chunks| {
            for chunk in chunks {
                self.chunk(&chunk, &mut emitted)?;
            }
            Ok(())
        });
        if let Err(message) = result {
            self.fail(message, &mut emitted);
        }
        emitted
    }

    pub fn finish(&mut self) -> Vec<AssistantEvent> {
        if self.finished {
            return Vec::new();
        }
        let mut emitted = Vec::new();
        let result = self.events.finish().and_then(|()| self.end(&mut emitted));
        if let Err(message) = result {
            self.fail(message, &mut emitted);
        }
        emitted
    }

    fn fail(&mut self, message: String, emitted: &mut Vec<AssistantEvent>) {
        self.finished = true;
        self.output.stop_reason = StopReason::Error;
        self.output.error_message = Some(message);
        emitted.push(AssistantEvent::Error {
            reason: StopReason::Error,
            error: Message::Assistant(Box::new(self.output.clone())),
        });
    }

    fn close_block(&mut self, emitted: &mut Vec<AssistantEvent>) {
        let index = self.output.content.len().saturating_sub(1);
        match (self.current.take(), self.output.content.last()) {
            (Some(Open::Text), Some(OutputBlock::Text(text))) => {
                emitted.push(AssistantEvent::TextEnd {
                    content_index: index,
                    content: text.text.clone(),
                })
            }
            (Some(Open::Thinking), Some(OutputBlock::Thinking(thinking))) => {
                emitted.push(AssistantEvent::ThinkingEnd {
                    content_index: index,
                    content: thinking.thinking.clone(),
                })
            }
            _ => {}
        }
    }

    fn end(&mut self, emitted: &mut Vec<AssistantEvent>) -> Result<(), String> {
        self.close_block(emitted);
        if self.output.stop_reason == StopReason::Pending {
            return Err("Google stream ended without a finish reason".into());
        }
        if matches!(
            self.output.stop_reason,
            StopReason::Aborted | StopReason::Error
        ) {
            return Err(
                match self
                    .output
                    .raw_stop_reason
                    .as_deref()
                    .filter(|raw| !raw.is_empty())
                {
                    Some(raw) => format!("Provider stopped with: {raw}"),
                    None => "An unknown error occurred".into(),
                },
            );
        }
        self.finished = true;
        emitted.push(AssistantEvent::Done {
            reason: self.output.stop_reason,
            message: Message::Assistant(Box::new(self.output.clone())),
        });
        Ok(())
    }

    fn chunk(&mut self, chunk: &Value, emitted: &mut Vec<AssistantEvent>) -> Result<(), String> {
        if self.output.response_id.as_deref().is_none_or(str::is_empty) {
            if let Some(id) = chunk.get("responseId").and_then(Value::as_str) {
                self.output.response_id = Some(id.to_string());
            }
        }
        let candidate = chunk
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|candidates| candidates.first());
        let parts = candidate
            .and_then(|candidate| candidate.get("content"))
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array);
        for part in parts.into_iter().flatten() {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                self.text_part(part, text, emitted);
            }
            if let Some(call) = part.get("functionCall").filter(|call| call.is_object()) {
                self.function_call(part, call, emitted);
            }
        }
        if let Some(reason) = candidate
            .and_then(|candidate| candidate.get("finishReason"))
            .and_then(Value::as_str)
            .filter(|reason| !reason.is_empty())
        {
            self.output.raw_stop_reason = Some(reason.to_string());
            self.output.stop_reason = map_stop_reason(reason)?;
            let has_tool_call = self
                .output
                .content
                .iter()
                .any(|block| matches!(block, OutputBlock::ToolCall(_)));
            if has_tool_call && self.output.stop_reason == StopReason::Stop {
                self.output.stop_reason = StopReason::ToolUse;
            }
        }
        if let Some(usage) = chunk.get("usageMetadata").filter(|usage| usage.is_object()) {
            let cached = count(usage.get("cachedContentTokenCount"));
            let thoughts = count(usage.get("thoughtsTokenCount"));
            self.output.usage = Usage {
                input: count(usage.get("promptTokenCount")).saturating_sub(cached),
                output: count(usage.get("candidatesTokenCount")) + thoughts,
                cache_read: cached,
                cache_write: 0,
                cache_write_1h: None,
                reasoning: Some(thoughts),
                total_tokens: count(usage.get("totalTokenCount")),
                cost: Cost {
                    input: 0.0,
                    output: 0.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                    total: 0.0,
                },
            };
            calculate_cost(
                &self.model.cost.clone().unwrap_or_default(),
                &mut self.output.usage,
            );
        }
        Ok(())
    }

    fn text_part(&mut self, part: &Value, text: &str, emitted: &mut Vec<AssistantEvent>) {
        let kind = if part.get("thought") == Some(&json!(true)) {
            Open::Thinking
        } else {
            Open::Text
        };
        if self.current != Some(kind) {
            self.close_block(emitted);
            self.output.content.push(match kind {
                Open::Thinking => OutputBlock::Thinking(ThinkingContent {
                    thinking: String::new(),
                    thinking_signature: None,
                    redacted: None,
                }),
                Open::Text => OutputBlock::Text(TextContent {
                    text: String::new(),
                    text_signature: None,
                    volatile: None,
                }),
            });
            let content_index = self.output.content.len() - 1;
            self.current = Some(kind);
            emitted.push(match kind {
                Open::Thinking => AssistantEvent::ThinkingStart { content_index },
                Open::Text => AssistantEvent::TextStart { content_index },
            });
        }
        // Some servers send the signature only on the first part of a block.
        let signature = part
            .get("thoughtSignature")
            .and_then(Value::as_str)
            .filter(|signature| !signature.is_empty())
            .map(str::to_string);
        let content_index = self.output.content.len() - 1;
        match self.output.content.last_mut() {
            Some(OutputBlock::Thinking(thinking)) => {
                thinking.thinking.push_str(text);
                if signature.is_some() {
                    thinking.thinking_signature = signature;
                }
                emitted.push(AssistantEvent::ThinkingDelta {
                    content_index,
                    delta: text.to_string(),
                });
            }
            Some(OutputBlock::Text(block)) => {
                block.text.push_str(text);
                if signature.is_some() {
                    block.text_signature = signature;
                }
                emitted.push(AssistantEvent::TextDelta {
                    content_index,
                    delta: text.to_string(),
                });
            }
            _ => {}
        }
    }

    fn function_call(&mut self, part: &Value, call: &Value, emitted: &mut Vec<AssistantEvent>) {
        self.close_block(emitted);
        let provided = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let taken = provided.is_some_and(|provided| {
            self.output.content.iter().any(
                |block| matches!(block, OutputBlock::ToolCall(existing) if existing.id == provided),
            )
        });
        let id = match provided.filter(|_| !taken) {
            Some(id) => id.to_string(),
            None => {
                self.generated += 1;
                format!(
                    "{}_{}_{}",
                    template(call.get("name")),
                    (self.clock)(),
                    self.generated
                )
            }
        };
        let arguments = match call.get("args") {
            Some(Value::Object(args)) => args.clone(),
            _ => Map::new(),
        };
        let tool_call = ToolCall {
            id,
            name: call
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            arguments,
            thought_signature: part
                .get("thoughtSignature")
                .and_then(Value::as_str)
                .filter(|signature| !signature.is_empty())
                .map(str::to_string),
            namespace: None,
        };
        let delta = Value::Object(tool_call.arguments.clone()).to_string();
        self.output.content.push(OutputBlock::ToolCall(tool_call));
        let content_index = self.output.content.len() - 1;
        emitted.push(AssistantEvent::ToolcallStart { content_index });
        emitted.push(AssistantEvent::ToolcallDelta {
            content_index,
            delta,
        });
        emitted.push(AssistantEvent::ToolcallEnd {
            content_index,
            tool_call: self.output.content[content_index].clone(),
        });
    }
}
