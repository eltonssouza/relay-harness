//! The agent loop (`runAgentLoop` and `runAgentLoopContinue` in `agent-loop.ts`): ask the model,
//! run the tool calls it makes, append the results, and ask again until it stops calling tools.
//! Between turns it takes steered messages; when it would stop, queued follow-ups. Before each
//! request, tools the transcript does not declare yet are announced in a system message.

use std::sync::Arc;

use futures_channel::mpsc;
use futures_util::future::{join, join_all, ready, BoxFuture};
use futures_util::StreamExt;
use relay_ai::abort::AbortSignal;
use relay_ai::event::AssistantEvent;
use relay_ai::transcript::{current_tools, tool_state_changes, ToolStateChanges};
use relay_ai::validation::validate_tool_arguments;
use relay_ai::{
    AssistantMessage, Content, Cost, Message, OutputBlock, StopReason, SystemMessage, ToolCall,
    ToolResultMessage, Usage,
};
use serde_json::Value;

use crate::types::{
    AfterToolCallContext, AgentContext, AgentEvent, AgentHooks, AgentLoopConfig, AgentMessage,
    AgentTool, AgentToolCallOutcome, AgentToolResult, AgentTurnContext, BeforeToolCallContext,
    EventSink, PrepareRequestContext, StreamFn, StreamRequest, ToolExecutionMode, TurnDecision,
};

/// What the loop calls out to.
#[derive(Clone, Copy)]
pub struct LoopRuntime<'a> {
    pub hooks: &'a dyn AgentHooks,
    pub stream_fn: &'a dyn StreamFn,
    pub signal: &'a AbortSignal,
    /// Each event is awaited before the loop goes on, as the TypeScript loop awaits its
    /// listeners: a listener can steer before the next poll.
    pub sink: &'a dyn EventSink,
}

/// Runs the loop with new prompt messages, appended to the context first. Returns the messages
/// the run added, the prompts included.
pub async fn run_agent_loop(
    prompts: Vec<AgentMessage>,
    context: AgentContext,
    config: AgentLoopConfig,
    runtime: LoopRuntime<'_>,
) -> Vec<AgentMessage> {
    let mut context = context;
    let initial = declare_tool_changes(&context, prompts, config.clock);
    context.messages.extend(initial.iter().cloned());
    let mut new_messages = initial.clone();
    let sink = runtime.sink;
    sink.emit(AgentEvent::AgentStart).await;
    sink.emit(AgentEvent::TurnStart).await;
    for message in &initial {
        emit_message(sink, message).await;
    }
    run_loop(&mut context, &mut new_messages, config, runtime).await;
    new_messages
}

/// Runs the loop from the context as it is, for a retry: the last message must not be the
/// assistant's. Returns the messages the run added.
pub async fn run_agent_loop_continue(
    context: AgentContext,
    config: AgentLoopConfig,
    runtime: LoopRuntime<'_>,
) -> Result<Vec<AgentMessage>, String> {
    match context.messages.last() {
        None => return Err("Cannot continue: no messages in context".into()),
        Some(last) if last.role() == "assistant" => {
            return Err("Cannot continue from message role: assistant".into())
        }
        Some(_) => {}
    }
    let mut context = context;
    let mut new_messages = Vec::new();
    runtime.sink.emit(AgentEvent::AgentStart).await;
    runtime.sink.emit(AgentEvent::TurnStart).await;
    run_loop(&mut context, &mut new_messages, config, runtime).await;
    Ok(new_messages)
}

/// The requested level, or `off`.
fn thinking_level(config: &AgentLoopConfig) -> &str {
    config.options.reasoning.as_deref().unwrap_or("off")
}

/// Applies a replacement thinking level: `off` turns reasoning off.
fn set_thinking_level(config: &mut AgentLoopConfig, level: Option<String>) {
    if let Some(level) = level {
        config.options.reasoning = (level != "off").then_some(level);
    }
}

