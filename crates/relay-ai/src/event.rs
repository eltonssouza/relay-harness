//! What an adapter emits while a response streams (`AssistantMessageEventStream` in
//! `packages/ai`), without the live `partial` message the TypeScript events carry: `start`, then
//! start, delta and end events per content block, then `done` or `error` with the final message.

use serde::{Deserialize, Serialize};

use crate::message::{Message, OutputBlock, StopReason};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantEvent {
    Start,
    #[serde(rename_all = "camelCase")]
    TextStart {
        content_index: usize,
    },
    #[serde(rename_all = "camelCase")]
    TextDelta {
        content_index: usize,
        delta: String,
    },
    #[serde(rename_all = "camelCase")]
    TextEnd {
        content_index: usize,
        content: String,
    },
    #[serde(rename_all = "camelCase")]
    ThinkingStart {
        content_index: usize,
    },
    #[serde(rename_all = "camelCase")]
    ThinkingDelta {
        content_index: usize,
        delta: String,
    },
    #[serde(rename_all = "camelCase")]
    ThinkingEnd {
        content_index: usize,
        content: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolcallStart {
        content_index: usize,
    },
    #[serde(rename_all = "camelCase")]
    ToolcallDelta {
        content_index: usize,
        delta: String,
    },
    /// The finished tool call, an `OutputBlock::ToolCall`.
    #[serde(rename_all = "camelCase")]
    ToolcallEnd {
        content_index: usize,
        tool_call: OutputBlock,
    },
    /// The response finished; `message` is the assistant message.
    Done {
        reason: StopReason,
        message: Message,
    },
    /// The response failed; `error` is the assistant message as far as it got, with the error.
    Error {
        reason: StopReason,
        error: Message,
    },
}
