//! Replays `crates/fixtures/harness/`, what `packages/agent/test/parity/harness-record.ts`
//! recorded from the TypeScript `HarnessCore` installed on an `Agent`: the agent-level scenarios of
//! `harness.test.ts`. Each case builds the agent with the same scripted tools and responses,
//! installs the Rust harness with the same options and sends the same prompts. The provider must
//! receive the same requests, and the harness must report the same events, ask the authorizer
//! the same things and leave the same transcript and constraints.

mod scripted;

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::future::{ready, BoxFuture};
use futures_util::stream::{self, BoxStream, StreamExt};
use relay_agent::harness::{
    AuthorizationRequest, Authorizer, DelegatedOutcome, HarnessCore, HarnessCoreOptions,
};
use relay_agent::{
    Agent, AgentHooks, AgentInitialState, AgentMessage, AgentOptions, AgentTool, AgentToolResult,
    BeforeToolCallContext, BeforeToolCallResult, StreamEvent, StreamFn, StreamRequest, ToolUpdate,
};
use relay_ai::abort::AbortSignal;
use relay_ai::{Message, Model, OutputBlock, StopReason, TextContent, Tool, ToolCall};
use relay_harness_core::context::ContextPolicyOptions;
use relay_harness_core::json::constraint_to_json;
use scripted::{first_difference, model, response_events, Response};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Delegated {
    tool_call: ToolCall,
    is_error: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolSpec {
    name: String,
    output: Option<String>,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    delegate: Vec<Delegated>,
    steer: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Prompt {
    Text { text: String },
    Message { message: Box<AgentMessage> },
    Messages { messages: Vec<AgentMessage> },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextSpec {
    keep_recent: usize,
    batch_size: usize,
    min_elide_chars: usize,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptionsSpec {
    /// Only `false` is recorded: the pillar is off.
    evidence: Option<bool>,
    /// `false` turns the pillar off; an object sets its sizes.
    context: Option<Value>,
    /// What the authorizer answers; present means there is one.
    #[serde(default, deserialize_with = "present")]
    authorize: Option<Option<bool>>,
    /// The agent's own `before_tool_call` blocks this tool.
    previous_blocks: Option<String>,
}

fn present<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<bool>>, D::Error> {
    Option::<bool>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
struct Case {
    name: String,
    tools: Vec<ToolSpec>,
    responses: Vec<Vec<OutputBlock>>,
    prompts: Vec<Prompt>,
    #[serde(default)]
    options: OptionsSpec,
    parameters: Value,
    requests: Vec<Value>,
    events: Vec<Value>,
    asked: Vec<Value>,
    messages: Vec<Value>,
    constraints: Vec<Value>,
}

struct HarnessTool {
    declaration: Tool,
    output: String,
    is_error: bool,
    delegate: Vec<(ToolCall, bool)>,
    steer: Option<String>,
    core: Arc<OnceLock<Arc<HarnessCore>>>,
    agent: Arc<OnceLock<Agent>>,
}

impl AgentTool for HarnessTool {
    fn declaration(&self) -> &Tool {
        &self.declaration
    }

    fn typebox(&self) -> bool {
        true
    }

    fn execute<'a>(
        &'a self,
        _tool_call_id: &'a str,
        _params: Value,
        _signal: &'a AbortSignal,
        _on_update: ToolUpdate<'a>,
    ) -> BoxFuture<'a, Result<AgentToolResult, String>> {
        if let Some(text) = &self.steer {
            let message =
                serde_json::from_value(json!({"role": "user", "content": text, "timestamp": 0}));
            self.agent
                .get()
                .expect("the agent is built")
                .steer(message.unwrap());
        }
        if !self.delegate.is_empty() {
            let core = self.core.get().expect("the harness is built");
            let outcomes: Vec<DelegatedOutcome> = self
                .delegate
                .iter()
                .map(|(call, is_error)| DelegatedOutcome {
                    effect: core.classify(call),
                    is_error: *is_error,
                    output: Some("ok".into()),
                })
                .collect();
            core.record_delegated_effects(&outcomes);
        }
        let result = serde_json::from_value(json!({
            "content": [{"type": "text", "text": self.output}],
            "details": {},
            "isError": self.is_error,
        }))
        .unwrap();
        Box::pin(ready(Ok(result)))
    }
}

struct Scripted {
    responses: Vec<Vec<OutputBlock>>,
    next: Mutex<usize>,
    requests: Mutex<Vec<Value>>,
}

impl StreamFn for Scripted {
    fn stream<'a>(
        &'a self,
        model: &'a Model,
        messages: &'a [Message],
        _request: &'a StreamRequest,
    ) -> BoxStream<'a, StreamEvent> {
        self.requests
            .lock()
            .unwrap()
            .push(serde_json::to_value(messages).unwrap());
        let mut next = self.next.lock().unwrap();
        let content = self.responses.get(*next).cloned().unwrap_or_else(|| {
            vec![OutputBlock::Text(TextContent {
                text: "(no more responses)".into(),
                text_signature: None,
                volatile: None,
            })]
        });
        *next += 1;
        let calls_tool = content
            .iter()
            .any(|block| matches!(block, OutputBlock::ToolCall(_)));
        let response = Response {
            content,
            stop_reason: Some(if calls_tool {
                StopReason::ToolUse
            } else {
                StopReason::Stop
            }),
            error_message: None,
        };
        stream::iter(response_events(model, &response)).boxed()
    }
}

/// The agent's own hooks, under the harness.
struct PreviousHooks {
    blocked: Option<String>,
}

impl AgentHooks for PreviousHooks {
    fn before_tool_call<'a>(
        &'a self,
        call: BeforeToolCallContext<'a>,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Result<Option<BeforeToolCallResult>, String>> {
        let blocked = self.blocked.as_deref() == Some(call.tool_call.name.as_str());
        Box::pin(ready(Ok(blocked.then(|| BeforeToolCallResult {
            block: Some(true),
            reason: Some("Blocked by the agent's own hook.".into()),
            terminate: None,
        }))))
    }
}