async fn emit_message(sink: &dyn EventSink, message: &AgentMessage) {
    sink.emit(AgentEvent::MessageStart {
        message: message.clone(),
    })
    .await;
    sink.emit(AgentEvent::MessageEnd {
        message: message.clone(),
    })
    .await;
}

async fn run_loop(
    context: &mut AgentContext,
    new_messages: &mut Vec<AgentMessage>,
    config: AgentLoopConfig,
    runtime: LoopRuntime<'_>,
) {
    let LoopRuntime {
        hooks,
        signal,
        sink,
        ..
    } = runtime;
    let mut config = config;
    let mut last_turn: Option<(AssistantMessage, Vec<ToolResultMessage>)> = None;
    let mut explicit_continuation = false;
    // Messages steered while the run was starting.
    let mut pending = hooks.get_steering_messages().await;

    loop {
        let mut has_more_tool_calls = true;
        while has_more_tool_calls || !pending.is_empty() {
            let mut prepared = Vec::new();
            if let Some((message, tool_results)) = &last_turn {
                let turn = AgentTurnContext {
                    message,
                    tool_results,
                    context,
                    new_messages,
                };
                if let Some(update) = hooks.prepare_next_turn(turn).await {
                    if let Some(replacement) = update.context {
                        *context = replacement;
                    }
                    prepared = update.messages.unwrap_or_default();
                    if let Some(model) = update.model {
                        config.model = model;
                    }
                    set_thinking_level(&mut config, update.thinking_level);
                }
                // Preparation can take long (compaction): take what was steered meanwhile, unless
                // the last poll returned messages, so one-at-a-time delivery stays one.
                if pending.is_empty() {
                    pending = hooks.get_steering_messages().await;
                }
                sink.emit(AgentEvent::TurnStart).await;
            }

            prepared.append(&mut pending);
            for message in declare_tool_changes(context, prepared, config.clock) {
                emit_message(sink, &message).await;
                context.messages.push(message.clone());
                new_messages.push(message);
            }

            let request = PrepareRequestContext {
                context,
                model: &config.model,
                thinking_level: thinking_level(&config),
            };
            if let Some(update) = hooks.prepare_request(request, signal).await {
                if let Some(replacement) = update.context {
                    *context = replacement;
                }
                if let Some(model) = update.model {
                    config.model = model;
                }
                set_thinking_level(&mut config, update.thinking_level);
            }

            let message = stream_assistant_response(context, &config, runtime).await;
            new_messages.push(message.clone().into());

            if matches!(message.stop_reason, StopReason::Error | StopReason::Aborted) {
                let turn = AgentTurnContext {
                    message: &message,
                    tool_results: &[],
                    context,
                    new_messages,
                };
                hooks.finish_turn(turn, signal).await;
                sink.emit(AgentEvent::TurnEnd {
                    message: message.into(),
                    tool_results: Vec::new(),
                })
                .await;
                sink.emit(AgentEvent::AgentEnd {
                    messages: new_messages.clone(),
                })
                .await;
                return;
            }

            let tool_calls: Vec<ToolCall> = message
                .content
                .iter()
                .filter_map(|block| match block {
                    OutputBlock::ToolCall(call) => Some(call.clone()),
                    _ => None,
                })
                .collect();
            let mut tool_results = Vec::new();
            has_more_tool_calls = false;
            if !tool_calls.is_empty() {
                // Output cut by the token limit may carry truncated arguments: fail every call
                // instead of running it.
                let batch = if message.stop_reason == StopReason::Length {
                    fail_truncated_tool_calls(&tool_calls, config.clock, sink).await
                } else {
                    execute_tool_calls(context, &message, &tool_calls, &config, runtime).await
                };
                tool_results = batch.messages;
                has_more_tool_calls = !batch.terminate;
                for result in &tool_results {
                    context.messages.push(result.clone().into());
                    new_messages.push(result.clone().into());
                }
            }

            let turn = AgentTurnContext {
                message: &message,
                tool_results: &tool_results,
                context,
                new_messages,
            };
            let decision = hooks.finish_turn(turn, signal).await;
            sink.emit(AgentEvent::TurnEnd {
                message: message.clone().into(),
                tool_results: tool_results.clone(),
            })
            .await;
            last_turn = Some((message, tool_results));

            if decision == Some(TurnDecision::End) {
                sink.emit(AgentEvent::AgentEnd {
                    messages: new_messages.clone(),
                })
                .await;
                return;
            }
            explicit_continuation = decision == Some(TurnDecision::Continue);
            pending = hooks.get_steering_messages().await;
            if has_more_tool_calls || !pending.is_empty() {
                explicit_continuation = false;
            }
        }

        // The agent would stop here: follow-ups start another turn.
        let follow_ups = hooks.get_follow_up_messages().await;
        if !follow_ups.is_empty() {
            explicit_continuation = false;
            pending = follow_ups;
            continue;
        }
        // Nothing else asked for a request: `finish_turn`'s continuation gets one with the
        // current context.
        if explicit_continuation {
            explicit_continuation = false;
            continue;
        }
        break;
    }

    sink.emit(AgentEvent::AgentEnd {
        messages: new_messages.clone(),
    })
    .await;
}

