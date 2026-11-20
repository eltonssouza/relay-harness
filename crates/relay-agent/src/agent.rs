//! The stateful agent (`Agent` in `packages/agent/src/agent.ts`): it owns the transcript, runs
//! prompts and continuations through the loop, keeps the steering and follow-up queues, and
//! tells its listeners about every event.
//!
//! The transcript grows from the events: each `message_end` appends its message, as the
//! TypeScript agent's event reducer does. Listeners are awaited in subscription order after the
//! state is updated, so a listener can steer before the loop's next poll. An `Agent` is a handle:
//! clones share one agent, so a tool or a listener can steer, queue or abort the run it is in.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures_channel::oneshot;
use futures_util::future::{ready, BoxFuture};
use relay_ai::abort::{AbortController, AbortSignal};
use relay_ai::retry::RetryOptions;
use relay_ai::simple::SimpleOptions;
use relay_ai::transcript::{current_system_message, system_message_text};
use relay_ai::{
    AssistantMessage, Content, Cost, ImageContent, InputBlock, Message, Model, OutputBlock,
    StopReason, SystemMessage, TextContent, ToolResultMessage, Usage, UserMessage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::agent_loop::{run_agent_loop, run_agent_loop_continue, LoopRuntime};
use crate::types::{
    now, AfterToolCallContext, AfterToolCallResult, AgentContext, AgentEvent, AgentHooks,
    AgentLoopConfig, AgentMessage, AgentTool, AgentTurnContext, BeforeToolCallContext,
    BeforeToolCallResult, EventSink, PrepareRequestContext, RequestUpdate, StreamFn,
    ToolExecutionMode, TurnDecision, TurnUpdate,
};

/// How many queued messages a drain point takes (`QueueMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueueMode {
    /// Every queued message.
    All,
    /// The oldest one; the rest wait for later drain points.
    #[default]
    OneAtATime,
}

#[derive(Default)]
struct PendingQueue {
    messages: Vec<AgentMessage>,
    mode: QueueMode,
}

impl PendingQueue {
    fn peek(&self) -> Vec<AgentMessage> {
        match self.mode {
            QueueMode::All => self.messages.clone(),
            QueueMode::OneAtATime => self.messages.first().cloned().into_iter().collect(),
        }
    }

    fn drain(&mut self) -> Vec<AgentMessage> {
        let drained = self.peek();
        self.messages.drain(..drained.len());
        drained
    }
}

/// Receives the agent's events with the run's abort signal. A plain closure is a listener that
/// finishes at once.
pub trait AgentListener: Send + Sync {
    fn on_event<'a>(&'a self, event: &'a AgentEvent, signal: &'a AbortSignal) -> BoxFuture<'a, ()>;
}

impl<F: Fn(&AgentEvent, &AbortSignal) + Send + Sync> AgentListener for F {
    fn on_event<'a>(&'a self, event: &'a AgentEvent, signal: &'a AbortSignal) -> BoxFuture<'a, ()> {
        self(event, signal);
        Box::pin(ready(()))
    }
}

/// Identifies a subscription, to end it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ListenerId(u64);

/// Callbacks with nothing to add: the loop's defaults.
pub struct DefaultHooks;

impl AgentHooks for DefaultHooks {}

/// What the agent starts from (`AgentInitialState`). The prompt and the tools become the
/// leading system message unless `messages` already starts with one.
#[derive(Clone, Default)]
pub struct AgentInitialState {
    pub system_prompt: Option<String>,
    pub model: Option<Model>,
    /// `off` by default.
    pub thinking_level: Option<String>,
    pub tools: Vec<Arc<dyn AgentTool>>,
    pub messages: Vec<AgentMessage>,
}

/// How to build an agent (`AgentOptions`).
pub struct AgentOptions {
    pub initial_state: AgentInitialState,
    /// Conversion, context transforms, keys, tool and turn callbacks. The agent answers the
    /// steering and follow-up polls from its queues.
    pub hooks: Arc<dyn AgentHooks>,
    pub stream_fn: Arc<dyn StreamFn>,
    pub steering_mode: QueueMode,
    pub follow_up_mode: QueueMode,
    /// Forwarded to providers for cache-aware backends.
    pub session_id: Option<String>,
    pub thinking_budgets: Option<Map<String, Value>>,
    /// The longest provider-requested retry delay to wait.
    pub max_retry_delay_ms: Option<f64>,
    pub tool_execution: ToolExecutionMode,
    /// Unix milliseconds, for the messages the agent creates.
    pub clock: fn() -> u64,
}

