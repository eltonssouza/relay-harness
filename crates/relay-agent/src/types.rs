//! The loop's data and extension points, as `packages/agent/src/types.ts` defines them: the
//! messages it carries, the events it emits, what tools return, the hooks that steer it, and the
//! stream function that answers each request.
//!
//! Hooks, tools, the event sink and the stream function return boxed futures and streams, so
//! they can be trait objects and the loop's own future stays `Send`.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::future::{ready, BoxFuture};
use futures_util::stream::BoxStream;
use relay_ai::abort::AbortSignal;
use relay_ai::event::AssistantEvent;
use relay_ai::retry::RetryOptions;
use relay_ai::simple::SimpleOptions;
use relay_ai::{
    AssistantMessage, InputBlock, JsonObject, Message, Model, ToolCall, ToolResultMessage, Usage,
};
use serde::de::Error as _;
use serde::ser::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// A transcript entry: a message the model reads, or an application message (`role` of its
/// own, such as a UI note) that `AgentHooks::convert_to_llm` turns into model messages or drops.
///
/// Model messages are by far the most entries, so they are not boxed.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum AgentMessage {
    Llm(Message),
    Custom(Value),
}

impl AgentMessage {
    /// Its `role`; empty for an application message without one.
    pub fn role(&self) -> &str {
        match self {
            AgentMessage::Llm(Message::System(_)) => "system",
            AgentMessage::Llm(Message::User(_)) => "user",
            AgentMessage::Llm(Message::Assistant(_)) => "assistant",
            AgentMessage::Llm(Message::ToolResult(_)) => "toolResult",
            AgentMessage::Custom(value) => value.get("role").and_then(Value::as_str).unwrap_or(""),
        }
    }

    pub fn as_message(&self) -> Option<&Message> {
        match self {
            AgentMessage::Llm(message) => Some(message),
            AgentMessage::Custom(_) => None,
        }
    }
}

impl From<Message> for AgentMessage {
    fn from(message: Message) -> Self {
        AgentMessage::Llm(message)
    }
}

impl From<AssistantMessage> for AgentMessage {
    fn from(message: AssistantMessage) -> Self {
        AgentMessage::Llm(Message::Assistant(Box::new(message)))
    }
}

impl From<ToolResultMessage> for AgentMessage {
    fn from(message: ToolResultMessage) -> Self {
        AgentMessage::Llm(Message::ToolResult(message))
    }
}

impl<'de> Deserialize<'de> for AgentMessage {
    /// A model message by its `role`; any other role is an application message, kept as JSON.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        match value.get("role").and_then(Value::as_str) {
            Some("system" | "user" | "assistant" | "toolResult") => serde_json::from_value(value)
                .map(AgentMessage::Llm)
                .map_err(D::Error::custom),
            _ => Ok(AgentMessage::Custom(value)),
        }
    }
}

/// A provider event with the assistant message as streamed so far (`AssistantMessageEvent`).
/// For `done` and `error`, the event holds the final message and `partial` is not read.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamEvent {
    pub event: AssistantEvent,
    pub partial: AssistantMessage,
}

impl Serialize for StreamEvent {
    /// The event's fields, then `partial`, as the TypeScript event object has them.
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut value = serde_json::to_value(&self.event).map_err(S::Error::custom)?;
        let partial = Message::Assistant(Box::new(self.partial.clone()));
        if let Value::Object(fields) = &mut value {
            let partial = serde_json::to_value(partial).map_err(S::Error::custom)?;
            fields.insert("partial".into(), partial);
        }
        value.serialize(serializer)
    }
}

/// What a tool returns, finally or as a partial update (`AgentToolResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolResult {
    /// Text or images for the model.
    pub content: Vec<InputBlock>,
    /// Anything for logs and the UI; a present `null` stays.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub details: Option<Value>,
    /// The result in the tool's output schema, for programmatic callers; not sent to the model.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub structured_content: Option<Value>,
    /// Usage of the tool's own model calls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// A failure reported without failing the call: the model sees an error result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    /// Asks to stop after this batch; the loop stops only when every result in it asks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminate: Option<bool>,
}

