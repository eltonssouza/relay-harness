//! The loop answered through the provider adapters (`ProviderStream`), against a local server
//! that replays the responses recorded for each adapter in `crates/fixtures/*-stream/`. The run
//! must end with the message the adapter decoded, stream the adapter's events in order with the
//! message so far, and send the request with the request's key. Nothing reaches a provider.

#[path = "../../relay-ai/tests/common/mod.rs"]
mod common;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use common::{answer, serve, streamed};
use futures_util::future::{ready, BoxFuture};
use relay_agent::{
    run_agent_loop_continue, AgentContext, AgentEvent, AgentHooks, AgentLoopConfig, AgentMessage,
    AgentTurnContext, LoopRuntime, ProviderStream, TurnDecision,
};
use relay_ai::abort::AbortSignal;
use relay_ai::retry::RetryOptions;
use relay_ai::{Message, Model};
use serde_json::{json, Value};

/// Ends the run after its first turn: a recorded answer may call a tool, and the server has no
/// second answer.
struct OneTurn;
impl AgentHooks for OneTurn {
    fn finish_turn<'a>(
        &'a self,
        _turn: AgentTurnContext<'a>,
        _signal: &'a AbortSignal,
    ) -> BoxFuture<'a, Option<TurnDecision>> {
        Box::pin(ready(Some(TurnDecision::End)))
    }
}

/// A recorded response for each adapter, and the key its request carries.
const RECORDED: [(&str, &str); 4] = [
    ("anthropic-stream/text.json", "sk-ant-api03-parity"),
    (
        "openai-responses-stream/reasoning-text-and-tool.json",
        "sk-parity",
    ),
    ("openai-completions-stream/text.json", "sk-parity"),
    ("google-stream/text.json", "google-parity-key"),
];

