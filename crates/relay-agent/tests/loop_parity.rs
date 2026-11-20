//! Replays `crates/fixtures/loop/`, what `packages/agent/test/parity/loop-record.ts` recorded
//! from the TypeScript loop. Each case's tools, hooks and stream function behave as the
//! recorder's: tools record what they ran with and follow their script, hooks record each call
//! and answer from the case, and the stream function records each request and answers with the
//! case's next response as provider events. The run must emit the same events, send the same
//! requests, call the same hooks, run the same tools and return the same messages.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

mod scripted;

use futures_util::future::{ready, BoxFuture};
use futures_util::stream::{self, BoxStream, StreamExt};
use relay_agent::{
    run_agent_loop, run_agent_loop_continue, AfterToolCallContext, AfterToolCallResult,
    AgentContext, AgentEvent, AgentHooks, AgentLoopConfig, AgentMessage, AgentTool,
    AgentToolResult, AgentTurnContext, BeforeToolCallContext, BeforeToolCallResult, LoopRuntime,
    PrepareRequestContext, RequestUpdate, StreamEvent, StreamFn, StreamRequest, ToolExecutionMode,
    ToolUpdate, TurnDecision, TurnUpdate,
};
use relay_ai::abort::{AbortController, AbortSignal};
use relay_ai::simple::SimpleOptions;
use relay_ai::{Message, Model, OutputBlock, StopReason, TextContent, Tool};
use scripted::{first_difference, model, response_events, Response};
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    tools: Vec<ToolSpec>,
    responses: Vec<Response>,
    context: Vec<AgentMessage>,
    prompts: Option<Vec<AgentMessage>>,
    tool_execution: Option<ToolExecutionMode>,
    reasoning: Option<String>,
    #[serde(default)]
    block: HashMap<String, BeforeToolCallResult>,
    #[serde(default)]
    after: HashMap<String, AfterToolCallResult>,
    finish_turn: Option<Vec<Option<String>>>,
    #[serde(default)]
    steering: Vec<Vec<AgentMessage>>,
    #[serde(default)]
    follow_ups: Vec<Vec<AgentMessage>>,
    prepare_next_turn: Option<Vec<Option<NextTurnSpec>>>,
    prepare_request: Option<Vec<Option<RequestSpec>>>,
    transform_keep_last: Option<usize>,
    api_key: Option<String>,
    api_keys: Option<Vec<Option<String>>>,
    #[serde(default)]
    throw_in: HashMap<String, String>,
    events: Vec<Value>,
    calls: Vec<Value>,
    hooks: Vec<Value>,
    executions: Vec<Value>,
    messages: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolSpec {
    name: String,
    parameters: Value,
    #[serde(default)]
    typebox: bool,
    execution_mode: Option<ToolExecutionMode>,
    prepare: Option<Map<String, Value>>,
    #[serde(default)]
    run: Script,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NextTurnSpec {
    messages: Option<Vec<AgentMessage>>,
    thinking_level: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestSpec {
    thinking_level: Option<String>,
    model: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Script {
    delay_ms: Option<u64>,
    #[serde(default)]
    updates: Vec<String>,
    result: Option<AgentToolResult>,
    throws: Option<String>,
    #[serde(default)]
    abort: bool,
}

/// What a run did besides emitting events.
#[derive(Default)]
struct Recorder {
    controller: AbortController,
    hooks: Mutex<Vec<Value>>,
    executions: Mutex<Vec<Value>>,
    calls: Mutex<Vec<Value>>,
}

impl Recorder {
    fn hook(&self, entry: Value) {
        self.hooks.lock().unwrap().push(entry);
    }
}

fn text_result(text: &str) -> AgentToolResult {
    serde_json::from_value(json!({"content": [{"type": "text", "text": text}], "details": {}}))
        .unwrap()
}

struct ScriptedTool {
    declaration: Tool,
    typebox: bool,
    execution_mode: Option<ToolExecutionMode>,
    prepare: Option<Map<String, Value>>,
    script: Script,
    recorder: Arc<Recorder>,
}

impl AgentTool for ScriptedTool {
    fn declaration(&self) -> &Tool {
        &self.declaration
    }

    fn typebox(&self) -> bool {
        self.typebox
    }

    fn execution_mode(&self) -> Option<ToolExecutionMode> {
        self.execution_mode
    }

    /// `{ ...spec.prepare, ...args }`.
    fn prepare_arguments(&self, arguments: &Map<String, Value>) -> Result<Option<Value>, String> {
        Ok(self.prepare.as_ref().map(|defaults| {
            let mut prepared = defaults.clone();
            prepared.extend(arguments.clone());
            Value::Object(prepared)
        }))
    }

    fn execute<'a>(
        &'a self,
        tool_call_id: &'a str,
        params: Value,
        signal: &'a AbortSignal,
        on_update: ToolUpdate<'a>,
    ) -> BoxFuture<'a, Result<AgentToolResult, String>> {
        Box::pin(async move {
            let name = &self.declaration.name;
            self.recorder.executions.lock().unwrap().push(json!({
                "tool": name,
                "toolCallId": tool_call_id,
                "params": params,
                "aborted": signal.is_aborted(),
            }));
            let script = self.script.clone();
            for update in &script.updates {
                on_update(text_result(update));
            }
            if let Some(delay) = script.delay_ms.filter(|delay| *delay > 0) {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            if script.abort {
                self.recorder.controller.abort();
            }
            if let Some(message) = script.throws {
                return Err(message);
            }
            Ok(script
                .result
                .unwrap_or_else(|| text_result(&format!("{name} ok"))))
        })
    }
}

#[derive(Default)]
struct Polls {
    turn: usize,
    steering: usize,
    follow_up: usize,
    prepare: usize,
    request: usize,
    api_key: usize,
}

struct ScriptedHooks<'a> {
    case: &'a Case,
    recorder: Arc<Recorder>,
    polls: Mutex<Polls>,
}

impl AgentHooks for ScriptedHooks<'_> {
    fn before_tool_call<'a>(
        &'a self,
        call: BeforeToolCallContext<'a>,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Result<Option<BeforeToolCallResult>, String>> {
        self.recorder.hook(json!({
            "hook": "beforeToolCall",
            "toolCallId": call.tool_call.id,
            "args": call.args,
        }));
        let name = &call.tool_call.name;
        if self
            .case
            .throw_in
            .get(name)
            .is_some_and(|hook| hook == "before")
        {
            return Box::pin(ready(Err(format!("before {name} failed"))));
        }
        let block = self.case.block.get(name).map(|block| BeforeToolCallResult {
            block: Some(true),
            ..block.clone()
        });
        Box::pin(ready(Ok(block)))
    }

    fn after_tool_call<'a>(
        &'a self,
        call: AfterToolCallContext<'a>,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Result<Option<AfterToolCallResult>, String>> {
        self.recorder.hook(json!({
            "hook": "afterToolCall",
            "toolCallId": call.tool_call.id,
            "isError": call.is_error,
        }));
        let name = &call.tool_call.name;
        if self
            .case
            .throw_in
            .get(name)
            .is_some_and(|hook| hook == "after")
        {
            return Box::pin(ready(Err(format!("after {name} failed"))));
        }
        Box::pin(ready(Ok(self.case.after.get(name).cloned())))
    }

    fn transform_context<'a>(
        &'a self,
        messages: &'a [AgentMessage],
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<Vec<AgentMessage>>> {
        let Some(keep_last) = self.case.transform_keep_last else {
            return Box::pin(ready(None));
        };
        self.recorder
            .hook(json!({"hook": "transformContext", "messages": messages.len()}));
        let others = messages
            .iter()
            .filter(|message| message.role() != "system")
            .count();
        let mut index = 0;
        let kept = messages
            .iter()
            .filter(|message| {
                if message.role() == "system" {
                    return true;
                }
                index += 1;
                index > others.saturating_sub(keep_last)
            })
            .cloned()
            .collect();
        Box::pin(ready(Some(kept)))
    }

    fn get_api_key<'a>(&'a self, provider: &'a str) -> BoxFuture<'a, Option<String>> {
        let Some(keys) = &self.case.api_keys else {
            return Box::pin(ready(None));
        };
        let mut polls = self.polls.lock().unwrap();
        let key = keys.get(polls.api_key).cloned().flatten();
        self.recorder.hook(json!({
            "hook": "getApiKey",
            "poll": polls.api_key,
            "provider": provider,
        }));
        polls.api_key += 1;
        Box::pin(ready(key))
    }

    fn prepare_request<'a>(
        &'a self,
        request: PrepareRequestContext<'a>,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<RequestUpdate>> {
        let Some(updates) = &self.case.prepare_request else {
            return Box::pin(ready(None));
        };
        let mut polls = self.polls.lock().unwrap();
        self.recorder.hook(json!({
            "hook": "prepareRequest",
            "poll": polls.request,
            "model": request.model.id,
            "thinkingLevel": request.thinking_level,
            "messages": request.context.messages.len(),
        }));
        let update = updates.get(polls.request).cloned().flatten();
        polls.request += 1;
        Box::pin(ready(update.map(|update| RequestUpdate {
            thinking_level: update.thinking_level,
            model: update.model.map(|id| Model {
                name: Some(id.clone()),
                id,
                ..model()
            }),
            ..RequestUpdate::default()
        })))
    }

    fn finish_turn<'a>(
        &'a self,
        turn: AgentTurnContext<'a>,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<TurnDecision>> {
        let mut polls = self.polls.lock().unwrap();
        self.recorder.hook(json!({
            "hook": "finishTurn",
            "turn": polls.turn,
            "stopReason": turn.message.stop_reason,
            "toolResults": turn.tool_results.len(),
        }));
        // `testCase.finishTurn?.[turn++]` counts only when the case has decisions.
        let decision = self.case.finish_turn.as_ref().and_then(|decisions| {
            let decision = decisions.get(polls.turn).cloned().flatten();
            polls.turn += 1;
            decision
        });
        let decision = decision.map(|action| match action.as_str() {
            "continue" => TurnDecision::Continue,
            "end" => TurnDecision::End,
            other => panic!("unknown decision {other}"),
        });
        Box::pin(ready(decision))
    }

    fn prepare_next_turn<'a>(
        &'a self,
        _turn: AgentTurnContext<'a>,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<TurnUpdate>> {
        let Some(prepared) = &self.case.prepare_next_turn else {
            return Box::pin(ready(None));
        };
        let mut polls = self.polls.lock().unwrap();
        self.recorder
            .hook(json!({"hook": "prepareNextTurn", "poll": polls.prepare}));
        let update = prepared.get(polls.prepare).cloned().flatten();
        polls.prepare += 1;
        Box::pin(ready(update.map(|update| TurnUpdate {
            messages: update.messages,
            thinking_level: update.thinking_level,
            ..TurnUpdate::default()
        })))
    }

    fn get_steering_messages(&self) -> BoxFuture<'_, Vec<AgentMessage>> {
        let mut polls = self.polls.lock().unwrap();
        let messages = self
            .case
            .steering
            .get(polls.steering)
            .cloned()
            .unwrap_or_default();
        self.recorder.hook(json!({
            "hook": "getSteeringMessages",
            "poll": polls.steering,
            "count": messages.len(),
        }));
        polls.steering += 1;
        Box::pin(ready(messages))
    }

    fn get_follow_up_messages(&self) -> BoxFuture<'_, Vec<AgentMessage>> {
        let mut polls = self.polls.lock().unwrap();
        let messages = self
            .case
            .follow_ups
            .get(polls.follow_up)
            .cloned()
            .unwrap_or_default();
        self.recorder.hook(json!({
            "hook": "getFollowUpMessages",
            "poll": polls.follow_up,
            "count": messages.len(),
        }));
        polls.follow_up += 1;
        Box::pin(ready(messages))
    }
}