impl AgentOptions {
    pub fn new(stream_fn: Arc<dyn StreamFn>) -> Self {
        AgentOptions {
            initial_state: AgentInitialState::default(),
            hooks: Arc::new(DefaultHooks),
            stream_fn,
            steering_mode: QueueMode::OneAtATime,
            follow_up_mode: QueueMode::OneAtATime,
            session_id: None,
            thinking_budgets: None,
            max_retry_delay_ms: None,
            tool_execution: ToolExecutionMode::Parallel,
            clock: now,
        }
    }
}

/// The agent's state at one moment (`AgentState`).
#[derive(Clone)]
pub struct AgentState {
    /// The current prompt, replayed from the transcript's system messages.
    pub system_prompt: String,
    pub model: Model,
    pub thinking_level: String,
    pub tools: Vec<Arc<dyn AgentTool>>,
    pub messages: Vec<AgentMessage>,
    /// From the start of a run until its listeners have finished with `agent_end`.
    pub is_streaming: bool,
    /// The message streaming now, if any.
    pub streaming_message: Option<AgentMessage>,
    /// Tool calls running now, in the order they started.
    pub pending_tool_calls: Vec<String>,
    /// From the last failed or aborted assistant turn.
    pub error_message: Option<String>,
}

struct StateData {
    model: Model,
    thinking_level: String,
    tools: Vec<Arc<dyn AgentTool>>,
    messages: Vec<AgentMessage>,
    is_streaming: bool,
    streaming_message: Option<AgentMessage>,
    pending_tool_calls: Vec<String>,
    error_message: Option<String>,
}

struct ActiveRun {
    controller: AbortController,
    idle: Vec<oneshot::Sender<()>>,
}

struct Settings {
    session_id: Option<String>,
    thinking_budgets: Option<Map<String, Value>>,
    max_retry_delay_ms: Option<f64>,
    tool_execution: ToolExecutionMode,
}

struct Inner {
    state: Mutex<StateData>,
    steering: Mutex<PendingQueue>,
    follow_up: Mutex<PendingQueue>,
    listeners: Mutex<Vec<(ListenerId, Arc<dyn AgentListener>)>>,
    next_listener: AtomicU64,
    active: Mutex<Option<ActiveRun>>,
    settings: Mutex<Settings>,
    hooks: Arc<dyn AgentHooks>,
    stream_fn: Arc<dyn StreamFn>,
    clock: fn() -> u64,
}

/// Locks, ignoring poisoning: the agent's data stays consistent between statements.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The model of an agent built without one (`DEFAULT_MODEL`).
fn unknown_model() -> Model {
    serde_json::from_value(json!({
        "id": "unknown", "name": "unknown", "api": "unknown", "provider": "unknown",
        "baseUrl": "", "reasoning": false, "input": [],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 0, "maxTokens": 0,
    }))
    .expect("the default model reads")
}

/// The system messages among the transcript's entries.
fn model_messages(messages: &[AgentMessage]) -> Vec<Message> {
    messages
        .iter()
        .filter_map(AgentMessage::as_message)
        .filter(|message| matches!(message, Message::System(_)))
        .cloned()
        .collect()
}

/// The leading system message for a prompt and tools (`createInitialSystemMessage`); none when
/// both are empty.
fn initial_system_message(
    prompt: Option<&str>,
    tools: &[Arc<dyn AgentTool>],
) -> Option<SystemMessage> {
    let prompt = prompt.filter(|prompt| !prompt.is_empty());
    if prompt.is_none() && tools.is_empty() {
        return None;
    }
    Some(SystemMessage {
        content: Content::Text(prompt.unwrap_or_default().to_string()),
        sections: None,
        tools_added: (!tools.is_empty()).then(|| {
            tools
                .iter()
                .map(|tool| tool.declaration().clone())
                .collect()
        }),
        tools_removed: None,
        timestamp: 0,
    })
}

/// A stateful agent: the transcript, the queues and the listeners around the loop.
#[derive(Clone)]
pub struct Agent {
    inner: Arc<Inner>,
}