/// Announces tool changes to the model (`declareToolChanges`).
///
/// `context.tools` is what can run; the transcript's system messages declare what the model may
/// call. Their difference becomes `toolsAdded` and `toolsRemoved` on a system message. A pending
/// system message carries it, its own tool fields replaced so replaying the transcript yields
/// exactly `context.tools`; otherwise a new system message goes before the first pending message
/// that is not one.
fn declare_tool_changes(
    context: &AgentContext,
    pending: Vec<AgentMessage>,
    clock: fn() -> u64,
) -> Vec<AgentMessage> {
    let system_index = pending
        .iter()
        .rposition(|message| message.role() == "system");
    let pending_system = system_index.and_then(|index| match &pending[index] {
        AgentMessage::Llm(Message::System(system)) => Some(system.clone()),
        _ => None,
    });
    let baseline: Vec<AgentMessage> = match (&pending_system, system_index) {
        (Some(system), Some(index)) => {
            let mut baseline = pending.clone();
            baseline[index] = Message::System(with_tool_changes(system, Default::default())).into();
            baseline
        }
        _ => pending.clone(),
    };
    let transcript: Vec<Message> = context
        .messages
        .iter()
        .chain(&baseline)
        .filter_map(|message| match message {
            AgentMessage::Llm(message @ Message::System(_)) => Some(message.clone()),
            _ => None,
        })
        .collect();
    let executable: Vec<relay_ai::Tool> = context
        .tools
        .iter()
        .map(|tool| tool.declaration().clone())
        .collect();
    let changes = tool_state_changes(&current_tools(&transcript), &executable);
    let unchanged = changes.tools_added.is_empty() && changes.tools_removed.is_empty();

    if let (Some(system), Some(index)) = (pending_system, system_index) {
        let declares = system
            .tools_added
            .as_ref()
            .is_some_and(|tools| !tools.is_empty())
            || system
                .tools_removed
                .as_ref()
                .is_some_and(|tools| !tools.is_empty());
        if unchanged && !declares {
            return pending;
        }
        let mut messages = baseline;
        messages[index] = Message::System(with_tool_changes(&system, changes)).into();
        return messages;
    }
    if unchanged {
        return pending;
    }
    let update = with_tool_changes(
        &SystemMessage {
            content: Content::Text(String::new()),
            sections: None,
            tools_added: None,
            tools_removed: None,
            timestamp: clock(),
        },
        changes,
    );
    let index = pending
        .iter()
        .position(|message| message.role() != "system")
        .unwrap_or(pending.len());
    let mut messages = pending;
    messages.insert(index, Message::System(update).into());
    messages
}

