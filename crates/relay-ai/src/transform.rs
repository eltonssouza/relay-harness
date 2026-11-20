//! Preparing a transcript for one model, as `packages/ai/src/api/transform-messages.ts` does:
//! images become placeholders on text-only models, another model's thinking becomes text and its
//! tool call ids are normalized, failed responses are dropped, and tool calls left without a
//! result get one.

use std::collections::{HashMap, HashSet};

use crate::message::{
    AssistantMessage, InputBlock, Message, OutputBlock, StopReason, TextContent, ToolCall,
    ToolResultMessage,
};
use crate::model::Model;
use crate::text::is_blank;
use crate::Content;

/// Rewrites another model's tool call id for this API, given the id and the message that made
/// the call.
pub type NormalizeToolCallId<'a> = &'a dyn Fn(&str, &AssistantMessage) -> String;

const NON_VISION_USER_IMAGE_PLACEHOLDER: &str = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER: &str =
    "(tool image omitted: model does not support images)";
const MISSING_TOOL_RESULT: &str = "No result provided";

fn text_block(text: &str) -> TextContent {
    TextContent {
        text: text.to_string(),
        text_signature: None,
        volatile: None,
    }
}

/// Images become one placeholder per run of images.
fn replace_images(content: &[InputBlock], placeholder: &str) -> Vec<InputBlock> {
    let mut result = Vec::new();
    let mut previous_was_placeholder = false;
    for block in content {
        match block {
            InputBlock::Image(_) => {
                if !previous_was_placeholder {
                    result.push(InputBlock::Text(text_block(placeholder)));
                }
                previous_was_placeholder = true;
            }
            InputBlock::Text(text) => {
                previous_was_placeholder = text.text == placeholder;
                result.push(block.clone());
            }
        }
    }
    result
}

fn downgrade_images(messages: &[Message], model: &Model) -> Vec<Message> {
    if model.accepts_images() {
        return messages.to_vec();
    }
    messages
        .iter()
        .map(|message| match message {
            Message::User(user) => match &user.content {
                Content::Blocks(blocks) => {
                    let mut user = user.clone();
                    user.content =
                        Content::Blocks(replace_images(blocks, NON_VISION_USER_IMAGE_PLACEHOLDER));
                    Message::User(user)
                }
                Content::Text(_) => message.clone(),
            },
            Message::ToolResult(result) => {
                let mut result = result.clone();
                result.content = replace_images(&result.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER);
                Message::ToolResult(result)
            }
            _ => message.clone(),
        })
        .collect()
}

fn transform_assistant(
    message: &AssistantMessage,
    model: &Model,
    normalize_tool_call_id: Option<NormalizeToolCallId<'_>>,
    tool_call_ids: &mut HashMap<String, String>,
) -> AssistantMessage {
    let same_model =
        message.provider == model.provider && message.api == model.api && message.model == model.id;
    let mut content = Vec::new();
    for block in &message.content {
        match block {
            OutputBlock::Thinking(thinking) => {
                if thinking.redacted == Some(true) {
                    if same_model {
                        content.push(block.clone());
                    }
                    continue;
                }
                let signed = thinking
                    .thinking_signature
                    .as_deref()
                    .is_some_and(|signature| !signature.is_empty());
                if same_model && signed {
                    content.push(block.clone());
                } else if is_blank(&thinking.thinking) {
                    // Empty thinking says nothing to any model.
                } else if same_model {
                    content.push(block.clone());
                } else {
                    content.push(OutputBlock::Text(text_block(&thinking.thinking)));
                }
            }
            OutputBlock::Text(text) => {
                content.push(if same_model {
                    block.clone()
                } else {
                    OutputBlock::Text(text_block(&text.text))
                });
            }
            OutputBlock::ToolCall(call) => {
                let mut call: ToolCall = call.clone();
                if !same_model {
                    call.thought_signature = None;
                    if let Some(normalize) = normalize_tool_call_id {
                        let normalized = normalize(&call.id, message);
                        if normalized != call.id {
                            tool_call_ids.insert(call.id.clone(), normalized.clone());
                            call.id = normalized;
                        }
                    }
                }
                content.push(OutputBlock::ToolCall(call));
            }
        }
    }
    AssistantMessage {
        content,
        ..message.clone()
    }
}

/// `normalize_tool_call_id` rewrites the ids of another model's tool calls for this API, given
/// the id and the message that made the call; their results follow the new ids.
pub fn transform_messages(
    messages: &[Message],
    model: &Model,
    normalize_tool_call_id: Option<NormalizeToolCallId<'_>>,
) -> Vec<Message> {
    let mut tool_call_ids = HashMap::new();
    let transformed: Vec<Message> = downgrade_images(messages, model)
        .into_iter()
        .map(|message| match message {
            Message::Assistant(assistant) => Message::Assistant(Box::new(transform_assistant(
                &assistant,
                model,
                normalize_tool_call_id,
                &mut tool_call_ids,
            ))),
            Message::ToolResult(mut result) => {
                if let Some(normalized) = tool_call_ids.get(&result.tool_call_id) {
                    result.tool_call_id = normalized.clone();
                }
                Message::ToolResult(result)
            }
            other => other,
        })
        .collect();

    // A system message between a tool call and its results waits until the results are in.
    let mut result = Vec::new();
    let mut pending: Vec<ToolCall> = Vec::new();
    let mut answered: HashSet<String> = HashSet::new();
    let mut held: Vec<Message> = Vec::new();
    let close = |result: &mut Vec<Message>,
                 pending: &mut Vec<ToolCall>,
                 answered: &mut HashSet<String>,
                 held: &mut Vec<Message>| {
        for call in pending.drain(..) {
            if !answered.contains(&call.id) {
                result.push(Message::ToolResult(ToolResultMessage {
                    tool_call_id: call.id,
                    tool_name: call.name,
                    content: vec![InputBlock::Text(text_block(MISSING_TOOL_RESULT))],
                    details: None,
                    usage: None,
                    nested_calls: None,
                    is_error: true,
                    timestamp: 0,
                }));
            }
        }
        answered.clear();
        result.append(held);
    };
    for message in transformed {
        match &message {
            Message::Assistant(assistant) => {
                close(&mut result, &mut pending, &mut answered, &mut held);
                // A failed or aborted response is not replayed; the model retries from before it.
                if matches!(
                    assistant.stop_reason,
                    StopReason::Error | StopReason::Aborted
                ) {
                    continue;
                }
                let calls: Vec<ToolCall> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        OutputBlock::ToolCall(call) => Some(call.clone()),
                        _ => None,
                    })
                    .collect();
                if !calls.is_empty() {
                    pending = calls;
                    answered.clear();
                }
                result.push(message);
            }
            Message::ToolResult(tool_result) => {
                answered.insert(tool_result.tool_call_id.clone());
                result.push(message);
            }
            Message::System(_) => {
                if pending.is_empty() {
                    result.push(message);
                } else {
                    held.push(message);
                }
            }
            Message::User(_) => {
                close(&mut result, &mut pending, &mut answered, &mut held);
                result.push(message);
            }
        }
    }
    close(&mut result, &mut pending, &mut answered, &mut held);
    result
}
