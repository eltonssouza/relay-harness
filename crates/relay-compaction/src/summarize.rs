//! The summaries a compaction asks the model for (`generateSummaryWithUsage`, `compact` and
//! `generateTurnPrefixSummary` in `compaction.ts`): the conversation as text in one user message
//! under the summarization system prompt, sent through the agent's stream function with prompt
//! caching off and the assistant retry policy around it.

use std::collections::HashMap;

use futures_util::StreamExt;
use relay_agent::{StreamFn, StreamRequest};
use relay_ai::abort::AbortSignal;
use relay_ai::assistant_retry::{retry_assistant_call, RetryCallbacks, RetryPolicy};
use relay_ai::event::AssistantEvent;
use relay_ai::message::{
    AssistantMessage, Content, InputBlock, Message, OutputBlock, StopReason, SystemMessage,
    TextContent, Usage, UserMessage,
};
use relay_ai::options::CacheRetention;
use relay_ai::retry::RetryOptions;
use relay_ai::simple::SimpleOptions;
use relay_ai::Model;
use serde_json::{json, Map, Value};

use crate::cut::CompactionPreparation;
use crate::utils::{
    compute_file_lists, convert_to_llm, details_json, format_file_operations,
    serialize_conversation, SUMMARIZATION_SYSTEM_PROMPT,
};

const SUMMARIZATION_PROMPT: &str = "The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.\n\nUse this EXACT format:\n\n## Goal\n[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]\n\n## Constraints & Preferences\n- [Any constraints, preferences, or requirements mentioned by user]\n- [Or \"(none)\" if none were mentioned]\n\n## Progress\n### Done\n- [x] [Completed tasks/changes]\n\n### In Progress\n- [ ] [Current work]\n\n### Blocked\n- [Issues preventing progress, if any]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale]\n\n## Next Steps\n1. [Ordered list of what should happen next]\n\n## Critical Context\n- [Any data, examples, or references needed to continue]\n- [Or \"(none)\" if not applicable]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.";

const UPDATE_SUMMARIZATION_PROMPT: &str = "The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.\n\nUpdate the existing structured summary with new information. RULES:\n- PRESERVE all existing information from the previous summary\n- ADD new progress, decisions, and context from the new messages\n- UPDATE the Progress section: move items from \"In Progress\" to \"Done\" when completed\n- UPDATE \"Next Steps\" based on what was accomplished\n- PRESERVE exact file paths, function names, and error messages\n- If something is no longer relevant, you may remove it\n\nUse this EXACT format:\n\n## Goal\n[Preserve existing goals, add new ones if the task expanded]\n\n## Constraints & Preferences\n- [Preserve existing, add new ones discovered]\n\n## Progress\n### Done\n- [x] [Include previously done items AND newly completed items]\n\n### In Progress\n- [ ] [Current work - update based on progress]\n\n### Blocked\n- [Current blockers - remove if resolved]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale] (preserve all previous, add new)\n\n## Next Steps\n1. [Update based on current state]\n\n## Critical Context\n- [Preserve important context, add new if needed]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.";

const TURN_PREFIX_SUMMARIZATION_PROMPT: &str = "The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.\n\nCreate a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.\n\n## Original Request\n[What did the user ask for?]\n\n## Progress So Far\n- [Key decisions and work completed in these messages]\n\n## Context Needed to Continue\n- [Information from these messages needed to understand the later work]\n\nOnly summarize information explicitly present above. Do not infer or recreate later messages.";

/// How summaries reach the model: the model, the stream function and the request's settings.
pub struct Summarizer<'a> {
    pub model: &'a Model,
    pub stream: &'a dyn StreamFn,
    pub api_key: Option<String>,
    pub headers: Option<Map<String, Value>>,
    pub env: Option<HashMap<String, String>>,
    pub signal: AbortSignal,
    pub thinking_level: Option<String>,
    /// Routes the requests; a fresh id per request when unset.
    pub session_id: Option<String>,
    pub retry: Option<RetryPolicy>,
    pub callbacks: &'a dyn RetryCallbacks,
    /// Unix time in milliseconds, for the summary request's message.
    pub clock: fn() -> u64,
}

/// A summary's text and what generating it cost.
#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub text: String,
    pub usage: Usage,
}

/// What `compact` produced (`CompactionResult`); the session manager stores it.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionResult {
    pub summary: String,
    pub first_kept_entry_id: String,
    pub tokens_before: u64,
    pub usage: Usage,
    /// `{ readFiles, modifiedFiles }`.
    pub details: Value,
}

impl CompactionResult {
    pub fn to_json(&self) -> Value {
        json!({
            "summary": self.summary,
            "firstKeptEntryId": self.first_kept_entry_id,
            "tokensBefore": self.tokens_before,
            "usage": self.usage,
            "details": self.details,
        })
    }
}