/// The system message with its tool fields replaced; an empty list leaves the field out.
fn with_tool_changes(message: &SystemMessage, changes: ToolStateChanges) -> SystemMessage {
    SystemMessage {
        tools_added: (!changes.tools_added.is_empty()).then_some(changes.tools_added),
        tools_removed: (!changes.tools_removed.is_empty()).then_some(changes.tools_removed),
        ..message.clone()
    }
}

/// An assistant message for a stream that ended without its final event.
fn unfinished_message(
    config: &AgentLoopConfig,
    partial: Option<AssistantMessage>,
) -> AssistantMessage {
    let mut message = partial.unwrap_or_else(|| AssistantMessage {
        content: Vec::new(),
        api: config.model.api.clone(),
        provider: config.model.provider.clone(),
        model: config.model.id.clone(),
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
        stop_reason: StopReason::Error,
        deferred: None,
        error_message: None,
        raw_stop_reason: None,
        end_turn: None,
        timestamp: (config.clock)(),
    });
    message.stop_reason = StopReason::Error;
    message.error_message = Some("The response stream ended without a final message".into());
    message
}

fn assistant_of(message: &Message) -> Option<AssistantMessage> {
    match message {
        Message::Assistant(message) => Some((**message).clone()),
        _ => None,
    }
}

/// Streams one response (`streamAssistantResponse`). The transcript becomes model messages
/// here; the partial message stands in the context while it streams.
async fn stream_assistant_response(
    context: &mut AgentContext,
    config: &AgentLoopConfig,
    runtime: LoopRuntime<'_>,
) -> AssistantMessage {
    let LoopRuntime {
        hooks,
        stream_fn,
        signal,
        sink,
    } = runtime;
    let transformed = hooks.transform_context(&context.messages, signal).await;
    let messages = hooks.convert_to_llm(transformed.as_deref().unwrap_or(&context.messages));
    let api_key = hooks
        .get_api_key(&config.model.provider)
        .await
        .filter(|key| !key.is_empty())
        .or_else(|| config.api_key.clone());
    let request = StreamRequest {
        options: config.options.clone(),
        api_key,
        retry: config.retry,
        signal: signal.clone(),
    };

    let mut partial: Option<AssistantMessage> = None;
    let mut finished: Option<AssistantMessage> = None;
    let mut events = stream_fn.stream(&config.model, &messages, &request);
    while let Some(stream_event) = events.next().await {
        match &stream_event.event {
            AssistantEvent::Start => {
                let message = stream_event.partial;
                context.messages.push(message.clone().into());
                partial = Some(message.clone());
                sink.emit(AgentEvent::MessageStart {
                    message: message.into(),
                })
                .await;
            }
            AssistantEvent::Done { message, .. } | AssistantEvent::Error { error: message, .. } => {
                finished = assistant_of(message);
                break;
            }
            _ => {
                if partial.is_none() {
                    continue;
                }
                let message = stream_event.partial.clone();
                if let Some(last) = context.messages.last_mut() {
                    *last = message.clone().into();
                }
                partial = Some(message.clone());
                sink.emit(AgentEvent::MessageUpdate {
                    message: message.into(),
                    assistant_message_event: stream_event,
                })
                .await;
            }
        }
    }
    drop(events);

    let added_partial = partial.is_some();
    let mut message = finished.unwrap_or_else(|| unfinished_message(config, partial));
    // The requested level, whichever stream function answered.
    message.thinking_level = Some(thinking_level(config).to_string());
    if added_partial {
        if let Some(last) = context.messages.last_mut() {
            *last = message.clone().into();
        }
    } else {
        context.messages.push(message.clone().into());
        sink.emit(AgentEvent::MessageStart {
            message: message.clone().into(),
        })
        .await;
    }
    sink.emit(AgentEvent::MessageEnd {
        message: message.clone().into(),
    })
    .await;
    message
}