impl Agent {
    pub fn new(options: AgentOptions) -> Self {
        let initial = options.initial_state;
        let mut messages = initial.messages;
        let starts_with_system = messages
            .first()
            .is_some_and(|message| message.role() == "system");
        if !starts_with_system {
            if let Some(system) =
                initial_system_message(initial.system_prompt.as_deref(), &initial.tools)
            {
                messages.insert(0, Message::System(system).into());
            }
        }
        let state = StateData {
            model: initial.model.unwrap_or_else(unknown_model),
            thinking_level: initial.thinking_level.unwrap_or_else(|| "off".into()),
            tools: initial.tools,
            messages,
            is_streaming: false,
            streaming_message: None,
            pending_tool_calls: Vec::new(),
            error_message: None,
        };
        Agent {
            inner: Arc::new(Inner {
                state: Mutex::new(state),
                steering: Mutex::new(PendingQueue {
                    messages: Vec::new(),
                    mode: options.steering_mode,
                }),
                follow_up: Mutex::new(PendingQueue {
                    messages: Vec::new(),
                    mode: options.follow_up_mode,
                }),
                listeners: Mutex::default(),
                next_listener: AtomicU64::new(0),
                active: Mutex::new(None),
                settings: Mutex::new(Settings {
                    session_id: options.session_id,
                    thinking_budgets: options.thinking_budgets,
                    max_retry_delay_ms: options.max_retry_delay_ms,
                    tool_execution: options.tool_execution,
                }),
                hooks: options.hooks,
                stream_fn: options.stream_fn,
                clock: options.clock,
            }),
        }
    }

    /// Listens to every event; listeners are awaited in subscription order.
    pub fn subscribe(&self, listener: Arc<dyn AgentListener>) -> ListenerId {
        let id = ListenerId(self.inner.next_listener.fetch_add(1, Ordering::SeqCst));
        lock(&self.inner.listeners).push((id, listener));
        id
    }

    /// Ends a subscription; false when it had ended.
    pub fn unsubscribe(&self, id: ListenerId) -> bool {
        let mut listeners = lock(&self.inner.listeners);
        let before = listeners.len();
        listeners.retain(|(listener, _)| *listener != id);
        listeners.len() != before
    }

    pub fn state(&self) -> AgentState {
        let state = lock(&self.inner.state);
        let system_prompt = current_system_message(&model_messages(&state.messages))
            .map(|system| system_message_text(&system))
            .unwrap_or_default();
        AgentState {
            system_prompt,
            model: state.model.clone(),
            thinking_level: state.thinking_level.clone(),
            tools: state.tools.clone(),
            messages: state.messages.clone(),
            is_streaming: state.is_streaming,
            streaming_message: state.streaming_message.clone(),
            pending_tool_calls: state.pending_tool_calls.clone(),
            error_message: state.error_message.clone(),
        }
    }

    /// The model for future turns.
    pub fn set_model(&self, model: Model) {
        lock(&self.inner.state).model = model;
    }

    /// The thinking level for future turns; `off` turns reasoning off.
    pub fn set_thinking_level(&self, level: impl Into<String>) {
        lock(&self.inner.state).thinking_level = level.into();
    }

    /// The tools that can run. Differences from the tools the transcript declares are announced
    /// to the model before the next request.
    pub fn set_tools(&self, tools: Vec<Arc<dyn AgentTool>>) {
        lock(&self.inner.state).tools = tools;
    }

    pub fn set_messages(&self, messages: Vec<AgentMessage>) {
        lock(&self.inner.state).messages = messages;
    }

    pub fn set_session_id(&self, session_id: Option<String>) {
        lock(&self.inner.settings).session_id = session_id;
    }

    pub fn set_tool_execution(&self, mode: ToolExecutionMode) {
        lock(&self.inner.settings).tool_execution = mode;
    }

    pub fn steering_mode(&self) -> QueueMode {
        lock(&self.inner.steering).mode
    }

    pub fn set_steering_mode(&self, mode: QueueMode) {
        lock(&self.inner.steering).mode = mode;
    }

    pub fn follow_up_mode(&self) -> QueueMode {
        lock(&self.inner.follow_up).mode
    }

    pub fn set_follow_up_mode(&self, mode: QueueMode) {
        lock(&self.inner.follow_up).mode = mode;
    }

    /// Queues a message for after the current turn.
    pub fn steer(&self, message: AgentMessage) {
        lock(&self.inner.steering).messages.push(message);
    }

    /// Queues a message for when the agent would stop.
    pub fn follow_up(&self, message: AgentMessage) {
        lock(&self.inner.follow_up).messages.push(message);
    }