impl AgentToolResult {
    /// An error result: the message as text, empty details.
    pub fn error(message: impl Into<String>) -> Self {
        AgentToolResult {
            content: vec![InputBlock::Text(relay_ai::TextContent {
                text: message.into(),
                text_signature: None,
                volatile: None,
            })],
            details: Some(Value::Object(JsonObject::new())),
            structured_content: None,
            usage: None,
            is_error: None,
            terminate: None,
        }
    }
}

/// Keeps a present `null` as `Some(Value::Null)`.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// A tool call after the hooks ran (`AgentToolCallOutcome`).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentToolCallOutcome {
    pub tool_call: ToolCall,
    pub result: AgentToolResult,
    pub is_error: bool,
}

/// How the calls of one assistant message run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolExecutionMode {
    /// Each call is prepared, run and finished before the next.
    Sequential,
    /// Calls are prepared one by one, then the allowed ones run together. `tool_execution_end`
    /// follows completion order; the result messages follow the calls' order.
    #[default]
    Parallel,
}

/// Receives a tool's partial results while it runs.
pub type ToolUpdate<'a> = &'a (dyn Fn(AgentToolResult) + Send + Sync);

/// A tool the loop can run (`AgentTool`).
pub trait AgentTool: Send + Sync {
    /// What the model sees: name, description and parameter schema.
    fn declaration(&self) -> &relay_ai::Tool;

    /// Whether the TypeScript agent builds this tool's schema with TypeBox, as it does for the
    /// built-in tools: only those get TypeBox's argument conversion.
    fn typebox(&self) -> bool {
        false
    }

    /// `Sequential` makes every batch this tool is in run sequentially.
    fn execution_mode(&self) -> Option<ToolExecutionMode> {
        None
    }

    /// Rewrites raw arguments before validation (`prepareArguments`); `None` keeps them. The
    /// hooks still see the call as the model sent it.
    fn prepare_arguments(&self, _arguments: &JsonObject) -> Result<Option<Value>, String> {
        Ok(None)
    }

    /// Runs the call with validated arguments. An `Err` is a thrown error: its message becomes
    /// the error result.
    fn execute<'a>(
        &'a self,
        tool_call_id: &'a str,
        params: Value,
        signal: &'a AbortSignal,
        on_update: ToolUpdate<'a>,
    ) -> BoxFuture<'a, Result<AgentToolResult, String>>;
}

/// The transcript and the tools that can run (`AgentContext`).
#[derive(Clone, Default)]
pub struct AgentContext {
    pub messages: Vec<AgentMessage>,
    pub tools: Vec<Arc<dyn AgentTool>>,
}

/// What `before_tool_call` receives.
#[derive(Clone, Copy)]
pub struct BeforeToolCallContext<'a> {
    pub assistant_message: &'a AssistantMessage,
    /// The call as the model sent it.
    pub tool_call: &'a ToolCall,
    /// The validated arguments.
    pub args: &'a Value,
    pub context: &'a AgentContext,
}

/// `before_tool_call`'s answer.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeforeToolCallResult {
    /// Prevents the call; an error result with `reason` takes its place.
    pub block: Option<bool>,
    pub reason: Option<String>,
    /// For a blocked call, asks to stop after the batch.
    pub terminate: Option<bool>,
}

/// What `after_tool_call` receives.
#[derive(Clone, Copy)]
pub struct AfterToolCallContext<'a> {
    pub assistant_message: &'a AssistantMessage,
    pub tool_call: &'a ToolCall,
    pub args: &'a Value,
    /// The result before any override.
    pub result: &'a AgentToolResult,
    pub is_error: bool,
    pub context: &'a AgentContext,
}

/// Overrides `after_tool_call` returns, field by field and without deep merges. A `content`
/// without `structured_content` drops the structured content, which may no longer match.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AfterToolCallResult {
    pub content: Option<Vec<InputBlock>>,
    pub details: Option<Value>,
    pub structured_content: Option<Value>,
    pub is_error: Option<bool>,
    pub usage: Option<Usage>,
    pub terminate: Option<bool>,
}