struct ScriptedStream {
    responses: Vec<Response>,
    next: Mutex<usize>,
    recorder: Arc<Recorder>,
}

impl StreamFn for ScriptedStream {
    fn stream<'a>(
        &'a self,
        model: &'a Model,
        messages: &'a [Message],
        request: &'a StreamRequest,
    ) -> BoxStream<'a, StreamEvent> {
        self.recorder.calls.lock().unwrap().push(json!({
            "model": model.id,
            "messages": messages,
            "reasoning": request.options.reasoning,
            "apiKey": request.api_key,
        }));
        let response = if request.signal.is_aborted() {
            Response {
                content: Vec::new(),
                stop_reason: Some(StopReason::Aborted),
                error_message: Some("Request was aborted".into()),
            }
        } else {
            let mut next = self.next.lock().unwrap();
            *next += 1;
            self.responses
                .get(*next - 1)
                .cloned()
                .unwrap_or_else(|| panic!("no response {next}"))
        };
        stream::iter(response_events(model, &response)).boxed()
    }
}

async fn replay(case: &Case) -> [Vec<Value>; 5] {
    let recorder = Arc::new(Recorder::default());
    let tools: Vec<Arc<dyn AgentTool>> = case
        .tools
        .iter()
        .map(|spec| {
            Arc::new(ScriptedTool {
                declaration: Tool {
                    name: spec.name.clone(),
                    description: format!("{} tool", spec.name),
                    parameters: spec.parameters.clone(),
                    constrained_sampling: None,
                },
                typebox: spec.typebox,
                execution_mode: spec.execution_mode,
                prepare: spec.prepare.clone(),
                script: spec.run.clone(),
                recorder: Arc::clone(&recorder),
            }) as Arc<dyn AgentTool>
        })
        .collect();
    let hooks = ScriptedHooks {
        case,
        recorder: Arc::clone(&recorder),
        polls: Mutex::default(),
    };
    let stream = ScriptedStream {
        responses: case.responses.clone(),
        next: Mutex::new(0),
        recorder: Arc::clone(&recorder),
    };
    let events = Mutex::new(Vec::new());
    let emit = |event: AgentEvent| {
        events
            .lock()
            .unwrap()
            .push(serde_json::to_value(event).unwrap());
    };
    let signal = recorder.controller.signal();
    let runtime = LoopRuntime {
        hooks: &hooks,
        stream_fn: &stream,
        signal: &signal,
        sink: &emit,
    };
    let config = AgentLoopConfig {
        options: SimpleOptions {
            reasoning: case.reasoning.clone(),
            ..SimpleOptions::default()
        },
        api_key: case.api_key.clone(),
        tool_execution: case.tool_execution.unwrap_or_default(),
        clock: || 0,
        ..AgentLoopConfig::new(model())
    };
    let context = AgentContext {
        messages: case.context.clone(),
        tools,
    };
    let messages = match &case.prompts {
        Some(prompts) => run_agent_loop(prompts.clone(), context, config, runtime).await,
        None => run_agent_loop_continue(context, config, runtime)
            .await
            .unwrap(),
    };
    let messages = messages
        .iter()
        .map(|message| serde_json::to_value(message).unwrap())
        .collect();
    let take = |list: &Mutex<Vec<Value>>| std::mem::take(&mut *list.lock().unwrap());
    [
        take(&events),
        take(&recorder.calls),
        take(&recorder.hooks),
        take(&recorder.executions),
        messages,
    ]
}

