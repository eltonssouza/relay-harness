//! Sending against a local HTTP/1.1 server that answers from a script: retries, error bodies,
//! streamed bodies and aborts. Nothing reaches a real provider.

mod common;

use std::time::{Duration, Instant};

use common::{answer, serve, streamed};
use relay_ai::abort::{AbortController, AbortSignal};
use relay_ai::http::{post, truncate_error_text, HttpRequest};
use relay_ai::retry::{RequestError, RetryOptions};
use tokio::net::TcpListener;

fn request(url: &str) -> HttpRequest {
    HttpRequest {
        url: url.to_string(),
        headers: vec![
            ("content-type".into(), "application/json".into()),
            ("x-api-key".into(), "test-key".into()),
        ],
        body: br#"{"model":"m"}"#.to_vec(),
    }
}

fn retries(max_retries: u32) -> RetryOptions {
    RetryOptions {
        max_retries,
        max_retry_delay_ms: None,
    }
}

#[tokio::test]
async fn retries_a_rate_limit_then_streams_the_body() {
    let (url, received) = serve(vec![
        answer("429 Too Many Requests", &[("retry-after-ms", "20")], ""),
        streamed(&[(0, "data: one\n\n"), (20, "data: two\n\n")]),
    ])
    .await;
    let signal = AbortSignal::never();
    let mut response = post(&request(&url), retries(2), &signal).await.unwrap();
    assert_eq!(response.status, 200);
    assert!(response
        .headers
        .contains(&("content-type".into(), "text/event-stream".into())));
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk(&signal).await.unwrap() {
        body.extend(chunk);
    }
    assert_eq!(
        String::from_utf8(body).unwrap(),
        "data: one\n\ndata: two\n\n"
    );
    let received = received.lock().unwrap();
    assert_eq!(received.len(), 2);
    for request in received.iter() {
        assert!(
            request.head.starts_with("POST /v1/messages HTTP/1.1"),
            "{}",
            request.head
        );
        assert!(request.head.to_lowercase().contains("x-api-key: test-key"));
        assert_eq!(request.body, r#"{"model":"m"}"#);
    }
}

#[tokio::test]
async fn a_client_error_is_not_retried_and_keeps_its_body() {
    let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}"#;
    let (url, received) = serve(vec![
        answer(
            "400 Bad Request",
            &[("content-type", "application/json")],
            body,
        ),
        answer("200 OK", &[], ""),
    ])
    .await;
    let error = post(&request(&url), retries(3), &AbortSignal::never())
        .await
        .unwrap_err();
    let RequestError::Http(error) = error else {
        panic!("{error:?}")
    };
    assert_eq!(error.status, Some(400));
    assert_eq!(error.body.as_deref(), Some(body));
    assert_eq!(error.header("Content-Type"), Some("application/json"));
    assert_eq!(received.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn an_empty_error_body_says_so() {
    let (url, _) = serve(vec![answer("503 Service Unavailable", &[], "  ")]).await;
    let error = post(&request(&url), retries(0), &AbortSignal::never())
        .await
        .unwrap_err();
    let RequestError::Http(error) = error else {
        panic!("{error:?}")
    };
    assert_eq!(error.body.as_deref(), Some("  "));
    assert_eq!(error.status_text, "Service Unavailable");
    assert_eq!(error.message, "503 status code (no body)");
}

#[tokio::test]
async fn an_abort_ends_the_backoff() {
    let (url, _) = serve(vec![answer(
        "429 Too Many Requests",
        &[("retry-after", "30")],
        "",
    )])
    .await;
    let controller = AbortController::new();
    let signal = controller.signal();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        controller.abort();
    });
    let started = Instant::now();
    let error = post(&request(&url), retries(3), &signal).await.unwrap_err();
    assert_eq!(error, RequestError::Aborted);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn an_abort_ends_a_stalled_body() {
    let (url, _) = serve(vec![streamed(&[(0, "data: one\n\n"), (30_000, "late")])]).await;
    let controller = AbortController::new();
    let signal = controller.signal();
    let mut response = post(&request(&url), retries(0), &signal).await.unwrap();
    assert_eq!(
        response.chunk(&signal).await.unwrap().as_deref(),
        Some(&b"data: one\n\n"[..])
    );
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        controller.abort();
    });
    let started = Instant::now();
    assert_eq!(
        response.chunk(&signal).await.unwrap_err(),
        RequestError::Aborted
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn a_refused_connection_is_an_error_without_a_status() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/messages", listener.local_addr().unwrap());
    drop(listener);
    let error = post(&request(&url), retries(0), &AbortSignal::never())
        .await
        .unwrap_err();
    let RequestError::Http(error) = error else {
        panic!("{error:?}")
    };
    assert_eq!(error.status, None);
    assert!(
        error.message.starts_with("Connection error"),
        "{}",
        error.message
    );
}

#[test]
fn truncates_error_text_by_javascript_length() {
    assert_eq!(truncate_error_text("short", 10), "short");
    assert_eq!(
        truncate_error_text("abcdef", 4),
        "abcd... [truncated 2 chars]"
    );
    // An emoji is two UTF-16 units; it is not split.
    assert_eq!(
        truncate_error_text("ab🙈cd", 3),
        "ab... [truncated 3 chars]"
    );
}
