//! The harness on an agent (`HarnessCore` in `packages/agent/src/harness/harness-core.ts`): the
//! pillars of `relay_harness_core` wired to the agent's hooks and events.
//!
//! | Pillar    | Hook                | Effect                                                    |
//! |-----------|---------------------|-----------------------------------------------------------|
//! | Alignment | `before_tool_call`  | gate destructive and external effects, guard question turns |
//! | Alignment | `transform_context` | restate developer constraints next to the latest message  |
//! | Evidence  | `finish_turn`       | steer a verification request when a claim lacks evidence  |
//! | Context   | `transform_context` | recent tool window, batched elision, progress digest      |
//!
//! The events tell the pillars what happened: developer requests and corrections, each tool
//! call's effect and outcome. The engine decides; this module translates between it and the
//! agent's messages. The slice signals, which need a workspace probe, are not ported yet.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures_util::future::{ready, BoxFuture};
use relay_ai::abort::AbortSignal;
use relay_ai::text::js_length;
use relay_ai::{
    AssistantMessage, Content, InputBlock, JsonObject, Message, Origin, OutputBlock, StopReason,
    TextContent, ToolCall, UserMessage,
};
use relay_harness_core::alignment::{
    AlignmentDecision, AlignmentPolicyOptions, AllowedVia, BlockKind, DeveloperConstraint,
};
use relay_harness_core::context::{
    ContextMessage, ContextPolicyOptions, ContextStats, ContextToolCall,
};
use relay_harness_core::effects::{self, ClassifyContext, ToolEffect};
use relay_harness_core::engine::{EngineOptions, HarnessEngine};
use relay_harness_core::evidence::CompletionReport;
use relay_harness_core::json::{effect_to_json, report_to_json, stats_to_json};
use serde_json::{json, Value};

use crate::agent::{Agent, AgentListener, ListenerId, WeakAgent};
use crate::types::{
    now, AfterToolCallContext, AfterToolCallResult, AgentEvent, AgentHooks, AgentMessage,
    AgentToolResult, AgentTurnContext, BeforeToolCallContext, BeforeToolCallResult,
    PrepareRequestContext, RequestUpdate, TurnDecision, TurnUpdate,
};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a pillar decided (`HarnessCoreEvent`), for the UI, logs and telemetry.
#[derive(Debug, Clone, PartialEq)]
pub enum HarnessCoreEvent {
    ToolBlocked {
        tool_name: String,
        effect: ToolEffect,
        kind: BlockKind,
        reason: String,
    },
    ToolAuthorized {
        tool_name: String,
        effect: ToolEffect,
        via: AllowedVia,
    },
    CompletionAssessed {
        report: CompletionReport,
    },
    ContextElided {
        stats: ContextStats,
    },
}

impl HarnessCoreEvent {
    /// The event as the TypeScript harness reports it.
    pub fn to_json(&self) -> Value {
        match self {
            HarnessCoreEvent::ToolBlocked {
                tool_name,
                effect,
                kind,
                reason,
            } => json!({
                "type": "tool_blocked",
                "toolName": tool_name,
                "effect": effect_to_json(effect),
                "kind": kind.as_str(),
                "reason": reason,
            }),
            HarnessCoreEvent::ToolAuthorized {
                tool_name,
                effect,
                via,
            } => json!({
                "type": "tool_authorized",
                "toolName": tool_name,
                "effect": effect_to_json(effect),
                "via": via.as_str(),
            }),
            HarnessCoreEvent::CompletionAssessed { report } => {
                json!({ "type": "completion_assessed", "report": report_to_json(report) })
            }
            HarnessCoreEvent::ContextElided { stats } => {
                json!({ "type": "context_elided", "stats": stats_to_json(stats) })
            }
        }
    }
}

/// A risky call the interactive authorizer is asked about.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthorizationRequest {
    pub tool_name: String,
    pub effect: ToolEffect,
    /// Identifies the operation, so an approval covers the same call again.
    pub fingerprint: String,
}

impl AuthorizationRequest {
    /// The request as the TypeScript harness passes it.
    pub fn to_json(&self) -> Value {
        json!({
            "toolName": self.tool_name,
            "effect": effect_to_json(&self.effect),
            "fingerprint": self.fingerprint,
        })
    }
}

/// Asks the developer about a risky call (`authorize`): approved, declined, or no answer, which
/// leaves it to the developer's next message.
pub trait Authorizer: Send + Sync {
    fn authorize<'a>(
        &'a self,
        request: &'a AuthorizationRequest,
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<bool>>;
}