    pub fn clear_steering_queue(&self) {
        lock(&self.inner.steering).messages.clear();
    }

    pub fn clear_follow_up_queue(&self) {
        lock(&self.inner.follow_up).messages.clear();
    }

    pub fn clear_all_queues(&self) {
        self.clear_steering_queue();
        self.clear_follow_up_queue();
    }

    pub fn has_queued_messages(&self) -> bool {
        !lock(&self.inner.steering).messages.is_empty()
            || !lock(&self.inner.follow_up).messages.is_empty()
    }

    /// The messages the next drain point takes, without taking them: steering first.
    pub fn peek_queued_messages(&self) -> Vec<AgentMessage> {
        let steering = lock(&self.inner.steering).peek();
        if steering.is_empty() {
            lock(&self.inner.follow_up).peek()
        } else {
            steering
        }
    }

    /// The current run's abort signal, if one is running.
    pub fn signal(&self) -> Option<AbortSignal> {
        lock(&self.inner.active)
            .as_ref()
            .map(|run| run.controller.signal())
    }

    /// Aborts the current run, if one is running.
    pub fn abort(&self) {
        if let Some(run) = lock(&self.inner.active).as_ref() {
            run.controller.abort();
        }
    }

    /// Completes when no run is going: after the current one's listeners have finished.
    pub async fn wait_for_idle(&self) {
        let receiver = {
            let mut active = lock(&self.inner.active);
            let Some(run) = active.as_mut() else {
                return;
            };
            let (sender, receiver) = oneshot::channel();
            run.idle.push(sender);
            receiver
        };
        let _ = receiver.await;
    }

    /// Clears the conversation and the queues, keeping the replayed prompt and tool baseline.
    pub fn reset(&self) -> Result<(), String> {
        if lock(&self.inner.active).is_some() {
            return Err(
                "Agent is already processing. Wait for completion before resetting.".into(),
            );
        }
        {
            let mut state = lock(&self.inner.state);
            let baseline = current_system_message(&model_messages(&state.messages));
            state.messages = baseline
                .map(|system| vec![Message::System(system).into()])
                .unwrap_or_default();
            state.is_streaming = false;
            state.streaming_message = None;
            state.pending_tool_calls.clear();
            state.error_message = None;
        }
        self.clear_all_queues();
        Ok(())
    }

    /// Runs a prompt of the given messages.
    pub async fn prompt(&self, messages: Vec<AgentMessage>) -> Result<(), String> {
        self.check_idle(
            "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
        )?;
        self.run_prompt(messages, false).await
    }

    /// Runs a prompt of text, with images after it.
    pub async fn prompt_text(&self, text: &str, images: Vec<ImageContent>) -> Result<(), String> {
        let mut content = vec![InputBlock::Text(TextContent {
            text: text.to_string(),
            text_signature: None,
            volatile: None,
        })];
        content.extend(images.into_iter().map(InputBlock::Image));
        let message = Message::User(UserMessage {
            content: Content::Blocks(content),
            timestamp: (self.inner.clock)(),
            origin: None,
        });
        self.prompt(vec![message.into()]).await
    }

    /// Continues from the transcript (`continue()`). After an assistant message, it runs the
    /// queued steering, else the queued follow-ups; otherwise the last message must be one the
    /// model answers.
    pub async fn continue_run(&self) -> Result<(), String> {
        self.check_idle("Agent is already processing. Wait for completion before continuing.")?;
        let last_role = {
            let state = lock(&self.inner.state);
            let only_system = state
                .messages
                .iter()
                .all(|message| message.role() == "system");
            match state.messages.last() {
                Some(last) if !only_system => last.role().to_string(),
                _ => return Err("No messages to continue from".into()),
            }
        };
        if last_role == "assistant" {
            let steering = lock(&self.inner.steering).drain();
            if !steering.is_empty() {
                return self.run_prompt(steering, true).await;
            }
            let follow_ups = lock(&self.inner.follow_up).drain();
            if !follow_ups.is_empty() {
                return self.run_prompt(follow_ups, false).await;
            }
            return Err("Cannot continue from message role: assistant".into());
        }
        let signal = self.begin_run()?;
        let (context, config) = self.loop_inputs();
        let hooks = RunHooks::new(&self.inner, false);
        let sink = AgentSink {
            inner: &self.inner,
            signal: signal.clone(),
        };
        let runtime = LoopRuntime {
            hooks: &hooks,
            stream_fn: &*self.inner.stream_fn,
            signal: &signal,
            sink: &sink,
        };
        if let Err(message) = run_agent_loop_continue(context, config, runtime).await {
            self.fail_run(message, signal.is_aborted(), &sink).await;
        }
        self.finish_run();
        Ok(())
    }

