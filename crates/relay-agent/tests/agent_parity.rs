//! Replays `crates/fixtures/agent/`, what `packages/agent/test/parity/agent-record.ts` recorded
//! from the TypeScript `Agent`. Each case builds the agent from its initial state and runs its
//! steps; its tools and listeners run their operations mid-run, as the recorder's do. The agent
//! must show its listeners the same events and states, refuse the same operations with the same
//! words, send the same requests and end each step in the same state.

mod scripted;

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::future::BoxFuture;
use futures_util::stream::{self, BoxStream, StreamExt};
use relay_agent::{
    Agent, AgentEvent, AgentInitialState, AgentListener, AgentMessage, AgentOptions, AgentTool,
    AgentToolResult, QueueMode, StreamEvent, StreamFn, StreamRequest, ToolUpdate,
};
use relay_ai::abort::AbortSignal;
use relay_ai::{InputBlock, Message, Model, StopReason, Tool};
use scripted::{first_difference, model, response_events, Response};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Op {
    Prompt {
        text: String,
        #[serde(default)]
        images: Vec<InputBlock>,
    },
    PromptMessages {
        messages: Vec<AgentMessage>,
    },
    Continue,
    Steer {
        message: AgentMessage,
    },
    FollowUp {
        message: AgentMessage,
    },
    Abort,
    Reset,
    ClearQueues,
    Peek,
    SetThinkingLevel {
        level: String,
    },
    SetTools {
        tools: Vec<String>,
    },
}

impl Op {
    fn name(&self) -> &'static str {
        match self {
            Op::Prompt { .. } => "prompt",
            Op::PromptMessages { .. } => "promptMessages",
            Op::Continue => "continue",
            Op::Steer { .. } => "steer",
            Op::FollowUp { .. } => "followUp",
            Op::Abort => "abort",
            Op::Reset => "reset",
            Op::ClearQueues => "clearQueues",
            Op::Peek => "peek",
            Op::SetThinkingLevel { .. } => "setThinkingLevel",
            Op::SetTools { .. } => "setTools",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolSpec {
    name: String,
    parameters: Value,
    #[serde(default)]
    ops: Vec<Op>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitialSpec {
    system_prompt: Option<String>,
    thinking_level: Option<String>,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    messages: Vec<AgentMessage>,
}

#[derive(Clone, Deserialize)]
struct Trigger {
    on: String,
    nth: usize,
    ops: Vec<Op>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    tools: Vec<ToolSpec>,
    initial_state: Option<InitialSpec>,
    steering_mode: Option<QueueMode>,
    follow_up_mode: Option<QueueMode>,
    responses: Vec<Response>,
    steps: Vec<Op>,
    #[serde(default)]
    listen: Vec<Trigger>,
    events: Vec<Value>,
    ops: Vec<Value>,
    calls: Vec<Value>,
    states: Vec<Value>,
}

/// What a case's tools, listener and stream function share. The agent and the tools refer to
/// each other through it, as the recorder's closures do.
#[derive(Default)]
struct World {
    agent: OnceLock<Agent>,
    tools: OnceLock<HashMap<String, Arc<dyn AgentTool>>>,
    responses: Vec<Response>,
    next_response: Mutex<usize>,
    triggers: Vec<Trigger>,
    seen: Mutex<HashMap<String, usize>>,
    events: Mutex<Vec<Value>>,
    ops: Mutex<Vec<Value>>,
    calls: Mutex<Vec<Value>>,
}

impl World {
    fn agent(&self) -> Agent {
        self.agent.get().expect("the agent is built").clone()
    }

    fn tools_named(&self, names: &[String]) -> Vec<Arc<dyn AgentTool>> {
        let tools = self.tools.get().expect("the tools are built");
        names.iter().map(|name| Arc::clone(&tools[name])).collect()
    }

    fn queued(&self) -> Value {
        let agent = self.agent();
        json!({"queued": agent.peek_queued_messages(), "has": agent.has_queued_messages()})
    }

    fn snapshot(&self) -> Value {
        let state = self.agent().state();
        json!({
            "streaming": state.is_streaming,
            "streamingRole": state.streaming_message.as_ref().map(AgentMessage::role),
            "pending": state.pending_tool_calls,
            "messages": state.messages.len(),
            "error": state.error_message,
        })
    }

    fn full_state(&self, after: &str) -> Value {
        let state = self.agent().state();
        let mut value = json!({
            "after": after,
            "systemPrompt": state.system_prompt,
            "model": state.model.id,
            "thinkingLevel": state.thinking_level,
            "messages": state.messages,
            "isStreaming": state.is_streaming,
            "streamingMessage": state.streaming_message.as_ref().map(AgentMessage::role),
            "pending": state.pending_tool_calls,
            "errorMessage": state.error_message,
        });
        let queued = self.queued();
        value["queued"] = queued["queued"].clone();
        value["has"] = queued["has"].clone();
        value
    }

    async fn perform(&self, op: &Op) -> Result<Option<Value>, String> {
        let agent = self.agent();
        match op {
            Op::Prompt { text, images } => {
                let images = images
                    .iter()
                    .filter_map(|block| match block {
                        InputBlock::Image(image) => Some(image.clone()),
                        InputBlock::Text(_) => None,
                    })
                    .collect();
                agent.prompt_text(text, images).await.map(|()| None)
            }
            Op::PromptMessages { messages } => agent.prompt(messages.clone()).await.map(|()| None),
            Op::Continue => agent.continue_run().await.map(|()| None),
            Op::Steer { message } => {
                agent.steer(message.clone());
                Ok(None)
            }
            Op::FollowUp { message } => {
                agent.follow_up(message.clone());
                Ok(None)
            }
            Op::Abort => {
                agent.abort();
                Ok(None)
            }
            Op::Reset => agent.reset().map(|()| None),
            Op::ClearQueues => {
                agent.clear_all_queues();
                Ok(None)
            }
            Op::Peek => Ok(Some(self.queued())),
            Op::SetThinkingLevel { level } => {
                agent.set_thinking_level(level.clone());
                Ok(None)
            }
            Op::SetTools { tools } => {
                agent.set_tools(self.tools_named(tools));
                Ok(None)
            }
        }
    }

    /// Runs operations in order, recording each outcome.
    fn run_ops<'a>(&'a self, ops: &'a [Op], at: String) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            for op in ops {
                let mut entry = json!({"at": at, "op": op.name()});
                match self.perform(op).await {
                    Ok(value) => {
                        entry["result"] = "ok".into();
                        if let Some(value) = value {
                            entry["value"] = value;
                        }
                    }
                    Err(error) => entry["result"] = json!({ "error": error }),
                }
                self.ops.lock().unwrap().push(entry);
            }
        })
    }
}