/// The effect of a tool the default rules do not know, such as an MCP tool's hints.
pub type EffectClassifier = dyn Fn(&ToolCall) -> Option<ToolEffect> + Send + Sync;

/// Observes the pillars' decisions. Must not panic.
pub type HarnessObserver = dyn Fn(&HarnessCoreEvent) + Send + Sync;

/// How to build the harness (`HarnessCoreOptions`). `None` disables a pillar.
#[derive(Clone)]
pub struct HarnessCoreOptions {
    pub alignment: Option<AlignmentPolicyOptions>,
    /// The interactive authorizer; without one, risky calls wait for the developer's approval in
    /// chat.
    pub authorize: Option<Arc<dyn Authorizer>>,
    /// Verification requests per developer request.
    pub evidence_max_gates: Option<usize>,
    pub context: Option<ContextPolicyOptions>,
    /// The characters an image counts for when tool results are sized.
    pub image_chars: usize,
    /// The project's checks, such as `npm run check`; when set, only they count as evidence.
    pub verify_commands: Vec<String>,
    pub classify_effect: Option<Arc<EffectClassifier>>,
    /// Workspace root and home, so writes outside the workspace or to hooks and credentials are
    /// gated.
    pub workspace: ClassifyContext,
    pub on_event: Option<Arc<HarnessObserver>>,
    /// Unix milliseconds, for the verification requests.
    pub clock: fn() -> u64,
}

impl Default for HarnessCoreOptions {
    fn default() -> Self {
        HarnessCoreOptions {
            alignment: Some(AlignmentPolicyOptions::default()),
            authorize: None,
            evidence_max_gates: Some(1),
            context: Some(ContextPolicyOptions::default()),
            image_chars: 4000,
            verify_commands: Vec::new(),
            classify_effect: None,
            workspace: ClassifyContext::default(),
            on_event: None,
            clock: now,
        }
    }
}

/// One tool call a delegated agent ran (`DelegatedOutcome`).
#[derive(Debug, Clone, PartialEq)]
pub struct DelegatedOutcome {
    pub effect: ToolEffect,
    pub is_error: bool,
    pub output: Option<String>,
}

/// Who wrote a user message (`messageOrigin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageOrigin {
    Developer,
    Extension,
    Harness,
    Agent,
}

/// Prefix of the user messages older code wrote for the harness before messages had an origin.
const HARNESS_MESSAGE_PREFIX: &str = "[harness";

