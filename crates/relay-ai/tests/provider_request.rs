//! Each adapter's HTTP request and error messages, from what the TypeScript adapters and their
//! SDKs did in `crates/fixtures/http/` (`npm run parity:record`): the same URL, the same headers
//! (without the SDK telemetry the fixtures list as omitted), the same body, the same message.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use relay_ai::anthropic::AnthropicOptions;
use relay_ai::google::GoogleOptions;
use relay_ai::http::HttpRequest;
use relay_ai::openai_completions::OpenAICompletionsOptions;
use relay_ai::openai_responses::OpenAIResponsesOptions;
use relay_ai::provider_request::{
    anthropic_error_message, anthropic_request, google_error_message, google_request,
    openai_completions_error_message, openai_completions_request, openai_responses_error_message,
    openai_responses_request, RequestOptions,
};
use relay_ai::retry::{HttpError, RequestError};
use relay_ai::{Message, Model};
use serde_json::Value;

fn cases() -> Vec<(String, Value)> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/http");
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

fn options<T: serde::de::DeserializeOwned>(case: &Value) -> T {
    serde_json::from_value(case["options"].clone()).unwrap()
}

fn build(case: &Value) -> Result<HttpRequest, String> {
    let model: Model = serde_json::from_value(case["model"].clone()).unwrap();
    let messages: Vec<Message> = serde_json::from_value(case["messages"].clone()).unwrap();
    let request: RequestOptions = options(case);
    match case["adapter"].as_str().unwrap() {
        "anthropic" => anthropic_request(
            &model,
            &messages,
            &options::<AnthropicOptions>(case),
            &request,
        ),
        "responses" => openai_responses_request(
            &model,
            &messages,
            &options::<OpenAIResponsesOptions>(case),
            &request,
        ),
        "completions" => openai_completions_request(
            &model,
            &messages,
            &options::<OpenAICompletionsOptions>(case),
            &request,
        ),
        "google" => google_request(&model, &messages, &options::<GoogleOptions>(case), &request),
        other => Err(format!("unknown adapter {other}")),
    }
}

fn error_message(case: &Value, error: &RequestError) -> String {
    let model: Model = serde_json::from_value(case["model"].clone()).unwrap();
    match case["adapter"].as_str().unwrap() {
        "anthropic" => anthropic_error_message(error),
        "responses" => openai_responses_error_message(&model, error),
        "completions" => openai_completions_error_message(error),
        _ => google_error_message(error),
    }
}

fn answer_error(answer: &Value) -> RequestError {
    if answer == "connection-failure" {
        return RequestError::Http(HttpError {
            message: "Connection error: refused".into(),
            ..HttpError::default()
        });
    }
    let headers = answer
        .get("headers")
        .and_then(Value::as_object)
        .map(|headers| {
            headers
                .iter()
                .map(|(name, value)| (name.to_lowercase(), value.as_str().unwrap().to_string()))
                .collect()
        })
        .unwrap_or_default();
    RequestError::Http(HttpError {
        status: answer["status"].as_u64().map(|status| status as u16),
        status_text: answer["statusText"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        headers,
        message: String::new(),
        body: answer["body"].as_str().map(str::to_string),
    })
}

#[test]
fn sends_what_the_typescript_adapters_send() {
    let mut failures = Vec::new();
    let mut count = 0;
    for (name, case) in cases() {
        if case.get("answer").is_some() {
            continue;
        }
        count += 1;
        let expected = &case["request"];
        let request = match build(&case) {
            Ok(request) => request,
            Err(error) => {
                failures.push(format!("{name}: {error}"));
                continue;
            }
        };
        let headers: BTreeMap<String, String> = request
            .headers
            .iter()
            .map(|(header, value)| {
                let value = if header == "user-agent" && value.starts_with("relay (") {
                    "relay (<os>)".to_string()
                } else {
                    value.clone()
                };
                (header.clone(), value)
            })
            .collect();
        let recorded: BTreeMap<String, String> = expected["headers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(header, value)| (header.clone(), value.as_str().unwrap().to_string()))
            .collect();
        if request.url != expected["url"] {
            failures.push(format!(
                "{name}: URL {} instead of {}",
                request.url, expected["url"]
            ));
        }
        if headers != recorded {
            failures.push(format!(
                "{name}: headers\n  TypeScript {recorded:?}\n  Rust       {headers:?}"
            ));
        }
        let body = String::from_utf8(request.body).unwrap();
        let same_body = if case["adapter"] == "google" {
            serde_json::from_str::<Value>(&body).unwrap()
                == serde_json::from_str::<Value>(expected["body"].as_str().unwrap()).unwrap()
        } else {
            body == expected["body"].as_str().unwrap()
        };
        if !same_body {
            failures.push(format!(
                "{name}: body\n  TypeScript {}\n  Rust       {body}",
                expected["body"]
            ));
        }
    }
    assert!(count >= 15, "only {count} request cases");
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn reports_http_errors_as_the_typescript_adapters_do() {
    let mut failures = Vec::new();
    let mut count = 0;
    for (name, case) in cases() {
        let Some(answer) = case.get("answer") else {
            continue;
        };
        count += 1;
        let message = error_message(&case, &answer_error(answer));
        if message != case["errorMessage"] {
            failures.push(format!(
                "{name}:\n  TypeScript {}\n  Rust       {message:?}",
                case["errorMessage"]
            ));
        }
    }
    assert!(count >= 15, "only {count} error cases");
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
