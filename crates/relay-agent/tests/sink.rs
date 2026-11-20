//! How events reach an asynchronous sink. The loop awaits each event before going on, so a
//! listener that steers on `turn_end` is heard in the same run, as with the TypeScript loop's
//! awaited listeners; and a tool's updates reach the sink while the tool still runs.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::{ready, BoxFuture};
use futures_util::stream::{self, BoxStream, StreamExt};
use relay_agent::{
    run_agent_loop, AgentContext, AgentEvent, AgentHooks, AgentLoopConfig, AgentMessage, AgentTool,
    AgentToolResult, EventSink, LoopRuntime, StreamEvent, StreamFn, StreamRequest, ToolUpdate,
};
use relay_ai::abort::AbortSignal;
use relay_ai::event::AssistantEvent;
use relay_ai::{AssistantMessage, Message, Model, StopReason, Tool};
use serde_json::{json, Value};
use tokio::sync::Notify;

fn model() -> Model {
    serde_json::from_value(json!({
        "id": "mock", "name": "mock", "api": "openai-responses", "provider": "openai",
        "baseUrl": "https://example.invalid", "reasoning": false, "input": ["text"],
        "contextWindow": 8192, "maxTokens": 2048,
    }))
    .unwrap()
}

fn user(text: &str) -> AgentMessage {
    serde_json::from_value(json!({"role": "user", "content": text, "timestamp": 0})).unwrap()
}

fn answer(content: Value, stop_reason: StopReason) -> AssistantMessage {
    serde_json::from_value(json!({
        "content": content, "api": "openai-responses", "provider": "openai", "model": "mock",
        "usage": {
            "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
        },
        "stopReason": stop_reason, "timestamp": 0,
    }))
    .unwrap()
}

/// Answers each request with the next message, as a single `done` event.
struct Answers {
    answers: Mutex<Vec<AssistantMessage>>,
    requests: Mutex<Vec<Vec<Message>>>,
}

impl Answers {
    fn new(mut answers: Vec<AssistantMessage>) -> Self {
        answers.reverse();
        Answers {
            answers: Mutex::new(answers),
            requests: Mutex::default(),
        }
    }
}

impl StreamFn for Answers {
    fn stream<'a>(
        &'a self,
        _model: &'a Model,
        messages: &'a [Message],
        _request: &'a StreamRequest,
    ) -> BoxStream<'a, StreamEvent> {
        self.requests.lock().unwrap().push(messages.to_vec());
        let message = self.answers.lock().unwrap().pop().expect("an answer");
        let event = AssistantEvent::Done {
            reason: message.stop_reason,
            message: Message::Assistant(Box::new(message.clone())),
        };
        stream::iter([StreamEvent {
            event,
            partial: message,
        }])
        .boxed()
    }
}

/// Steering comes from a queue anyone can push to.
#[derive(Default)]
struct Queue {
    steering: Arc<Mutex<Vec<AgentMessage>>>,
}

impl AgentHooks for Queue {
    fn get_steering_messages(&self) -> BoxFuture<'_, Vec<AgentMessage>> {
        Box::pin(ready(std::mem::take(&mut *self.steering.lock().unwrap())))
    }
}

/// Steers once the first turn ends, after waiting as an extension host round trip would.
struct SteeringListener {
    steering: Arc<Mutex<Vec<AgentMessage>>>,
    steered: Mutex<bool>,
}

impl EventSink for SteeringListener {
    fn emit(&self, event: AgentEvent) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if !matches!(event, AgentEvent::TurnEnd { .. }) {
                return;
            }
            if std::mem::replace(&mut *self.steered.lock().unwrap(), true) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
            self.steering.lock().unwrap().push(user("Also this."));
        })
    }
}

#[tokio::test]
async fn a_listener_that_steers_on_turn_end_is_heard_in_the_same_run() {
    let hooks = Queue::default();
    let listener = SteeringListener {
        steering: Arc::clone(&hooks.steering),
        steered: Mutex::new(false),
    };
    let answers = Answers::new(vec![
        answer(
            json!([{"type": "text", "text": "First."}]),
            StopReason::Stop,
        ),
        answer(
            json!([{"type": "text", "text": "Second."}]),
            StopReason::Stop,
        ),
    ]);
    let signal = AbortSignal::never();
    let runtime = LoopRuntime {
        hooks: &hooks,
        stream_fn: &answers,
        signal: &signal,
        sink: &listener,
    };
    let config = AgentLoopConfig {
        clock: || 0,
        ..AgentLoopConfig::new(model())
    };
    let messages = run_agent_loop(vec![user("Hi")], AgentContext::default(), config, runtime).await;
    let requests = answers.requests.lock().unwrap();
    assert_eq!(requests.len(), 2, "the steered message asks again");
    assert_eq!(
        serde_json::to_value(requests[1].last()).unwrap(),
        json!({"role": "user", "content": "Also this.", "timestamp": 0})
    );
    assert_eq!(messages.len(), 4);
}

/// Sends an update, then waits until the sink has seen it.
struct Progress {
    declaration: Tool,
    seen: Arc<Notify>,
}

impl AgentTool for Progress {
    fn declaration(&self) -> &Tool {
        &self.declaration
    }

    fn execute<'a>(
        &'a self,
        _tool_call_id: &'a str,
        _params: Value,
        _signal: &'a AbortSignal,
        on_update: ToolUpdate<'a>,
    ) -> BoxFuture<'a, Result<AgentToolResult, String>> {
        Box::pin(async move {
            let seen = self.seen.notified();
            on_update(serde_json::from_value(json!({"content": [], "details": {}})).unwrap());
            tokio::time::timeout(Duration::from_secs(5), seen)
                .await
                .map_err(|_| "the update did not reach the sink while running".to_string())?;
            Ok(serde_json::from_value(json!({"content": [], "details": {}})).unwrap())
        })
    }
}

#[tokio::test]
async fn tool_updates_reach_the_sink_while_the_tool_runs() {
    let seen = Arc::new(Notify::new());
    let tool = Progress {
        declaration: Tool {
            name: "progress".into(),
            description: "progress tool".into(),
            parameters: json!({"type": "object", "properties": {}}),
            constrained_sampling: None,
        },
        seen: Arc::clone(&seen),
    };
    let results = Mutex::new(Vec::new());
    let sink = |event: AgentEvent| match event {
        AgentEvent::ToolExecutionUpdate { .. } => seen.notify_one(),
        AgentEvent::ToolExecutionEnd { is_error, .. } => results.lock().unwrap().push(is_error),
        _ => {}
    };
    let call = json!([{"type": "toolCall", "id": "call_1", "name": "progress", "arguments": {}}]);
    let answers = Answers::new(vec![
        answer(call, StopReason::ToolUse),
        answer(json!([{"type": "text", "text": "Done."}]), StopReason::Stop),
    ]);
    let signal = AbortSignal::never();
    let hooks = Queue::default();
    let runtime = LoopRuntime {
        hooks: &hooks,
        stream_fn: &answers,
        signal: &signal,
        sink: &sink,
    };
    let context = AgentContext {
        messages: Vec::new(),
        tools: vec![Arc::new(tool) as Arc<dyn AgentTool>],
    };
    let config = AgentLoopConfig {
        clock: || 0,
        ..AgentLoopConfig::new(model())
    };
    run_agent_loop(vec![user("Go")], context, config, runtime).await;
    assert_eq!(*results.lock().unwrap(), [false]);
}