fn text_of(blocks: &[InputBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            InputBlock::Text(text) => Some(text.text.as_str()),
            InputBlock::Image(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The plain text of a user, assistant or tool-result message (`messageText`).
pub fn message_text(message: &AgentMessage) -> String {
    match message {
        AgentMessage::Llm(Message::User(user)) => match &user.content {
            Content::Text(text) => text.clone(),
            Content::Blocks(blocks) => text_of(blocks),
        },
        AgentMessage::Llm(Message::ToolResult(result)) => text_of(&result.content),
        AgentMessage::Llm(Message::Assistant(assistant)) => assistant_text(assistant),
        _ => String::new(),
    }
}

fn assistant_text(message: &AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            OutputBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Who wrote a user message; none for other roles. The typed origin decides; a message without
/// one that starts with the legacy harness prefix is the harness's.
pub fn message_origin(message: &AgentMessage) -> Option<MessageOrigin> {
    let AgentMessage::Llm(Message::User(user)) = message else {
        return None;
    };
    Some(match user.origin {
        Some(Origin::Extension) => MessageOrigin::Extension,
        Some(Origin::Harness) => MessageOrigin::Harness,
        Some(Origin::Agent) => MessageOrigin::Agent,
        None if message_text(message)
            .trim_start()
            .starts_with(HARNESS_MESSAGE_PREFIX) =>
        {
            MessageOrigin::Harness
        }
        None => MessageOrigin::Developer,
    })
}

/// A tool call as the engine reads it: its name and string arguments.
fn engine_call(name: &str, arguments: &JsonObject) -> effects::ToolCall {
    effects::ToolCall {
        name: name.to_string(),
        arguments: arguments
            .iter()
            .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
            .collect(),
    }
}

/// The text of a tool result, for output-based evidence (`resultText`).
fn result_text(result: &AgentToolResult) -> String {
    text_of(&result.content)
}

/// The harness state appended to the latest user or tool-result message (`appendHarnessState`),
/// marked volatile: it is restated on every request and gone from the next.
fn append_harness_state(mut messages: Vec<AgentMessage>, state: &str) -> Vec<AgentMessage> {
    let block = InputBlock::Text(TextContent {
        text: format!("<harness_state>\n{state}\n</harness_state>"),
        text_signature: None,
        volatile: Some(true),
    });
    match messages.last_mut() {
        Some(AgentMessage::Llm(Message::User(user))) => {
            let mut content = match &user.content {
                Content::Text(text) => vec![InputBlock::Text(TextContent {
                    text: text.clone(),
                    text_signature: None,
                    volatile: None,
                })],
                Content::Blocks(blocks) => blocks.clone(),
            };
            content.push(block);
            user.content = Content::Blocks(content);
        }
        Some(AgentMessage::Llm(Message::ToolResult(result))) => result.content.push(block),
        _ => {}
    }
    messages
}

/// The pillars of one agent, usable directly or installed on an [`Agent`].
pub struct HarnessCore {
    engine: Mutex<HarnessEngine>,
    authorize: Option<Arc<dyn Authorizer>>,
    classify_effect: Option<Arc<EffectClassifier>>,
    on_event: Option<Arc<HarnessObserver>>,
    image_chars: usize,
    clock: fn() -> u64,
    last_elided_results: Mutex<usize>,
}

impl HarnessCore {
    pub fn new(options: HarnessCoreOptions) -> Self {
        let has_authorizer = options.authorize.is_some();
        let engine = HarnessEngine::new(EngineOptions {
            alignment: options.alignment.map(|alignment| AlignmentPolicyOptions {
                has_authorizer,
                ..alignment
            }),
            evidence_max_gates: options.evidence_max_gates,
            context: options.context,
            verify_commands: options.verify_commands,
            workspace: options.workspace,
        });
        HarnessCore {
            engine: Mutex::new(engine),
            authorize: options.authorize,
            classify_effect: options.classify_effect,
            on_event: options.on_event,
            image_chars: options.image_chars,
            clock: options.clock,
            last_elided_results: Mutex::new(0),
        }
    }

    fn emit(&self, event: HarnessCoreEvent) {
        if let Some(observer) = &self.on_event {
            observer(&event);
        }
    }

    /// Runs `f` on the engine: its constraints, corrections, pending authorizations and reports.
    pub fn with_engine<R>(&self, f: impl FnOnce(&mut HarnessEngine) -> R) -> R {
        f(&mut lock(&self.engine))
    }

    /// The developer's constraints in force.
    pub fn constraints(&self) -> Vec<DeveloperConstraint> {
        self.with_engine(|engine| {
            engine
                .alignment
                .as_ref()
                .map(|alignment| alignment.constraints.list().to_vec())
                .unwrap_or_default()
        })
    }

    /// What a tool call does to the world: the custom classifier's answer, else the default
    /// rules'.
    pub fn classify(&self, tool_call: &ToolCall) -> ToolEffect {
        let custom = self
            .classify_effect
            .as_ref()
            .and_then(|classify| classify(tool_call));
        let call = engine_call(&tool_call.name, &tool_call.arguments);
        lock(&self.engine).classify(&call, custom)
    }

    /// A developer request starts: per-request evidence resets.
    pub fn begin_request(&self, text: &str) {
        lock(&self.engine).begin_request(text);
    }

    /// A developer message arrived; `after_agent_work` when the agent had responded, so the
    /// message can correct it.
    pub fn observe_developer_message(&self, text: &str, timestamp: u64, after_agent_work: bool) {
        lock(&self.engine).observe_developer_message(text, timestamp as f64, after_agent_work);
    }

    /// Collaboration rules for the system prompt; none when alignment is off.
    pub fn prompt_guidelines(&self) -> &'static [&'static str] {
        lock(&self.engine).prompt_guidelines()
    }

    /// The alignment check of a validated tool call (`beforeToolCall`): a block, or none.
    pub async fn before_tool_call(
        &self,
        tool_call: &ToolCall,
        signal: &AbortSignal,
    ) -> Option<BeforeToolCallResult> {
        lock(&self.engine).alignment.as_ref()?;
        let effect = self.classify(tool_call);
        let decision = lock(&self.engine).check(&tool_call.name, &effect);
        let decision = match decision {
            AlignmentDecision::AskAuthorizer { fingerprint } => {
                let request = AuthorizationRequest {
                    tool_name: tool_call.name.clone(),
                    effect: effect.clone(),
                    fingerprint,
                };
                let approved = match &self.authorize {
                    Some(authorize) => authorize.authorize(&request, signal).await,
                    None => None,
                };
                lock(&self.engine).resolve_authorization(&effect, &request.fingerprint, approved)
            }
            decision => decision,
        };
        match decision {
            AlignmentDecision::Block { reason, kind } => {
                self.emit(HarnessCoreEvent::ToolBlocked {
                    tool_name: tool_call.name.clone(),
                    effect,
                    kind,
                    reason: reason.clone(),
                });
                Some(BeforeToolCallResult {
                    block: Some(true),
                    reason: Some(reason),
                    terminate: None,
                })
            }
            AlignmentDecision::Allow { via: Some(via) } => {
                self.emit(HarnessCoreEvent::ToolAuthorized {
                    tool_name: tool_call.name.clone(),
                    effect,
                    via,
                });
                None
            }
            _ => None,
        }
    }

    /// The evidence clock when a call starts, for [`HarnessCore::record_tool_outcome`].
    pub fn begin_tool_call(&self) -> Option<f64> {
        lock(&self.engine).begin_tool_call()
    }

    /// The outcome of a run or blocked tool call; `output` is its text.
    pub fn record_tool_outcome(
        &self,
        tool_call: &ToolCall,
        is_error: bool,
        output: &str,
        started_at: Option<f64>,
    ) {
        let effect = self.classify(tool_call);
        lock(&self.engine).record_tool_outcome(&effect, is_error, output, started_at);
    }

    /// The calls a delegated agent ran, in order, as if this agent had run them: a delegated
    /// edit without a check still gates this agent's completion. Call it while the delegating
    /// tool runs.
    pub fn record_delegated_effects(&self, outcomes: &[DelegatedOutcome]) {
        let mut engine = lock(&self.engine);
        for outcome in outcomes {
            let output = outcome.output.as_deref().unwrap_or("");
            engine.record_tool_outcome(&outcome.effect, outcome.is_error, output, None);
        }
    }

    /// The conversation moved to another branch: drop the context stubs and digest, pending
    /// approvals and grants.
    pub fn resync(&self) {
        lock(&self.engine).resync();
    }

    /// What the context pillar reads of each message.
    fn context_summary(&self, messages: &[AgentMessage]) -> Vec<ContextMessage> {
        messages
            .iter()
            .map(|message| match message {
                AgentMessage::Llm(Message::Assistant(assistant)) => ContextMessage::Assistant {
                    tool_calls: assistant
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            OutputBlock::ToolCall(call) => Some(ContextToolCall {
                                id: call.id.clone(),
                                call: engine_call(&call.name, &call.arguments),
                                arguments_json: serde_json::to_string(&call.arguments)
                                    .unwrap_or_default(),
                                effect: self
                                    .classify_effect
                                    .as_ref()
                                    .and_then(|classify| classify(call)),
                            }),
                            _ => None,
                        })
                        .collect(),
                },
                AgentMessage::Llm(Message::ToolResult(result)) => ContextMessage::ToolResult {
                    tool_call_id: result.tool_call_id.clone(),
                    tool_name: result.tool_name.clone(),
                    chars: result
                        .content
                        .iter()
                        .map(|block| match block {
                            InputBlock::Text(text) => js_length(&text.text),
                            InputBlock::Image(_) => self.image_chars,
                        })
                        .sum(),
                    is_error: result.is_error,
                },
                _ => ContextMessage::Other,
            })
            .collect()
    }

    /// One request's messages (`transformContext`): aged tool results elided, then the harness
    /// state next to the latest message.
    pub fn transform_context(&self, messages: Vec<AgentMessage>) -> Vec<AgentMessage> {
        let mut messages = messages;
        let has_context = lock(&self.engine).context.is_some();
        if has_context {
            let summary = self.context_summary(&messages);
            let stubs: HashMap<String, String> = lock(&self.engine)
                .transform_context(&summary)
                .into_iter()
                .collect();
            for message in &mut messages {
                if let AgentMessage::Llm(Message::ToolResult(result)) = message {
                    if let Some(stub) = stubs.get(&result.tool_call_id) {
                        result.content = vec![InputBlock::Text(TextContent {
                            text: stub.clone(),
                            text_signature: None,
                            volatile: None,
                        })];
                    }
                }
            }
        }
        let stats = lock(&self.engine)
            .context
            .as_ref()
            .map(|context| context.stats());
        if let Some(stats) = stats {
            let mut last = lock(&self.last_elided_results);
            if stats.elided_results != *last {
                *last = stats.elided_results;
                drop(last);
                self.emit(HarnessCoreEvent::ContextElided { stats });
            }
        }
        match self.render_state() {
            Some(state) => append_harness_state(messages, &state),
            None => messages,
        }
    }

    /// Judges a final assistant message: its report, and the verification request to send back
    /// when the claim lacks evidence and the gate allows one.
    pub fn assess_final_message(
        &self,
        message: &AssistantMessage,
    ) -> Option<(CompletionReport, Option<AgentMessage>)> {
        let assessment = lock(&self.engine).assess_final_message(&assistant_text(message))?;
        self.emit(HarnessCoreEvent::CompletionAssessed {
            report: assessment.report.clone(),
        });
        let request = assessment.verification_request.map(|text| {
            Message::User(UserMessage {
                content: Content::Blocks(vec![InputBlock::Text(TextContent {
                    text,
                    text_signature: None,
                    volatile: None,
                })]),
                timestamp: (self.clock)(),
                origin: Some(Origin::Harness),
            })
            .into()
        });
        Some((assessment.report, request))
    }

    /// The harness state restated next to the latest message, if there is any.
    pub fn render_state(&self) -> Option<String> {
        lock(&self.engine).render_state(None)
    }

    /// Installs the pillars on an agent; its hooks keep running, wrapped. Uninstalling restores
    /// them.
    pub fn install(self: &Arc<Self>, agent: &Agent) -> Installation {
        let previous = agent.hooks();
        let responded = agent
            .state()
            .messages
            .iter()
            .any(|message| message.role() == "assistant");
        let listener = agent.subscribe(Arc::new(HarnessListener {
            core: Arc::clone(self),
            state: Mutex::new(ListenerState {
                // A resumed conversation already holds the agent's work.
                agent_has_responded: responded,
                ..ListenerState::default()
            }),
        }));
        agent.set_hooks(Arc::new(HarnessHooks {
            core: Arc::clone(self),
            previous: Arc::clone(&previous),
            agent: agent.downgrade(),
        }));
        Installation {
            agent: agent.downgrade(),
            previous,
            listener,
        }
    }
}

/// The harness installed on an agent; [`Installation::uninstall`] removes it.
pub struct Installation {
    agent: WeakAgent,
    previous: Arc<dyn AgentHooks>,
    listener: ListenerId,
}

impl Installation {
    /// Restores the agent's previous hooks and stops listening.
    pub fn uninstall(self) {
        if let Some(agent) = self.agent.upgrade() {
            agent.set_hooks(self.previous);
            agent.unsubscribe(self.listener);
        }
    }
}

#[derive(Default)]
struct ListenerState {
    /// The calls that are running, and when each started, so a check run alongside an edit
    /// does not cover it.
    tool_calls: HashMap<String, (ToolCall, Option<f64>)>,
    /// The run's own prompt follows `agent_start`; continuations have none.
    awaiting_request: bool,
    agent_has_responded: bool,
}

/// Tells the pillars what happened.
struct HarnessListener {
    core: Arc<HarnessCore>,
    state: Mutex<ListenerState>,
}

impl HarnessListener {
    fn observe(&self, event: &AgentEvent) {
        let mut state = lock(&self.state);
        match event {
            AgentEvent::AgentStart => state.awaiting_request = true,
            AgentEvent::MessageEnd { message } => match message_origin(message) {
                Some(MessageOrigin::Developer) => {
                    let text = message_text(message);
                    if state.awaiting_request {
                        self.core.begin_request(&text);
                    }
                    state.awaiting_request = false;
                    let timestamp = match message {
                        AgentMessage::Llm(Message::User(user)) => user.timestamp,
                        _ => 0,
                    };
                    self.core.observe_developer_message(
                        &text,
                        timestamp,
                        state.agent_has_responded,
                    );
                }
                // An extension or a delegating agent wrote it. A brief a model wrote must not
                // authorize what it names: it asks for evidence, but states no constraints,
                // grants nothing and corrects nothing.
                Some(MessageOrigin::Extension | MessageOrigin::Agent) => {
                    if state.awaiting_request {
                        self.core.begin_request(&message_text(message));
                    }
                    state.awaiting_request = false;
                }
                Some(MessageOrigin::Harness) => {}
                None if message.role() == "assistant" => {
                    state.awaiting_request = false;
                    state.agent_has_responded = true;
                }
                None => {}
            },
            AgentEvent::ToolExecutionStart {
                tool_call_id,
                tool_name,
                args,
            } => {
                let call = ToolCall {
                    id: tool_call_id.clone(),
                    name: tool_name.clone(),
                    arguments: args.as_object().cloned().unwrap_or_default(),
                    thought_signature: None,
                    namespace: None,
                };
                let started = self.core.begin_tool_call();
                state
                    .tool_calls
                    .insert(tool_call_id.clone(), (call, started));
            }
            AgentEvent::ToolExecutionEnd {
                tool_call_id,
                result,
                is_error,
                ..
            } => {
                if let Some((call, started)) = state.tool_calls.remove(tool_call_id) {
                    self.core
                        .record_tool_outcome(&call, *is_error, &result_text(result), started);
                }
            }
            _ => {}
        }
    }
}

impl AgentListener for HarnessListener {
    fn on_event<'a>(
        &'a self,
        event: &'a AgentEvent,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, ()> {
        self.observe(event);
        Box::pin(ready(()))
    }
}