/// A completed turn (`AgentTurnContext`).
#[derive(Clone, Copy)]
pub struct AgentTurnContext<'a> {
    pub message: &'a AssistantMessage,
    pub tool_results: &'a [ToolResultMessage],
    /// The context with the turn's messages appended.
    pub context: &'a AgentContext,
    /// What the run returns if it ends now.
    pub new_messages: &'a [AgentMessage],
}

/// `finish_turn`'s decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum TurnDecision {
    /// Make sure one more request follows: tool results, steering or follow-ups satisfy it,
    /// otherwise the loop asks again with the current context.
    Continue,
    /// End the run without polling the queues.
    End,
}

/// Replacements for the next turn (`AgentLoopTurnUpdate`).
#[derive(Clone, Default)]
pub struct TurnUpdate {
    pub context: Option<AgentContext>,
    /// Appended before the next request, with the usual events.
    pub messages: Option<Vec<AgentMessage>>,
    pub model: Option<Model>,
    /// `off` turns reasoning off.
    pub thinking_level: Option<String>,
}

/// Replacements for the request being prepared (`AgentRequestUpdate`).
#[derive(Clone, Default)]
pub struct RequestUpdate {
    pub context: Option<AgentContext>,
    pub model: Option<Model>,
    pub thinking_level: Option<String>,
}

/// What `prepare_request` receives.
#[derive(Clone, Copy)]
pub struct PrepareRequestContext<'a> {
    pub context: &'a AgentContext,
    pub model: &'a Model,
    /// `off` when reasoning is off.
    pub thinking_level: &'a str,
}

/// The loop's callbacks (`AgentLoopConfig`'s functions). Each default does what an absent
/// TypeScript callback does.
pub trait AgentHooks: Send + Sync {
    /// The transcript as the model reads it (`convertToLlm`). The default keeps model messages
    /// and drops application messages, as the `Agent` class does.
    fn convert_to_llm(&self, messages: &[AgentMessage]) -> Vec<Message> {
        messages
            .iter()
            .filter_map(AgentMessage::as_message)
            .cloned()
            .collect()
    }

    /// Replaces the transcript before conversion, such as to prune it (`transformContext`);
    /// `None` keeps it.
    fn transform_context<'a>(
        &'a self,
        _messages: &'a [AgentMessage],
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<Vec<AgentMessage>>> {
        Box::pin(ready(None))
    }

    /// The API key for each request, for tokens that expire (`getApiKey`); none, or an empty
    /// key, uses the configured one.
    fn get_api_key<'a>(&'a self, _provider: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(ready(None))
    }

    /// After a turn's messages, before `turn_end` (`finishTurn`). Error and aborted responses
    /// end the run whatever it answers.
    fn finish_turn<'a>(
        &'a self,
        _turn: AgentTurnContext<'a>,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<TurnDecision>> {
        Box::pin(ready(None))
    }

    /// Before every request, the first included, after pending messages were appended
    /// (`prepareRequest`).
    fn prepare_request<'a>(
        &'a self,
        _request: PrepareRequestContext<'a>,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<RequestUpdate>> {
        Box::pin(ready(None))
    }

    /// Before each turn after the first (`prepareNextTurn`), such as to compact.
    fn prepare_next_turn<'a>(
        &'a self,
        _turn: AgentTurnContext<'a>,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<TurnUpdate>> {
        Box::pin(ready(None))
    }

    /// Messages the user steered while the agent worked, polled after each turn
    /// (`getSteeringMessages`).
    fn get_steering_messages(&self) -> BoxFuture<'_, Vec<AgentMessage>> {
        Box::pin(ready(Vec::new()))
    }

    /// Messages queued for when the agent would stop (`getFollowUpMessages`).
    fn get_follow_up_messages(&self) -> BoxFuture<'_, Vec<AgentMessage>> {
        Box::pin(ready(Vec::new()))
    }

    /// After validation, before running (`beforeToolCall`). An `Err` fails the call with its
    /// message, as a thrown error does.
    fn before_tool_call<'a>(
        &'a self,
        _call: BeforeToolCallContext<'a>,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Result<Option<BeforeToolCallResult>, String>> {
        Box::pin(ready(Ok(None)))
    }

    /// After running, before `tool_execution_end` (`afterToolCall`). An `Err` replaces the
    /// result with an error.
    fn after_tool_call<'a>(
        &'a self,
        _call: AfterToolCallContext<'a>,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Result<Option<AfterToolCallResult>, String>> {
        Box::pin(ready(Ok(None)))
    }
}