fn fixture(source: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures")
        .join(source);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

/// The response cut after each event, so it arrives in several chunks.
fn chunks(sse: &str) -> Vec<(u64, &str)> {
    let mut chunks = Vec::new();
    let mut start = 0;
    while let Some(offset) = sse[start..].find("\n\n") {
        let end = start + offset + 2;
        chunks.push((0, &sse[start..end]));
        start = end;
    }
    if start < sse.len() {
        chunks.push((0, &sse[start..]));
    }
    chunks
}

struct Run {
    events: Vec<Value>,
    messages: Vec<Value>,
}

async fn run(model: Model, messages: Vec<Message>, key: Option<&str>, retry: RetryOptions) -> Run {
    let events = Mutex::new(Vec::new());
    let sink = |event: AgentEvent| {
        events
            .lock()
            .unwrap()
            .push(serde_json::to_value(event).unwrap());
    };
    let signal = AbortSignal::never();
    let stream = ProviderStream { clock: || 0 };
    let runtime = LoopRuntime {
        hooks: &OneTurn,
        stream_fn: &stream,
        signal: &signal,
        sink: &sink,
    };
    let config = AgentLoopConfig {
        api_key: key.map(str::to_string),
        retry,
        clock: || 0,
        ..AgentLoopConfig::new(model)
    };
    let context = AgentContext {
        messages: messages.into_iter().map(AgentMessage::from).collect(),
        tools: Vec::new(),
    };
    let added = run_agent_loop_continue(context, config, runtime)
        .await
        .unwrap();
    Run {
        events: events.into_inner().unwrap(),
        messages: added
            .iter()
            .map(|message| serde_json::to_value(message).unwrap())
            .collect(),
    }
}

/// The assistant message the run added.
fn answer_of(run: &Run) -> Option<&Value> {
    run.messages
        .iter()
        .find(|message| message["role"] == "assistant")
}

/// The recorded final message, as the loop ends it: with the requested level, `off`.
fn final_message(case: &Value) -> Value {
    let last = case["events"].as_array().unwrap().last().unwrap();
    let mut message = last
        .get("message")
        .or_else(|| last.get("error"))
        .unwrap()
        .clone();
    message["thinkingLevel"] = "off".into();
    message
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_through_each_adapter() {
    for (source, key) in RECORDED {
        let case = fixture(source);
        let (url, received) = serve(vec![streamed(&chunks(case["sse"].as_str().unwrap()))]).await;
        let mut model: Model = serde_json::from_value(case["model"].clone()).unwrap();
        model.base_url = url.trim_end_matches("/v1/messages").to_string();
        let messages: Vec<Message> = serde_json::from_value(case["messages"].clone()).unwrap();
        let run = run(model, messages, Some(key), RetryOptions::default()).await;

        // The recorded transcripts declare tools this context lacks: the loop announces their
        // removal before the request.
        assert_eq!(
            answer_of(&run),
            Some(&final_message(&case)),
            "{source}: the answer"
        );
        let requests = received.lock().unwrap();
        assert_eq!(requests.len(), 1, "{source}: one request");
        assert!(requests[0].head.contains(key), "{source}: the key is sent");

        // The adapter's events, in order, each with the message as far as it got.
        let recorded: Vec<&Value> = case["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| !matches!(event["type"].as_str(), Some("start" | "done" | "error")))
            .collect();
        let updates: Vec<&Value> = run
            .events
            .iter()
            .filter(|event| event["type"] == "message_update")
            .collect();
        assert_eq!(
            updates.len(),
            recorded.len(),
            "{source}: one update per event"
        );
        for (update, expected) in updates.iter().zip(&recorded) {
            let mut event = update["assistantMessageEvent"].clone();
            let partial = event.as_object_mut().unwrap().remove("partial").unwrap();
            assert_eq!(&event, *expected, "{source}");
            assert_eq!(
                update["message"], partial,
                "{source}: the update is the partial"
            );
            let index = event["contentIndex"].as_u64().unwrap() as usize;
            assert!(
                partial["content"].as_array().unwrap().len() > index,
                "{source}: the partial holds block {index}: {partial}"
            );
        }
        let last = updates.last().unwrap();
        assert_eq!(
            last["message"]["content"],
            final_message(&case)["content"],
            "{source}: the last partial is complete"
        );
        let starts = run
            .events
            .iter()
            .filter(|event| {
                event["type"] == "message_start" && event["message"]["role"] == "assistant"
            })
            .count();
        assert_eq!(starts, 1, "{source}: the answer starts once");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retries_as_the_request_allows() {
    let case = fixture("anthropic-stream/text.json");
    let overloaded = answer(
        "529 Overloaded",
        &[
            ("content-type", "application/json"),
            ("retry-after-ms", "0"),
        ],
        r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
    );
    let served = vec![overloaded, streamed(&chunks(case["sse"].as_str().unwrap()))];
    let (url, received) = serve(served).await;
    let mut model: Model = serde_json::from_value(case["model"].clone()).unwrap();
    model.base_url = url.trim_end_matches("/v1/messages").to_string();
    let messages: Vec<Message> = serde_json::from_value(case["messages"].clone()).unwrap();
    let retry = RetryOptions {
        max_retries: 1,
        max_retry_delay_ms: None,
    };
    let run = run(model, messages, Some("sk-ant-api03-parity"), retry).await;
    assert_eq!(answer_of(&run), Some(&final_message(&case)));
    assert_eq!(received.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn an_api_without_an_adapter_ends_with_an_error() {
    let model: Model = serde_json::from_value(json!({
        "id": "mistral-large", "name": "Mistral Large", "api": "mistral-conversations",
        "provider": "mistral", "baseUrl": "https://example.invalid", "reasoning": false,
        "input": ["text"], "contextWindow": 128000, "maxTokens": 4096,
    }))
    .unwrap();
    let user =
        serde_json::from_value(json!({"role": "user", "content": "Hi", "timestamp": 0})).unwrap();
    let run = run(model, vec![user], Some("key"), RetryOptions::default()).await;
    let answer = &run.messages[0];
    assert_eq!(answer["stopReason"], "error");
    assert_eq!(
        answer["errorMessage"],
        "No API provider registered for api: mistral-conversations"
    );
}