struct ToolBatch {
    messages: Vec<ToolResultMessage>,
    terminate: bool,
}

async fn tool_execution_start(sink: &dyn EventSink, tool_call: &ToolCall) {
    sink.emit(AgentEvent::ToolExecutionStart {
        tool_call_id: tool_call.id.clone(),
        tool_name: tool_call.name.clone(),
        args: Value::Object(tool_call.arguments.clone()),
    })
    .await;
}

async fn tool_execution_end(sink: &dyn EventSink, outcome: &AgentToolCallOutcome) {
    sink.emit(AgentEvent::ToolExecutionEnd {
        tool_call_id: outcome.tool_call.id.clone(),
        tool_name: outcome.tool_call.name.clone(),
        result: outcome.result.clone(),
        is_error: outcome.is_error,
    })
    .await;
}

fn tool_result_message(outcome: &AgentToolCallOutcome, clock: fn() -> u64) -> ToolResultMessage {
    ToolResultMessage {
        tool_call_id: outcome.tool_call.id.clone(),
        tool_name: outcome.tool_call.name.clone(),
        content: outcome.result.content.clone(),
        details: outcome.result.details.clone(),
        usage: outcome.result.usage.clone(),
        nested_calls: None,
        is_error: outcome.is_error,
        timestamp: clock(),
    }
}

fn failed(tool_call: &ToolCall, result: AgentToolResult) -> AgentToolCallOutcome {
    AgentToolCallOutcome {
        tool_call: tool_call.clone(),
        result,
        is_error: true,
    }
}

/// Fails every call of a response cut by the output limit (`failToolCallsFromTruncatedMessage`).
async fn fail_truncated_tool_calls(
    tool_calls: &[ToolCall],
    clock: fn() -> u64,
    sink: &dyn EventSink,
) -> ToolBatch {
    let mut messages = Vec::new();
    for tool_call in tool_calls {
        tool_execution_start(sink, tool_call).await;
        let outcome = failed(
            tool_call,
            AgentToolResult::error(format!(
                "Tool call \"{}\" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.",
                tool_call.name
            )),
        );
        tool_execution_end(sink, &outcome).await;
        let message = tool_result_message(&outcome, clock);
        emit_message(sink, &message.clone().into()).await;
        messages.push(message);
    }
    ToolBatch {
        messages,
        terminate: false,
    }
}

/// Stops after the batch only when every result asks to.
fn should_terminate(outcomes: &[AgentToolCallOutcome]) -> bool {
    !outcomes.is_empty()
        && outcomes
            .iter()
            .all(|outcome| outcome.result.terminate == Some(true))
}

async fn execute_tool_calls(
    context: &AgentContext,
    assistant: &AssistantMessage,
    tool_calls: &[ToolCall],
    config: &AgentLoopConfig,
    runtime: LoopRuntime<'_>,
) -> ToolBatch {
    let sequential_tool = tool_calls.iter().any(|call| {
        context
            .tools
            .iter()
            .find(|tool| tool.declaration().name == call.name)
            .is_some_and(|tool| tool.execution_mode() == Some(ToolExecutionMode::Sequential))
    });
    if config.tool_execution == ToolExecutionMode::Sequential || sequential_tool {
        execute_sequential(context, assistant, tool_calls, config, runtime).await
    } else {
        execute_parallel(context, assistant, tool_calls, config, runtime).await
    }
}

