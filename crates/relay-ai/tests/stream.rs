//! Each adapter's `stream()` against a local server, compared with what the TypeScript adapters
//! emitted (`npm run parity:record`): a complete response (`crates/fixtures/*-stream/`), and a
//! request that fails (`crates/fixtures/stream-failures/`): an HTTP error, an abort before the
//! response, an abort while the body streams, and a connection that drops mid-body.

mod common;

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use common::{answer, interrupted, serve, streamed};
use relay_ai::abort::AbortController;
use relay_ai::event::AssistantEvent;
use relay_ai::provider_request::RequestOptions;
use relay_ai::retry::RetryOptions;
use relay_ai::stream::{
    stream_anthropic, stream_google, stream_openai_completions, stream_openai_responses,
    SendOptions,
};
use relay_ai::{Message, Model};
use serde_json::Value;

/// Long enough for the client to process what arrived before the failure.
const PROCESSING: Duration = Duration::from_millis(300);

fn cases() -> Vec<(String, Value)> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/stream-failures");
    let mut files: Vec<PathBuf> = fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("{}: {error}", directory.display()))
        .map(|entry| entry.unwrap().path())
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            (
                name,
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap(),
            )
        })
        .collect()
}

async fn replay(case: &Value) -> Vec<AssistantEvent> {
    let failure = case["failure"].as_str().unwrap_or("none");
    let sse = case["sse"].as_str().unwrap();
    let served = match failure {
        "none" => vec![streamed(&[(0, sse)])],
        "http-error" => {
            let error = &case["answer"];
            let headers: Vec<(&str, &str)> = error["headers"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(name, value)| (name.as_str(), value.as_str().unwrap()))
                .collect();
            vec![answer(
                "500 Internal Server Error",
                &headers,
                error["body"].as_str().unwrap(),
            )]
        }
        "connection-drop" => vec![interrupted(sse, PROCESSING, true)],
        _ => vec![interrupted(sse, Duration::from_secs(30), false)],
    };
    let (url, _) = serve(served).await;
    let base = url.trim_end_matches("/v1/messages").to_string();
    let mut model: Model = serde_json::from_value(case["model"].clone()).unwrap();
    model.base_url = base;
    let messages: Vec<Message> = serde_json::from_value(case["messages"].clone()).unwrap();
    let request = RequestOptions {
        api_key: case["apiKey"].as_str().map(str::to_string),
        ..RequestOptions::default()
    };
    let controller = AbortController::new();
    match failure {
        "abort-before-response" => controller.abort(),
        "abort-mid-stream" => {
            let controller = controller.clone();
            tokio::spawn(async move {
                tokio::time::sleep(PROCESSING).await;
                controller.abort();
            });
        }
        _ => {}
    }
    let signal = controller.signal();
    let send = SendOptions {
        request: &request,
        retry: RetryOptions::default(),
        signal: &signal,
        clock: || 0,
    };
    let mut events = Vec::new();
    let mut emit = |event| events.push(event);
    match case["adapter"].as_str().unwrap() {
        "anthropic" => {
            stream_anthropic(&model, &messages, &Default::default(), &send, &mut emit).await
        }
        "responses" => {
            stream_openai_responses(&model, &messages, &Default::default(), &send, &mut emit).await
        }
        "completions" => {
            stream_openai_completions(&model, &messages, &Default::default(), &send, &mut emit)
                .await
        }
        _ => stream_google(&model, &messages, &Default::default(), &send, &mut emit).await,
    }
    events
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fails_as_the_typescript_adapters_do() {
    let cases = cases();
    assert_eq!(cases.len(), 16);
    let mut failures = Vec::new();
    for (name, case) in cases {
        let events = serde_json::to_value(replay(&case).await).unwrap();
        if events != case["events"] {
            failures.push(format!(
                "{name}:\n  TypeScript {}\n  Rust       {events}",
                case["events"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

/// The recorded stream each adapter's failures start from, and its key.
const COMPLETE: [(&str, &str, &str); 4] = [
    (
        "anthropic",
        "anthropic-stream/text.json",
        "sk-ant-api03-parity",
    ),
    (
        "responses",
        "openai-responses-stream/reasoning-text-and-tool.json",
        "sk-parity",
    ),
    (
        "completions",
        "openai-completions-stream/text.json",
        "sk-parity",
    ),
    ("google", "google-stream/text.json", "google-parity-key"),
];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn streams_a_complete_response_as_the_decoders_do() {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures");
    for (adapter, source, key) in COMPLETE {
        let mut case: Value =
            serde_json::from_str(&fs::read_to_string(fixtures.join(source)).unwrap()).unwrap();
        case["adapter"] = adapter.into();
        case["apiKey"] = key.into();
        let events = serde_json::to_value(replay(&case).await).unwrap();
        assert_eq!(events, case["events"], "{source}");
    }
}