    fn check_idle(&self, message: &str) -> Result<(), String> {
        if lock(&self.inner.active).is_some() {
            return Err(message.into());
        }
        Ok(())
    }

    async fn run_prompt(
        &self,
        messages: Vec<AgentMessage>,
        skip_initial_steering_poll: bool,
    ) -> Result<(), String> {
        let signal = self.begin_run()?;
        let (context, config) = self.loop_inputs();
        let hooks = RunHooks::new(&self.inner, skip_initial_steering_poll);
        let sink = AgentSink {
            inner: &self.inner,
            signal: signal.clone(),
        };
        let runtime = LoopRuntime {
            hooks: &hooks,
            stream_fn: &*self.inner.stream_fn,
            signal: &signal,
            sink: &sink,
        };
        run_agent_loop(messages, context, config, runtime).await;
        self.finish_run();
        Ok(())
    }

    /// Starts a run (`runWithLifecycle`): its abort controller, and the state of a run.
    fn begin_run(&self) -> Result<AbortSignal, String> {
        let signal = {
            let mut active = lock(&self.inner.active);
            if active.is_some() {
                return Err("Agent is already processing.".into());
            }
            let controller = AbortController::new();
            let signal = controller.signal();
            *active = Some(ActiveRun {
                controller,
                idle: Vec::new(),
            });
            signal
        };
        let mut state = lock(&self.inner.state);
        state.is_streaming = true;
        state.streaming_message = None;
        state.error_message = None;
        Ok(signal)
    }

    /// Ends a run (`finishRun`) and wakes whoever waits for idle.
    fn finish_run(&self) {
        {
            let mut state = lock(&self.inner.state);
            state.is_streaming = false;
            state.streaming_message = None;
            state.pending_tool_calls.clear();
        }
        let run = lock(&self.inner.active).take();
        for sender in run.into_iter().flat_map(|run| run.idle) {
            let _ = sender.send(());
        }
    }

    /// Reports a run the loop could not start as a failed turn (`handleRunFailure`).
    async fn fail_run(&self, message: String, aborted: bool, sink: &AgentSink<'_>) {
        let model = lock(&self.inner.state).model.clone();
        let failure: AgentMessage = AssistantMessage {
            content: vec![OutputBlock::Text(TextContent {
                text: String::new(),
                text_signature: None,
                volatile: None,
            })],
            api: model.api,
            provider: model.provider,
            model: model.id,
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
            stop_reason: if aborted {
                StopReason::Aborted
            } else {
                StopReason::Error
            },
            deferred: None,
            error_message: Some(message),
            raw_stop_reason: None,
            end_turn: None,
            timestamp: (self.inner.clock)(),
        }
        .into();
        let events = [
            AgentEvent::MessageStart {
                message: failure.clone(),
            },
            AgentEvent::MessageEnd {
                message: failure.clone(),
            },
            AgentEvent::TurnEnd {
                message: failure.clone(),
                tool_results: Vec::<ToolResultMessage>::new(),
            },
            AgentEvent::AgentEnd {
                messages: vec![failure],
            },
        ];
        for event in events {
            sink.emit(event).await;
        }
    }

    /// The loop's context and config from the current state (`createContextSnapshot`,
    /// `createLoopConfig`).
    fn loop_inputs(&self) -> (AgentContext, AgentLoopConfig) {
        let state = lock(&self.inner.state);
        let settings = lock(&self.inner.settings);
        let context = AgentContext {
            messages: state.messages.clone(),
            tools: state.tools.clone(),
        };
        let config = AgentLoopConfig {
            model: state.model.clone(),
            options: SimpleOptions {
                reasoning: (state.thinking_level != "off").then(|| state.thinking_level.clone()),
                session_id: settings.session_id.clone(),
                thinking_budgets: settings.thinking_budgets.clone(),
                ..SimpleOptions::default()
            },
            api_key: None,
            retry: RetryOptions {
                max_retries: 0,
                max_retry_delay_ms: settings.max_retry_delay_ms,
            },
            tool_execution: settings.tool_execution,
            clock: self.inner.clock,
        };
        (context, config)
    }
}