/// Why a summary cannot be stored (`getSummarizationFailure`): an error, or a cut-off answer.
pub fn summarization_failure(response: &AssistantMessage, label: &str) -> Option<String> {
    match response.stop_reason {
        StopReason::Error => Some(format!(
            "{label} failed: {}",
            response
                .error_message
                .as_deref()
                .filter(|message| !message.is_empty())
                .unwrap_or("Unknown error")
        )),
        StopReason::Length => Some(format!(
            "{label} failed: generation hit the token cap and the summary is incomplete"
        )),
        _ => None,
    }
}

/// Two usages added up (`combineUsage`).
pub fn combine_usage(first: &Usage, second: &Usage) -> Usage {
    let either = |a: Option<u64>, b: Option<u64>| {
        (a.is_some() || b.is_some()).then(|| a.unwrap_or(0) + b.unwrap_or(0))
    };
    let mut usage = first.clone();
    usage.input += second.input;
    usage.output += second.output;
    usage.cache_read += second.cache_read;
    usage.cache_write += second.cache_write;
    usage.cache_write_1h = either(first.cache_write_1h, second.cache_write_1h);
    usage.reasoning = either(first.reasoning, second.reasoning);
    usage.total_tokens += second.total_tokens;
    usage.cost.input += second.cost.input;
    usage.cost.output += second.cost.output;
    usage.cost.cache_read += second.cost.cache_read;
    usage.cost.cache_write += second.cost.cache_write;
    usage.cost.total += second.cost.total;
    usage
}