/// The agent's previous hooks with the pillars around them.
struct HarnessHooks {
    core: Arc<HarnessCore>,
    previous: Arc<dyn AgentHooks>,
    agent: WeakAgent,
}

impl AgentHooks for HarnessHooks {
    fn convert_to_llm(&self, messages: &[AgentMessage]) -> Vec<Message> {
        self.previous.convert_to_llm(messages)
    }

    fn transform_context<'a>(
        &'a self,
        messages: &'a [AgentMessage],
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<Vec<AgentMessage>>> {
        Box::pin(async move {
            let transformed = self
                .previous
                .transform_context(messages, signal)
                .await
                .unwrap_or_else(|| messages.to_vec());
            Some(self.core.transform_context(transformed))
        })
    }

    fn get_api_key<'a>(&'a self, provider: &'a str) -> BoxFuture<'a, Option<String>> {
        self.previous.get_api_key(provider)
    }

    fn finish_turn<'a>(
        &'a self,
        turn: AgentTurnContext<'a>,
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<TurnDecision>> {
        Box::pin(async move {
            let decision = self.previous.finish_turn(turn, signal).await;
            if decision == Some(TurnDecision::End) {
                return decision;
            }
            let message = turn.message;
            let is_final = message.stop_reason == StopReason::Stop
                && !message
                    .content
                    .iter()
                    .any(|block| matches!(block, OutputBlock::ToolCall(_)));
            if !is_final || signal.is_aborted() {
                return decision;
            }
            // Steering is polled right after `finish_turn`, so the request is the next turn.
            if let Some((_, Some(request))) = self.core.assess_final_message(message) {
                if let Some(agent) = self.agent.upgrade() {
                    agent.steer(request);
                }
            }
            decision
        })
    }