/// The caller's hooks, with the steering and follow-up polls answered from the agent's queues.
struct RunHooks<'a> {
    inner: &'a Inner,
    /// A continuation that starts from queued steering takes it as its prompt: the first poll
    /// must not deliver more.
    skip_initial_steering_poll: AtomicBool,
}

impl<'a> RunHooks<'a> {
    fn new(inner: &'a Inner, skip_initial_steering_poll: bool) -> Self {
        RunHooks {
            inner,
            skip_initial_steering_poll: AtomicBool::new(skip_initial_steering_poll),
        }
    }
}

impl AgentHooks for RunHooks<'_> {
    fn convert_to_llm(&self, messages: &[AgentMessage]) -> Vec<Message> {
        self.inner.hooks.convert_to_llm(messages)
    }

    fn transform_context<'a>(
        &'a self,
        messages: &'a [AgentMessage],
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<Vec<AgentMessage>>> {
        self.inner.hooks.transform_context(messages, signal)
    }

    fn get_api_key<'a>(&'a self, provider: &'a str) -> BoxFuture<'a, Option<String>> {
        self.inner.hooks.get_api_key(provider)
    }

    fn finish_turn<'a>(
        &'a self,
        turn: AgentTurnContext<'a>,
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<TurnDecision>> {
        self.inner.hooks.finish_turn(turn, signal)
    }

    fn prepare_request<'a>(
        &'a self,
        request: PrepareRequestContext<'a>,
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<RequestUpdate>> {
        self.inner.hooks.prepare_request(request, signal)
    }

    fn prepare_next_turn<'a>(
        &'a self,
        turn: AgentTurnContext<'a>,
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<TurnUpdate>> {
        self.inner.hooks.prepare_next_turn(turn, signal)
    }

    fn get_steering_messages(&self) -> BoxFuture<'_, Vec<AgentMessage>> {
        let messages = if self
            .skip_initial_steering_poll
            .swap(false, Ordering::SeqCst)
        {
            Vec::new()
        } else {
            lock(&self.inner.steering).drain()
        };
        Box::pin(ready(messages))
    }

    fn get_follow_up_messages(&self) -> BoxFuture<'_, Vec<AgentMessage>> {
        Box::pin(ready(lock(&self.inner.follow_up).drain()))
    }

    fn before_tool_call<'a>(
        &'a self,
        call: BeforeToolCallContext<'a>,
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Result<Option<BeforeToolCallResult>, String>> {
        self.inner.hooks.before_tool_call(call, signal)
    }

    fn after_tool_call<'a>(
        &'a self,
        call: AfterToolCallContext<'a>,
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Result<Option<AfterToolCallResult>, String>> {
        self.inner.hooks.after_tool_call(call, signal)
    }
}

/// Updates the state for each event, then awaits the listeners (`processEvents`).
struct AgentSink<'a> {
    inner: &'a Inner,
    signal: AbortSignal,
}

impl AgentSink<'_> {
    fn reduce(&self, event: &AgentEvent) {
        let mut state = lock(&self.inner.state);
        match event {
            AgentEvent::MessageStart { message } | AgentEvent::MessageUpdate { message, .. } => {
                state.streaming_message = Some(message.clone());
            }
            AgentEvent::MessageEnd { message } => {
                state.streaming_message = None;
                state.messages.push(message.clone());
            }
            AgentEvent::ToolExecutionStart { tool_call_id, .. } => {
                state.pending_tool_calls.push(tool_call_id.clone());
            }
            AgentEvent::ToolExecutionEnd { tool_call_id, .. } => {
                state.pending_tool_calls.retain(|id| id != tool_call_id);
            }
            AgentEvent::TurnEnd {
                message: AgentMessage::Llm(Message::Assistant(message)),
                ..
            } => {
                if let Some(error) = message
                    .error_message
                    .as_ref()
                    .filter(|error| !error.is_empty())
                {
                    state.error_message = Some(error.clone());
                }
            }
            AgentEvent::AgentEnd { .. } => state.streaming_message = None,
            _ => {}
        }
    }
}

impl EventSink for AgentSink<'_> {
    fn emit(&self, event: AgentEvent) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.reduce(&event);
            let listeners: Vec<Arc<dyn AgentListener>> = lock(&self.inner.listeners)
                .iter()
                .map(|(_, listener)| Arc::clone(listener))
                .collect();
            for listener in listeners {
                listener.on_event(&event, &self.signal).await;
            }
        })
    }
}
