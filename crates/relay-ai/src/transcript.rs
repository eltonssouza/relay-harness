//! Reading the prompt and tool state out of a transcript's system messages, as
//! `packages/ai/src/utils/transcript.ts` and `utils/text.ts` do.

use crate::message::{Content, Message, Sections, SystemMessage, TextBlock, Tool};

/// The text blocks of `content`, joined with newlines.
pub fn content_text(content: &Content<TextBlock>) -> String {
    match content {
        Content::Text(text) => text.clone(),
        Content::Blocks(blocks) => blocks
            .iter()
            .map(|TextBlock::Text(block)| block.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// A system message as a complete prompt: its content followed by its sections.
pub fn system_message_text(message: &SystemMessage) -> String {
    let mut parts = vec![content_text(&message.content)];
    if let Some(sections) = &message.sections {
        parts.extend(sections.0.iter().filter_map(|(_, text)| text.clone()));
    }
    parts.retain(|part| !part.is_empty());
    parts.join("\n\n")
}

/// A later system message for APIs that accept system messages mid-conversation.
pub fn render_system_message_update(message: &SystemMessage) -> String {
    let mut parts = Vec::new();
    let text = content_text(&message.content);
    if !text.is_empty() {
        parts.push(text);
    }
    if let Some(sections) = &message.sections {
        for (name, value) in &sections.0 {
            parts.push(match value {
                None => format!("Removed system prompt section \"{name}\"."),
                Some(value) => format!("Updated system prompt section \"{name}\":\n\n{value}"),
            });
        }
    }
    parts.join("\n\n")
}

/// The leading system message, if the transcript starts with one.
pub fn initial_system_message(messages: &[Message]) -> Option<&SystemMessage> {
    match messages.first() {
        Some(Message::System(message)) => Some(message),
        _ => None,
    }
}

/// The tools available after applying every system message in order. A tool removed and added
/// again moves to the end, as with a JavaScript `Map`.
pub fn current_tools(messages: &[Message]) -> Vec<Tool> {
    let mut tools: Vec<Tool> = Vec::new();
    for message in messages {
        let Message::System(system) = message else {
            continue;
        };
        for removed in system.tools_removed.iter().flatten() {
            tools.retain(|tool| tool.name != removed.name);
        }
        for added in system.tools_added.iter().flatten() {
            match tools.iter_mut().find(|tool| tool.name == added.name) {
                Some(existing) => *existing = added.clone(),
                None => tools.push(added.clone()),
            }
        }
    }
    tools
}

/// Every system message replayed into one: later content appended, sections patched by name,
/// the current tools.
pub fn current_system_message(messages: &[Message]) -> Option<SystemMessage> {
    let mut content = Vec::new();
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut timestamp = None;
    for message in messages {
        let Message::System(system) = message else {
            continue;
        };
        timestamp.get_or_insert(system.timestamp);
        let text = content_text(&system.content);
        if !text.is_empty() {
            content.push(text);
        }
        for (name, value) in system.sections.iter().flat_map(|sections| &sections.0) {
            match value {
                None => sections.retain(|(existing, _)| existing != name),
                Some(value) => match sections.iter_mut().find(|(existing, _)| existing == name) {
                    Some(section) => section.1 = value.clone(),
                    None => sections.push((name.clone(), value.clone())),
                },
            }
        }
    }
    let tools = current_tools(messages);
    if timestamp.is_none() && tools.is_empty() {
        return None;
    }
    Some(SystemMessage {
        content: Content::Text(content.join("\n\n")),
        sections: (!sections.is_empty()).then(|| {
            Sections(
                sections
                    .into_iter()
                    .map(|(name, value)| (name, Some(value)))
                    .collect(),
            )
        }),
        tools_added: (!tools.is_empty()).then_some(tools),
        tools_removed: None,
        timestamp: timestamp.unwrap_or(0),
    })
}

/// The transcript for APIs without mid-conversation system messages: the replayed system
/// message leads, and the later ones are dropped.
pub fn collapse_system_messages(messages: &[Message]) -> Vec<Message> {
    let head = current_system_message(messages).map(Message::System);
    head.into_iter()
        .chain(
            messages
                .iter()
                .filter(|message| !matches!(message, Message::System(_)))
                .cloned(),
        )
        .collect()
}

/// Every tool definition the transcript names, in first-declaration order; a later definition
/// under the same name replaces the earlier one in place.
pub fn declared_tools(messages: &[Message]) -> Vec<Tool> {
    let mut tools: Vec<Tool> = Vec::new();
    for message in messages {
        let Message::System(system) = message else {
            continue;
        };
        for added in system.tools_added.iter().flatten() {
            match tools.iter_mut().find(|tool| tool.name == added.name) {
                Some(existing) => *existing = added.clone(),
                None => tools.push(added.clone()),
            }
        }
    }
    tools
}

/// Whether a tool was removed or declared again, which a transport that only adds tools
/// cannot replay.
pub fn has_non_additive_tool_changes(messages: &[Message]) -> bool {
    let mut declared: Vec<&str> = Vec::new();
    for message in messages {
        let Message::System(system) = message else {
            continue;
        };
        if system
            .tools_removed
            .as_ref()
            .is_some_and(|removed| !removed.is_empty())
        {
            return true;
        }
        for added in system.tools_added.iter().flatten() {
            if declared.contains(&added.name.as_str()) {
                return true;
            }
            declared.push(&added.name);
        }
    }
    false
}

/// The tools for the request's tool field, and whether later system messages load their own
/// additions in place. Only additions can be loaded in place, so a removal or a redeclaration
/// sends the current tool list instead.
pub fn resolve_transcript_tools(
    messages: &[Message],
    supports_tool_additions: bool,
) -> (Vec<Tool>, bool) {
    let anchors_additions = supports_tool_additions && !has_non_additive_tool_changes(messages);
    let request_tools = if anchors_additions {
        initial_system_message(messages)
            .and_then(|system| system.tools_added.clone())
            .unwrap_or_default()
    } else {
        current_tools(messages)
    };
    (request_tools, anchors_additions)
}

/// Keep later system messages when the model accepts them; otherwise collapse them.
pub fn resolve_transcript(
    messages: &[Message],
    supports_mid_convo_system_messages: bool,
) -> Vec<Message> {
    if supports_mid_convo_system_messages {
        messages.to_vec()
    } else {
        collapse_system_messages(messages)
    }
}