    fn prepare_request<'a>(
        &'a self,
        request: PrepareRequestContext<'a>,
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<RequestUpdate>> {
        self.previous.prepare_request(request, signal)
    }

    fn prepare_next_turn<'a>(
        &'a self,
        turn: AgentTurnContext<'a>,
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<TurnUpdate>> {
        self.previous.prepare_next_turn(turn, signal)
    }

    fn get_steering_messages(&self) -> BoxFuture<'_, Vec<AgentMessage>> {
        self.previous.get_steering_messages()
    }

    fn get_follow_up_messages(&self) -> BoxFuture<'_, Vec<AgentMessage>> {
        self.previous.get_follow_up_messages()
    }

    fn before_tool_call<'a>(
        &'a self,
        call: BeforeToolCallContext<'a>,
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Result<Option<BeforeToolCallResult>, String>> {
        Box::pin(async move {
            if let Some(blocked) = self.core.before_tool_call(call.tool_call, signal).await {
                if blocked.block == Some(true) {
                    return Ok(Some(blocked));
                }
            }
            self.previous.before_tool_call(call, signal).await
        })
    }

    fn after_tool_call<'a>(
        &'a self,
        call: AfterToolCallContext<'a>,
        signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Result<Option<AfterToolCallResult>, String>> {
        self.previous.after_tool_call(call, signal)
    }
}