/// What a request carries besides the model and messages (`SimpleStreamOptions`).
#[derive(Debug, Clone)]
pub struct StreamRequest {
    /// The provider-neutral options; `reasoning` is the requested level.
    pub options: SimpleOptions,
    pub api_key: Option<String>,
    /// How often a failed request is retried (`maxRetries`, `maxRetryDelayMs`).
    pub retry: RetryOptions,
    pub signal: AbortSignal,
}

/// Answers a request with provider events (`StreamFn`). It never fails: a failure is an `error`
/// event whose message has stop reason `error` or `aborted`. The loop pulls each event and emits
/// what it causes before taking the next; it stops reading at `done` or `error`.
pub trait StreamFn: Send + Sync {
    fn stream<'a>(
        &'a self,
        model: &'a Model,
        messages: &'a [Message],
        request: &'a StreamRequest,
    ) -> BoxStream<'a, StreamEvent>;
}

/// The loop's settings (`AgentLoopConfig`'s values).
#[derive(Debug, Clone)]
pub struct AgentLoopConfig {
    pub model: Model,
    /// Request options; `reasoning` is the thinking level, none for off.
    pub options: SimpleOptions,
    pub api_key: Option<String>,
    /// Retries for each request; none by default.
    pub retry: RetryOptions,
    pub tool_execution: ToolExecutionMode,
    /// Unix time in milliseconds, for the messages the loop creates.
    pub clock: fn() -> u64,
}

impl AgentLoopConfig {
    pub fn new(model: Model) -> Self {
        AgentLoopConfig {
            model,
            options: SimpleOptions::default(),
            api_key: None,
            retry: RetryOptions::default(),
            tool_execution: ToolExecutionMode::Parallel,
            clock: now,
        }
    }
}

/// The system clock in Unix milliseconds.
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// What the loop emits (`AgentEvent`).
///
/// Each event goes to the sink once; boxing its large variants would only add allocations.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    AgentStart,
    /// The run's last event, with the messages it added.
    AgentEnd {
        messages: Vec<AgentMessage>,
    },
    /// A turn is one assistant response and its tool calls.
    TurnStart,
    #[serde(rename_all = "camelCase")]
    TurnEnd {
        message: AgentMessage,
        #[serde(serialize_with = "with_role")]
        tool_results: Vec<ToolResultMessage>,
    },
    MessageStart {
        message: AgentMessage,
    },
    /// While an assistant message streams.
    #[serde(rename_all = "camelCase")]
    MessageUpdate {
        message: AgentMessage,
        assistant_message_event: StreamEvent,
    },
    MessageEnd {
        message: AgentMessage,
    },
    #[serde(rename_all = "camelCase")]
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        args: Value,
    },
    #[serde(rename_all = "camelCase")]
    ToolExecutionUpdate {
        tool_call_id: String,
        tool_name: String,
        args: Value,
        partial_result: AgentToolResult,
    },
    #[serde(rename_all = "camelCase")]
    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        result: AgentToolResult,
        is_error: bool,
    },
}

/// Tool results with their `role`, as messages.
fn with_role<S: Serializer>(
    results: &[ToolResultMessage],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_seq(
        results
            .iter()
            .map(|result| Message::ToolResult(result.clone())),
    )
}

/// Receives the loop's events, in order. The loop awaits each before going on, as the TypeScript
/// loop awaits its listeners, so a listener can, say, steer before the next poll. Tools running
/// together share it. A plain closure is a sink that finishes at once.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: AgentEvent) -> BoxFuture<'_, ()>;
}

impl<F: Fn(AgentEvent) + Send + Sync> EventSink for F {
    fn emit(&self, event: AgentEvent) -> BoxFuture<'_, ()> {
        self(event);
        Box::pin(ready(()))
    }
}
