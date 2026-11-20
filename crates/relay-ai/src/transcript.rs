//! Reading the prompt and tool state out of a transcript's system messages, as
//! `packages/ai/src/utils/transcript.ts` and `utils/text.ts` do.

use crate::message::{Content, Message, Sections, SystemMessage, TextBlock, Tool, ToolReference};

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

/// Whether two tools declare the same interface to the model (`declarationsEqual`): the same
/// JSON, key order included, as the TypeScript side compares `JSON.stringify` output.
pub fn declarations_equal(left: &Tool, right: &Tool) -> bool {
    serde_json::to_string(left).ok() == serde_json::to_string(right).ok()
}

/// How one complete tool state differs from another (`getToolStateChanges`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ToolStateChanges {
    pub tools_added: Vec<Tool>,
    pub tools_removed: Vec<ToolReference>,
}

/// The tool of that name; the last one, as a JavaScript `Map` built from the list keeps.
fn named<'a>(tools: &'a [Tool], name: &str) -> Option<&'a Tool> {
    tools.iter().rev().find(|tool| tool.name == name)
}

/// The changes from `previous` to `current`. A changed definition is a removal followed by an
/// addition.
pub fn tool_state_changes(previous: &[Tool], current: &[Tool]) -> ToolStateChanges {
    ToolStateChanges {
        tools_added: current
            .iter()
            .filter(|tool| {
                !named(previous, &tool.name).is_some_and(|before| declarations_equal(before, tool))
            })
            .cloned()
            .collect(),
        tools_removed: previous
            .iter()
            .filter(|tool| {
                !named(current, &tool.name).is_some_and(|after| declarations_equal(tool, after))
            })
            .map(|tool| ToolReference {
                name: tool.name.clone(),
            })
            .collect(),
    }
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn tool(name: &str, parameters: serde_json::Value) -> Tool {
        Tool {
            name: name.into(),
            description: format!("{name} tool"),
            parameters,
            constrained_sampling: None,
        }
    }

    #[test]
    fn a_changed_definition_is_removed_and_added() {
        let previous = [
            tool("read", json!({"type": "object"})),
            tool("bash", json!({})),
        ];
        let current = [
            tool("read", json!({"type": "object", "properties": {}})),
            tool("bash", json!({})),
            tool("grep", json!({})),
        ];
        let changes = tool_state_changes(&previous, &current);
        let added: Vec<&str> = changes
            .tools_added
            .iter()
            .map(|t| t.name.as_str())
            .collect();
        let removed: Vec<&str> = changes
            .tools_removed
            .iter()
            .map(|t| t.name.as_str())
            .collect();
        assert_eq!(added, ["read", "grep"]);
        assert_eq!(removed, ["read"]);
        assert_eq!(
            tool_state_changes(&current, &current),
            ToolStateChanges::default()
        );
    }
}