struct Answers {
    answer: Option<bool>,
    asked: Mutex<Vec<Value>>,
}

impl Authorizer for Answers {
    fn authorize<'a>(
        &'a self,
        request: &'a AuthorizationRequest,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<bool>> {
        self.asked.lock().unwrap().push(request.to_json());
        Box::pin(ready(self.answer))
    }
}

/// Times become 0, as the recorder writes them.
fn zero_times(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (key, field) in fields.iter_mut() {
                if key == "timestamp" && field.is_number() {
                    *field = json!(0);
                } else {
                    zero_times(field);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(zero_times),
        _ => {}
    }
}

async fn replay(case: &Case) -> [Vec<Value>; 5] {
    let core_cell: Arc<OnceLock<Arc<HarnessCore>>> = Arc::default();
    let agent_cell: Arc<OnceLock<Agent>> = Arc::default();
    let tools: Vec<Arc<dyn AgentTool>> = case
        .tools
        .iter()
        .map(|spec| {
            Arc::new(HarnessTool {
                declaration: Tool {
                    name: spec.name.clone(),
                    description: format!("{} tool", spec.name),
                    parameters: case.parameters.clone(),
                    constrained_sampling: None,
                },
                output: spec
                    .output
                    .clone()
                    .unwrap_or_else(|| format!("{} ok", spec.name)),
                is_error: spec.is_error,
                delegate: spec
                    .delegate
                    .iter()
                    .map(|delegated| (delegated.tool_call.clone(), delegated.is_error))
                    .collect(),
                steer: spec.steer.clone(),
                core: Arc::clone(&core_cell),
                agent: Arc::clone(&agent_cell),
            }) as Arc<dyn AgentTool>
        })
        .collect();
    let stream = Arc::new(Scripted {
        responses: case.responses.clone(),
        next: Mutex::new(0),
        requests: Mutex::default(),
    });
    let agent = Agent::new(AgentOptions {
        initial_state: AgentInitialState {
            system_prompt: Some("test".into()),
            model: Some(model()),
            tools,
            ..AgentInitialState::default()
        },
        hooks: Arc::new(PreviousHooks {
            blocked: case.options.previous_blocks.clone(),
        }),
        clock: || 0,
        ..AgentOptions::new(stream.clone())
    });

    assert!(agent_cell.set(agent.clone()).is_ok());
    let events = Arc::new(Mutex::new(Vec::new()));
    let authorizer = case.options.authorize.map(|answer| {
        Arc::new(Answers {
            answer,
            asked: Mutex::default(),
        })
    });
    let recorded = Arc::clone(&events);
    let context = match &case.options.context {
        Some(Value::Bool(false)) => None,
        Some(sizes) => {
            let sizes: ContextSpec = serde_json::from_value(sizes.clone()).unwrap();
            Some(ContextPolicyOptions {
                keep_recent: sizes.keep_recent,
                batch_size: sizes.batch_size,
                min_elide_chars: sizes.min_elide_chars,
                ..ContextPolicyOptions::default()
            })
        }
        None => Some(ContextPolicyOptions::default()),
    };
    let core = Arc::new(HarnessCore::new(HarnessCoreOptions {
        evidence_max_gates: (case.options.evidence != Some(false)).then_some(1),
        context,
        authorize: authorizer
            .clone()
            .map(|authorizer| authorizer as Arc<dyn Authorizer>),
        on_event: Some(Arc::new(move |event| {
            recorded.lock().unwrap().push(event.to_json());
        })),
        clock: || 0,
        ..HarnessCoreOptions::default()
    }));
    assert!(core_cell.set(Arc::clone(&core)).is_ok());
    let installation = core.install(&agent);

    for prompt in &case.prompts {
        match prompt {
            Prompt::Text { text } => agent.prompt_text(text, Vec::new()).await.unwrap(),
            Prompt::Message { message } => agent.prompt(vec![(**message).clone()]).await.unwrap(),
            Prompt::Messages { messages } => agent.prompt(messages.clone()).await.unwrap(),
        }
    }
    let constraints: Vec<Value> = core.constraints().iter().map(constraint_to_json).collect();
    installation.uninstall();

    let mut lists = [
        std::mem::take(&mut *stream.requests.lock().unwrap()),
        std::mem::take(&mut *events.lock().unwrap()),
        authorizer
            .map(|authorizer| std::mem::take(&mut *authorizer.asked.lock().unwrap()))
            .unwrap_or_default(),
        agent
            .state()
            .messages
            .iter()
            .map(|message| serde_json::to_value(message).unwrap())
            .collect(),
        constraints,
    ];
    for list in &mut lists {
        list.iter_mut().for_each(zero_times);
    }
    lists
}

#[tokio::test]
async fn the_harness_acts_as_the_typescript_harness_does() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/harness");
    let mut paths: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "no cases in {}", dir.display());
    let mut failures = Vec::new();
    for path in &paths {
        let case: Case = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        let actual = replay(&case).await;
        let expected = [
            &case.requests,
            &case.events,
            &case.asked,
            &case.messages,
            &case.constraints,
        ];
        let parts = ["requests", "events", "asked", "messages", "constraints"];
        for ((part, expected), actual) in parts.iter().zip(expected).zip(&actual) {
            if let Some(difference) = first_difference(expected, actual) {
                failures.push(format!("{} {part}: {difference}", case.name));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn uninstalling_restores_the_hooks() {
    let agent = Agent::new(AgentOptions::new(Arc::new(Scripted {
        responses: Vec::new(),
        next: Mutex::new(0),
        requests: Mutex::default(),
    })));
    let before = agent.hooks();
    let core = Arc::new(HarnessCore::new(HarnessCoreOptions::default()));
    let installation = core.install(&agent);
    assert!(!Arc::ptr_eq(&before, &agent.hooks()));
    installation.uninstall();
    assert!(Arc::ptr_eq(&before, &agent.hooks()));
}