struct ScriptedTool {
    declaration: Tool,
    ops: Vec<Op>,
    world: Arc<World>,
}

impl AgentTool for ScriptedTool {
    fn declaration(&self) -> &Tool {
        &self.declaration
    }

    fn execute<'a>(
        &'a self,
        _tool_call_id: &'a str,
        _params: Value,
        _signal: &'a AbortSignal,
        _on_update: ToolUpdate<'a>,
    ) -> BoxFuture<'a, Result<AgentToolResult, String>> {
        Box::pin(async move {
            let name = &self.declaration.name;
            self.world.run_ops(&self.ops, format!("tool:{name}")).await;
            Ok(serde_json::from_value(json!({
                "content": [{"type": "text", "text": format!("{name} ok")}],
                "details": {},
            }))
            .unwrap())
        })
    }
}

/// Records each event with the agent's state, then runs the operations due at it.
struct Listener {
    world: Arc<World>,
}

impl AgentListener for Listener {
    fn on_event<'a>(
        &'a self,
        event: &'a AgentEvent,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let value = serde_json::to_value(event).unwrap();
            let kind = value["type"].as_str().unwrap().to_string();
            let nth = {
                let mut seen = self.world.seen.lock().unwrap();
                let count = seen.entry(kind.clone()).or_default();
                *count += 1;
                *count
            };
            let mut entry = json!({"type": kind});
            if let Some(message) = value.get("message") {
                entry["role"] = message.get("role").cloned().unwrap_or(Value::Null);
            }
            if let Some(id) = value.get("toolCallId") {
                entry["toolCallId"] = id.clone();
            }
            entry["state"] = self.world.snapshot();
            self.world.events.lock().unwrap().push(entry);
            for trigger in &self.world.triggers {
                if trigger.on == kind && trigger.nth == nth {
                    let at = format!("listener:{kind}#{nth}");
                    self.world.run_ops(&trigger.ops, at).await;
                }
            }
        })
    }
}