#[tokio::test]
async fn loop_runs_as_typescript_does() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/loop");
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
            &case.events,
            &case.calls,
            &case.hooks,
            &case.executions,
            &case.messages,
        ];
        let parts = ["events", "calls", "hooks", "executions", "messages"];
        for ((part, expected), actual) in parts.iter().zip(expected).zip(&actual) {
            if let Some(difference) = first_difference(expected, actual) {
                failures.push(format!("{} {part}: {difference}", case.name));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn continuing_needs_a_message_to_answer() {
    struct Silent;
    impl AgentHooks for Silent {}
    impl StreamFn for Silent {
        fn stream<'a>(
            &'a self,
            _model: &'a Model,
            _messages: &'a [Message],
            _request: &'a StreamRequest,
        ) -> BoxStream<'a, StreamEvent> {
            unreachable!("no request is made")
        }
    }
    let signal = AbortSignal::never();
    let runtime = LoopRuntime {
        hooks: &Silent,
        stream_fn: &Silent,
        signal: &signal,
        sink: &|_: AgentEvent| {},
    };
    let config = AgentLoopConfig::new(model());
    let empty = run_agent_loop_continue(AgentContext::default(), config.clone(), runtime).await;
    assert_eq!(
        empty.unwrap_err(),
        "Cannot continue: no messages in context"
    );
    let answer = response_events(
        &config.model,
        &Response {
            content: vec![OutputBlock::Text(TextContent {
                text: "Hi".into(),
                text_signature: None,
                volatile: None,
            })],
            stop_reason: None,
            error_message: None,
        },
    )
    .pop()
    .unwrap()
    .partial;
    let context = AgentContext {
        messages: vec![answer.into()],
        tools: Vec::new(),
    };
    let after_answer = run_agent_loop_continue(context, config, runtime).await;
    assert_eq!(
        after_answer.unwrap_err(),
        "Cannot continue from message role: assistant"
    );
}