/// The text blocks joined by newlines (`contentText`).
pub(crate) fn response_text(response: &AssistantMessage) -> String {
    response
        .content
        .iter()
        .filter_map(|block| match block {
            OutputBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The answer a stream ends with: its `done` or `error` message.
async fn stream_result(
    stream: &dyn StreamFn,
    model: &Model,
    messages: &[Message],
    request: &StreamRequest,
) -> AssistantMessage {
    let mut events = stream.stream(model, messages, request);
    let mut last = None;
    while let Some(event) = events.next().await {
        match event.event {
            AssistantEvent::Done { message, .. } | AssistantEvent::Error { error: message, .. } => {
                if let Message::Assistant(message) = message {
                    return *message;
                }
            }
            _ => last = Some(event.partial),
        }
    }
    let mut message = last.unwrap_or_else(|| {
        serde_json::from_value(json!({
            "content": [],
            "api": model.api,
            "provider": model.provider,
            "model": model.id,
            "usage": {
                "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
            },
            "stopReason": "error",
            "timestamp": 0,
        }))
        .expect("an assistant message")
    });
    message.stop_reason = StopReason::Error;
    message.error_message = Some("The stream ended without a result".into());
    message
}

impl Summarizer<'_> {
    /// One summary request with the summarizer's thinking level and session id.
    async fn complete(&self, prompt: String, max_tokens: f64) -> AssistantMessage {
        let reasoning = self
            .thinking_level
            .clone()
            .filter(|level| self.model.reasoning && level != "off");
        self.complete_with(prompt, max_tokens, reasoning, self.session_id.clone())
            .await
    }

    /// One summary request: `prompt` as the user message, at most `max_tokens` back
    /// (`completeSummarization`). Without a session id each request gets a new one.
    pub(crate) async fn complete_with(
        &self,
        prompt: String,
        max_tokens: f64,
        reasoning: Option<String>,
        session_id: Option<String>,
    ) -> AssistantMessage {
        let request = StreamRequest {
            options: SimpleOptions {
                reasoning,
                max_tokens: Some(max_tokens as u64),
                cache_retention: Some(CacheRetention::None),
                session_id: Some(session_id.unwrap_or_else(relay_session::ids::uuidv7)),
                env: self.env.clone(),
                headers: self.headers.clone(),
                ..SimpleOptions::default()
            },
            api_key: self.api_key.clone(),
            retry: RetryOptions::default(),
            signal: self.signal.clone(),
        };
        let messages = vec![
            Message::System(SystemMessage {
                content: Content::Text(SUMMARIZATION_SYSTEM_PROMPT.to_string()),
                sections: None,
                tools_added: None,
                tools_removed: None,
                timestamp: 0,
            }),
            Message::User(UserMessage {
                content: Content::Blocks(vec![InputBlock::Text(TextContent {
                    text: prompt,
                    text_signature: None,
                    volatile: None,
                })]),
                timestamp: (self.clock)(),
                origin: None,
            }),
        ];
        retry_assistant_call(
            || stream_result(self.stream, self.model, &messages, &request),
            self.retry,
            &self.signal,
            self.callbacks,
        )
        .await
    }

    /// The output budget: a share of the reserve, at most the model's limit.
    fn budget(&self, share: f64, reserve_tokens: f64) -> f64 {
        let cap = if self.model.max_tokens > 0 {
            self.model.max_tokens as f64
        } else {
            f64::INFINITY
        };
        (share * reserve_tokens).floor().min(cap)
    }

    /// A summary of `messages`, or an update of `previous_summary` with them
    /// (`generateSummaryWithUsage`).
    pub async fn generate_summary(
        &self,
        messages: &[Value],
        reserve_tokens: f64,
        custom_instructions: Option<&str>,
        previous_summary: Option<&str>,
    ) -> Result<Summary, String> {
        let max_tokens = self.budget(0.8, reserve_tokens);
        let mut base = if previous_summary.is_some_and(|summary| !summary.is_empty()) {
            UPDATE_SUMMARIZATION_PROMPT.to_string()
        } else {
            SUMMARIZATION_PROMPT.to_string()
        };
        if let Some(instructions) =
            custom_instructions.filter(|instructions| !instructions.is_empty())
        {
            base = format!("{base}\n\nAdditional focus: {instructions}");
        }
        let conversation = serialize_conversation(&convert_to_llm(messages));
        let mut prompt = format!("<conversation>\n{conversation}\n</conversation>\n\n");
        if let Some(previous) = previous_summary.filter(|summary| !summary.is_empty()) {
            prompt.push_str(&format!(
                "<previous-summary>\n{previous}\n</previous-summary>\n\n"
            ));
        }
        prompt.push_str(&base);
        let response = self.complete(prompt, max_tokens).await;
        if let Some(failure) = summarization_failure(&response, "Summarization") {
            return Err(failure);
        }
        if response
            .content
            .iter()
            .any(|block| matches!(block, OutputBlock::ToolCall(_)))
        {
            return Err("Summarization attempted to call a tool".into());
        }
        Ok(Summary {
            text: response_text(&response),
            usage: response.usage,
        })
    }

    /// A short checkpoint of a split turn's start (`generateTurnPrefixSummary`).
    async fn turn_prefix_summary(
        &self,
        messages: &[Value],
        reserve_tokens: f64,
    ) -> Result<Summary, String> {
        let max_tokens = self.budget(0.5, reserve_tokens);
        let conversation = serialize_conversation(&convert_to_llm(messages));
        let prompt = format!(
            "# Conversation\n{conversation}\n\n# Instructions\n{TURN_PREFIX_SUMMARIZATION_PROMPT}"
        );
        let response = self.complete(prompt, max_tokens).await;
        if let Some(failure) = summarization_failure(&response, "Turn prefix summarization") {
            return Err(failure);
        }
        if response
            .content
            .iter()
            .any(|block| matches!(block, OutputBlock::ToolCall(_)))
        {
            return Err("Turn prefix summarization attempted to call a tool".into());
        }
        Ok(Summary {
            text: response_text(&response),
            usage: response.usage,
        })
    }

    /// The compaction's summary, with the turn prefix for a split turn and the file lists
    /// (`compact`).
    pub async fn compact(
        &self,
        preparation: &CompactionPreparation,
        custom_instructions: Option<&str>,
    ) -> Result<CompactionResult, String> {
        let previous = preparation
            .previous_summary
            .as_ref()
            .and_then(Value::as_str);
        let reserve = preparation.settings.reserve_tokens;
        let (mut summary, usage) =
            if preparation.is_split_turn && !preparation.turn_prefix_messages.is_empty() {
                let mut history_text = previous.unwrap_or("No prior history.").to_string();
                let mut history_usage = None;
                if !preparation.messages_to_summarize.is_empty() {
                    let history = self
                        .generate_summary(
                            &preparation.messages_to_summarize,
                            reserve,
                            custom_instructions,
                            previous,
                        )
                        .await?;
                    history_text = history.text;
                    history_usage = Some(history.usage);
                }
                let prefix = self
                    .turn_prefix_summary(&preparation.turn_prefix_messages, reserve)
                    .await?;
                let usage = match history_usage {
                    Some(history) => combine_usage(&history, &prefix.usage),
                    None => prefix.usage,
                };
                (
                    format!(
                        "{history_text}\n\n---\n\n**Turn Context (split turn):**\n\n{}",
                        prefix.text
                    ),
                    usage,
                )
            } else {
                let result = self
                    .generate_summary(
                        &preparation.messages_to_summarize,
                        reserve,
                        custom_instructions,
                        previous,
                    )
                    .await?;
                (result.text, result.usage)
            };
        let (read, modified) = compute_file_lists(&preparation.file_ops);
        summary.push_str(&format_file_operations(&read, &modified));
        Ok(CompactionResult {
            summary,
            first_kept_entry_id: preparation.first_kept_entry_id.clone(),
            tokens_before: preparation.tokens_before,
            usage,
            details: details_json(&read, &modified),
        })
    }
}