struct ScriptedStream {
    world: Arc<World>,
}

impl StreamFn for ScriptedStream {
    fn stream<'a>(
        &'a self,
        model: &'a Model,
        messages: &'a [Message],
        request: &'a StreamRequest,
    ) -> BoxStream<'a, StreamEvent> {
        self.world.calls.lock().unwrap().push(json!({
            "model": model.id,
            "messages": messages,
            "reasoning": request.options.reasoning,
        }));
        let response = if request.signal.is_aborted() {
            Response {
                content: Vec::new(),
                stop_reason: Some(StopReason::Aborted),
                error_message: Some("Request was aborted".into()),
            }
        } else {
            let mut next = self.world.next_response.lock().unwrap();
            *next += 1;
            self.world.responses[*next - 1].clone()
        };
        stream::iter(response_events(model, &response)).boxed()
    }
}

async fn replay(case: Case) -> (Case, [Vec<Value>; 4]) {
    let world = Arc::new(World {
        responses: case.responses.clone(),
        triggers: case.listen.clone(),
        ..World::default()
    });
    let tools: HashMap<String, Arc<dyn AgentTool>> = case
        .tools
        .iter()
        .map(|spec| {
            let tool: Arc<dyn AgentTool> = Arc::new(ScriptedTool {
                declaration: Tool {
                    name: spec.name.clone(),
                    description: format!("{} tool", spec.name),
                    parameters: spec.parameters.clone(),
                    constrained_sampling: None,
                },
                ops: spec.ops.clone(),
                world: Arc::clone(&world),
            });
            (spec.name.clone(), tool)
        })
        .collect();
    assert!(world.tools.set(tools).is_ok());
    let initial = case.initial_state.as_ref();
    let empty = InitialSpec::default();
    let initial = initial.unwrap_or(&empty);
    let options = AgentOptions {
        initial_state: AgentInitialState {
            system_prompt: initial.system_prompt.clone(),
            model: Some(model()),
            thinking_level: initial.thinking_level.clone(),
            tools: world.tools_named(&initial.tools),
            messages: initial.messages.clone(),
        },
        steering_mode: case.steering_mode.unwrap_or_default(),
        follow_up_mode: case.follow_up_mode.unwrap_or_default(),
        clock: || 0,
        ..AgentOptions::new(Arc::new(ScriptedStream {
            world: Arc::clone(&world),
        }))
    };
    let agent = Agent::new(options);
    assert!(world.agent.set(agent.clone()).is_ok());
    agent.subscribe(Arc::new(Listener {
        world: Arc::clone(&world),
    }));

    let mut states = Vec::new();
    for step in &case.steps {
        world
            .run_ops(std::slice::from_ref(step), "step".into())
            .await;
        states.push(world.full_state(step.name()));
    }
    let take = |list: &Mutex<Vec<Value>>| std::mem::take(&mut *list.lock().unwrap());
    let recorded = [
        take(&world.events),
        take(&world.ops),
        take(&world.calls),
        states,
    ];
    (case, recorded)
}

#[tokio::test]
async fn the_agent_behaves_as_the_typescript_agent_does() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/agent");
    let mut paths: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "no cases in {}", dir.display());
    let mut failures = Vec::new();
    for path in &paths {
        let case: Case = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        let (case, actual) = replay(case).await;
        let expected = [&case.events, &case.ops, &case.calls, &case.states];
        let parts = ["events", "ops", "calls", "states"];
        for ((part, expected), actual) in parts.iter().zip(expected).zip(&actual) {
            if let Some(difference) = first_difference(expected, actual) {
                failures.push(format!("{} {part}: {difference}", case.name));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_prompt_can_run_on_another_task() {
    fn send<T: Send>(_: &T) {}
    let agent = Agent::new(AgentOptions::new(Arc::new(ScriptedStream {
        world: Arc::default(),
    })));
    send(&agent.prompt(Vec::new()));
    send(&agent.continue_run());
    send(&agent.wait_for_idle());
}