async fn execute_sequential(
    context: &AgentContext,
    assistant: &AssistantMessage,
    tool_calls: &[ToolCall],
    config: &AgentLoopConfig,
    runtime: LoopRuntime<'_>,
) -> ToolBatch {
    let sink = runtime.sink;
    let mut outcomes = Vec::new();
    let mut messages = Vec::new();
    for tool_call in tool_calls {
        tool_execution_start(sink, tool_call).await;
        let outcome = match prepare_tool_call(context, assistant, tool_call, runtime).await {
            Preparation::Immediate(outcome) => *outcome,
            Preparation::Prepared { tool, args } => {
                let executed = execute_prepared(&*tool, tool_call, args.clone(), runtime).await;
                finalize(context, assistant, tool_call, &args, executed, runtime).await
            }
        };
        tool_execution_end(sink, &outcome).await;
        let message = tool_result_message(&outcome, config.clock);
        emit_message(sink, &message.clone().into()).await;
        outcomes.push(outcome);
        messages.push(message);
        if runtime.signal.is_aborted() {
            break;
        }
    }
    ToolBatch {
        messages,
        terminate: should_terminate(&outcomes),
    }
}

async fn execute_parallel(
    context: &AgentContext,
    assistant: &AssistantMessage,
    tool_calls: &[ToolCall],
    config: &AgentLoopConfig,
    runtime: LoopRuntime<'_>,
) -> ToolBatch {
    let LoopRuntime { signal, sink, .. } = runtime;
    let mut entries: Vec<BoxFuture<'_, AgentToolCallOutcome>> = Vec::new();
    for tool_call in tool_calls {
        tool_execution_start(sink, tool_call).await;
        match prepare_tool_call(context, assistant, tool_call, runtime).await {
            Preparation::Immediate(outcome) => {
                tool_execution_end(sink, &outcome).await;
                entries.push(Box::pin(ready(*outcome)));
            }
            Preparation::Prepared { tool, args } => entries.push(Box::pin(async move {
                let outcome = if signal.is_aborted() {
                    failed(tool_call, AgentToolResult::error("Operation aborted"))
                } else {
                    let executed = execute_prepared(&*tool, tool_call, args.clone(), runtime).await;
                    finalize(context, assistant, tool_call, &args, executed, runtime).await
                };
                tool_execution_end(sink, &outcome).await;
                outcome
            })),
        }
        if signal.is_aborted() {
            break;
        }
    }

    // Started together; each ends when it finishes, the messages keep the calls' order. A tool
    // that finishes without waiting runs to its end before the next starts, where JavaScript
    // interleaves such calls by microtask: only end events of calls finishing at the same
    // moment can come in another order.
    let outcomes = join_all(entries).await;
    let mut messages = Vec::new();
    for outcome in &outcomes {
        let message = tool_result_message(outcome, config.clock);
        emit_message(sink, &message.clone().into()).await;
        messages.push(message);
    }
    ToolBatch {
        messages,
        terminate: should_terminate(&outcomes),
    }
}

enum Preparation {
    /// Finished without running: unknown tool, invalid arguments, blocked or aborted.
    Immediate(Box<AgentToolCallOutcome>),
    Prepared {
        tool: Arc<dyn AgentTool>,
        args: Value,
    },
}

