//! The retry policy replayed from what `retryProviderRequest` did in `crates/fixtures/retry.json`
//! (`npm run parity:record`): the same attempts, the same delays, the same outcome.

use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;

use relay_ai::abort::AbortController;
use relay_ai::retry::{retry_with, HttpError, RequestError, RetryOptions};
use serde_json::{json, Value};

#[tokio::test]
async fn retries_as_typescript_does() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/retry.json");
    let fixture: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let now = fixture["now"].as_f64().unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 25);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let attempts = case["attempts"].as_array().unwrap().clone();
        let options = RetryOptions {
            max_retries: case["maxRetries"].as_u64().unwrap_or(0) as u32,
            max_retry_delay_ms: case["maxRetryDelayMs"].as_f64(),
        };
        let random = case["random"].as_f64().unwrap_or(0.5);
        let abort_on = case["abortOnAttempt"].as_u64();
        let controller = AbortController::new();
        let signal = controller.signal();
        let count = RefCell::new(0u64);
        let delays = RefCell::new(Vec::<f64>::new());
        let outcome = retry_with(
            options,
            &signal,
            || {
                let index = *count.borrow();
                *count.borrow_mut() += 1;
                if abort_on == Some(index) {
                    controller.abort();
                }
                let attempt = &attempts[index as usize];
                let result = if attempt == "ok" {
                    Ok(format!("attempt {index} succeeded"))
                } else {
                    let headers = attempt["headers"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .map(|(name, value)| (name.clone(), value.as_str().unwrap().to_string()))
                        .collect();
                    Err(RequestError::Http(HttpError {
                        status: attempt["status"].as_u64().map(|status| status as u16),
                        headers,
                        message: format!("attempt {index} failed"),
                        ..HttpError::default()
                    }))
                };
                std::future::ready(result)
            },
            |delay| {
                delays.borrow_mut().push(delay.as_secs_f64() * 1000.0);
                std::future::ready(())
            },
            || now,
            || random,
        )
        .await;

        assert_eq!(json!(*count.borrow()), case["tries"], "{name}: tries");
        let expected: Vec<f64> = case["delays"]
            .as_array()
            .unwrap()
            .iter()
            .map(|delay| delay.as_f64().unwrap())
            .collect();
        let delays = delays.into_inner();
        assert_eq!(delays.len(), expected.len(), "{name}: {delays:?}");
        for (delay, expected) in delays.iter().zip(&expected) {
            assert!((delay - expected).abs() < 1e-6, "{name}: {delays:?}");
        }
        let written = match outcome {
            Ok(result) => json!(result),
            Err(RequestError::Aborted) => {
                json!({ "name": "AbortError", "message": "Request aborted" })
            }
            Err(error) => json!({ "name": "Error", "message": error.to_string() }),
        };
        let expected = case.get("result").unwrap_or(&case["error"]);
        assert_eq!(&written, expected, "{name}");
    }
}
