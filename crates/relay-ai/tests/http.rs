//! Sending against a local HTTP/1.1 server that answers from a script: retries, error bodies,
//! streamed bodies and aborts. Nothing reaches a real provider.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use relay_ai::abort::{AbortController, AbortSignal};
use relay_ai::http::{post, truncate_error_text, HttpRequest};
use relay_ai::retry::{RequestError, RetryOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// One scripted answer: parts written in order, each after its pause.
#[derive(Clone)]
struct Answer(Vec<(Duration, String)>);

fn answer(status: &str, headers: &[(&str, &str)], body: &str) -> Answer {
    let mut head = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\n", body.len());
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    Answer(vec![(Duration::ZERO, format!("{head}\r\n{body}"))])
}

/// A chunked 200 whose chunks arrive after the given pauses.
fn streamed(chunks: &[(u64, &str)]) -> Answer {
    let mut parts = vec![(
        Duration::ZERO,
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n"
            .to_string(),
    )];
    for (pause, chunk) in chunks {
        parts.push((
            Duration::from_millis(*pause),
            format!("{:x}\r\n{chunk}\r\n", chunk.len()),
        ));
    }
    parts.push((Duration::ZERO, "0\r\n\r\n".to_string()));
    Answer(parts)
}

#[derive(Debug, Clone)]
struct Received {
    head: String,
    body: String,
}

/// Reads one request, by its content length; none at the end of the connection.
async fn read_request(stream: &mut TcpStream) -> Option<Received> {
    let mut data = Vec::new();
    let mut buffer = [0u8; 4096];
    let head_end = loop {
        if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break end;
        }
        let read = stream.read(&mut buffer).await.ok()?;
        if read == 0 {
            return None;
        }
        data.extend_from_slice(&buffer[..read]);
    };
    let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
    let length: usize = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())?
        })
        .unwrap_or(0);
    let mut body = data[head_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut buffer).await.ok()?;
        if read == 0 {
            return None;
        }
        body.extend_from_slice(&buffer[..read]);
    }
    Some(Received {
        head,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

/// Serves the answers in order, across connections, and records the requests.
async fn serve(answers: Vec<Answer>) -> (String, Arc<Mutex<Vec<Received>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/messages", listener.local_addr().unwrap());
    let received = Arc::new(Mutex::new(Vec::new()));
    let answers = Arc::new(Mutex::new(answers.into_iter()));
    let log = received.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let answers = answers.clone();
            let log = log.clone();
            tokio::spawn(async move {
                while let Some(request) = read_request(&mut stream).await {
                    log.lock().unwrap().push(request);
                    let Some(Answer(parts)) = answers.lock().unwrap().next() else {
                        return;
                    };
                    for (pause, part) in parts {
                        tokio::time::sleep(pause).await;
                        if stream.write_all(part.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                }
            });
        }
    });
    (url, received)
}

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
