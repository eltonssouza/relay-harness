//! What the parity tests share: the recorders' model, their scripted provider events, and a
//! readable first difference between two recorded lists.

#![allow(dead_code)]

use relay_agent::StreamEvent;
use relay_ai::event::AssistantEvent;
use relay_ai::{
    AssistantMessage, Message, Model, OutputBlock, StopReason, TextContent, ThinkingContent,
    ToolCall,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

/// A scripted assistant response.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub content: Vec<OutputBlock>,
    pub stop_reason: Option<StopReason>,
    pub error_message: Option<String>,
}

/// The recorder's model.
pub fn model() -> Model {
    serde_json::from_value(json!({
        "id": "mock",
        "name": "mock",
        "api": "openai-responses",
        "provider": "openai",
        "baseUrl": "https://example.invalid",
        "reasoning": true,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 8192,
        "maxTokens": 2048,
    }))
    .unwrap()
}

/// `responseEvents`: `start`, each block's start, delta and end, then `done` or `error`, each
/// with the message so far.
pub fn response_events(model: &Model, response: &Response) -> Vec<StreamEvent> {
    let mut message: AssistantMessage = serde_json::from_value(json!({
        "content": [],
        "api": model.api,
        "provider": model.provider,
        "model": model.id,
        "usage": {
            "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
        },
        "stopReason": response.stop_reason.unwrap_or(StopReason::Stop),
        "errorMessage": response.error_message,
        "timestamp": 0,
    }))
    .unwrap();
    let partial = |message: &AssistantMessage| AssistantMessage {
        stop_reason: StopReason::Pending,
        error_message: None,
        ..message.clone()
    };
    let mut events = vec![StreamEvent {
        event: AssistantEvent::Start,
        partial: partial(&message),
    }];
    let mut push = |event: AssistantEvent, message: &AssistantMessage| {
        events.push(StreamEvent {
            event,
            partial: partial(message),
        });
    };
    for (content_index, block) in response.content.iter().enumerate() {
        match block {
            OutputBlock::Text(text) => {
                message.content.push(OutputBlock::Text(TextContent {
                    text: String::new(),
                    ..text.clone()
                }));
                push(AssistantEvent::TextStart { content_index }, &message);
                message.content[content_index] = block.clone();
                let delta = text.text.clone();
                push(
                    AssistantEvent::TextDelta {
                        content_index,
                        delta,
                    },
                    &message,
                );
                let content = text.text.clone();
                push(
                    AssistantEvent::TextEnd {
                        content_index,
                        content,
                    },
                    &message,
                );
            }
            OutputBlock::Thinking(thinking) => {
                message.content.push(OutputBlock::Thinking(ThinkingContent {
                    thinking: String::new(),
                    ..thinking.clone()
                }));
                push(AssistantEvent::ThinkingStart { content_index }, &message);
                message.content[content_index] = block.clone();
                let delta = thinking.thinking.clone();
                push(
                    AssistantEvent::ThinkingDelta {
                        content_index,
                        delta,
                    },
                    &message,
                );
                let content = thinking.thinking.clone();
                push(
                    AssistantEvent::ThinkingEnd {
                        content_index,
                        content,
                    },
                    &message,
                );
            }
            OutputBlock::ToolCall(call) => {
                message.content.push(OutputBlock::ToolCall(ToolCall {
                    arguments: Map::new(),
                    ..call.clone()
                }));
                push(AssistantEvent::ToolcallStart { content_index }, &message);
                message.content[content_index] = block.clone();
                let delta = serde_json::to_string(&call.arguments).unwrap();
                push(
                    AssistantEvent::ToolcallDelta {
                        content_index,
                        delta,
                    },
                    &message,
                );
                let tool_call = block.clone();
                push(
                    AssistantEvent::ToolcallEnd {
                        content_index,
                        tool_call,
                    },
                    &message,
                );
            }
        }
    }
    let reason = message.stop_reason;
    let event = match reason {
        StopReason::Error | StopReason::Aborted => AssistantEvent::Error {
            reason,
            error: Message::Assistant(Box::new(message.clone())),
        },
        _ => AssistantEvent::Done {
            reason,
            message: Message::Assistant(Box::new(message.clone())),
        },
    };
    events.push(StreamEvent {
        event,
        partial: message,
    });
    events
}

pub fn first_difference(expected: &[Value], actual: &[Value]) -> Option<String> {
    if expected == actual {
        return None;
    }
    let index = expected
        .iter()
        .zip(actual)
        .position(|(expected, actual)| expected != actual)
        .unwrap_or(expected.len().min(actual.len()));
    let show = |list: &[Value]| {
        list.get(index)
            .map_or("(none)".into(), |value| value.to_string())
    };
    Some(format!(
        "item {index} of {} expected, {} got\n    expected {}\n    actual   {}",
        expected.len(),
        actual.len(),
        show(expected),
        show(actual)
    ))
}