/// Finds the tool, validates the arguments and asks `before_tool_call` (`prepareToolCall`).
async fn prepare_tool_call(
    context: &AgentContext,
    assistant: &AssistantMessage,
    tool_call: &ToolCall,
    runtime: LoopRuntime<'_>,
) -> Preparation {
    let LoopRuntime { hooks, signal, .. } = runtime;
    let fail = |message: String| {
        Preparation::Immediate(Box::new(failed(tool_call, AgentToolResult::error(message))))
    };
    let aborted = || fail("Operation aborted".into());
    let Some(tool) = context
        .tools
        .iter()
        .find(|tool| tool.declaration().name == tool_call.name)
    else {
        return fail(format!("Tool {} not found", tool_call.name));
    };
    let arguments = match tool.prepare_arguments(&tool_call.arguments) {
        Ok(Some(arguments)) => arguments,
        Ok(None) => Value::Object(tool_call.arguments.clone()),
        Err(message) => return fail(message),
    };
    let declaration = tool.declaration();
    let args = match validate_tool_arguments(
        &tool_call.name,
        &declaration.parameters,
        tool.typebox(),
        &arguments,
    ) {
        Ok(args) => args,
        Err(message) => return fail(message),
    };
    let call = BeforeToolCallContext {
        assistant_message: assistant,
        tool_call,
        args: &args,
        context,
    };
    match hooks.before_tool_call(call, signal).await {
        Err(message) => return fail(message),
        Ok(_) if signal.is_aborted() => return aborted(),
        Ok(Some(before)) if before.block == Some(true) => {
            let reason = before
                .reason
                .filter(|reason| !reason.is_empty())
                .unwrap_or_else(|| "Tool execution was blocked".into());
            let mut result = AgentToolResult::error(reason);
            if before.terminate == Some(true) {
                result.terminate = Some(true);
            }
            return Preparation::Immediate(Box::new(failed(tool_call, result)));
        }
        Ok(_) => {}
    }
    if signal.is_aborted() {
        return aborted();
    }
    Preparation::Prepared {
        tool: Arc::clone(tool),
        args,
    }
}

/// Runs a prepared call (`executePreparedToolCall`). Its updates are emitted while it runs, all
/// of them before it finishes; updates after it settles are dropped.
async fn execute_prepared(
    tool: &dyn AgentTool,
    tool_call: &ToolCall,
    args: Value,
    runtime: LoopRuntime<'_>,
) -> (AgentToolResult, bool) {
    let (updates, mut received) = mpsc::unbounded();
    let on_update = |partial_result: AgentToolResult| {
        // Fails once the channel is closed: the tool has settled.
        let _ = updates.unbounded_send(partial_result);
    };
    let run = async {
        let outcome = tool
            .execute(&tool_call.id, args, runtime.signal, &on_update)
            .await;
        updates.close_channel();
        outcome
    };
    let pump = async {
        while let Some(partial_result) = received.next().await {
            runtime
                .sink
                .emit(AgentEvent::ToolExecutionUpdate {
                    tool_call_id: tool_call.id.clone(),
                    tool_name: tool_call.name.clone(),
                    args: Value::Object(tool_call.arguments.clone()),
                    partial_result,
                })
                .await;
        }
    };
    let (outcome, ()) = join(run, pump).await;
    match outcome {
        Ok(result) => {
            let is_error = result.is_error == Some(true);
            (result, is_error)
        }
        Err(message) => (AgentToolResult::error(message), true),
    }
}

/// Applies `after_tool_call`'s overrides (`finalizeExecutedToolCall`).
async fn finalize(
    context: &AgentContext,
    assistant: &AssistantMessage,
    tool_call: &ToolCall,
    args: &Value,
    executed: (AgentToolResult, bool),
    runtime: LoopRuntime<'_>,
) -> AgentToolCallOutcome {
    let (mut result, mut is_error) = executed;
    let call = AfterToolCallContext {
        assistant_message: assistant,
        tool_call,
        args,
        result: &result,
        is_error,
        context,
    };
    match runtime.hooks.after_tool_call(call, runtime.signal).await {
        Ok(None) => {}
        Ok(Some(after)) => {
            // Structured content not replaced along with the content may no longer match it.
            let structured_content = after.structured_content.or(if after.content.is_some() {
                None
            } else {
                result.structured_content.take()
            });
            result = AgentToolResult {
                content: after.content.unwrap_or(result.content),
                details: after.details.or(result.details),
                structured_content,
                usage: after.usage.or(result.usage),
                is_error: result.is_error,
                terminate: after.terminate.or(result.terminate),
            };
            is_error = after.is_error.unwrap_or(is_error);
        }
        Err(message) => {
            result = AgentToolResult::error(message);
            is_error = true;
        }
    }
    AgentToolCallOutcome {
        tool_call: tool_call.clone(),
        result,
        is_error,
    }
}
