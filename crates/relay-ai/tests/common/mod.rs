//! A local HTTP/1.1 server that answers from a script, for the tests that send requests. Nothing
//! reaches a real provider.

#![allow(dead_code)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// One scripted answer: parts written in order, each after its pause.
#[derive(Clone)]
pub struct Answer {
    pub parts: Vec<(Duration, String)>,
    /// Close the connection after the last part, as a server that dies mid-body does.
    pub close: bool,
}

pub fn answer(status: &str, headers: &[(&str, &str)], body: &str) -> Answer {
    let mut head = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\n", body.len());
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    Answer {
        parts: vec![(Duration::ZERO, format!("{head}\r\n{body}"))],
        close: false,
    }
}

/// A chunked 200 whose chunks arrive after the given pauses.
pub fn streamed(chunks: &[(u64, &str)]) -> Answer {
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
    Answer {
        parts,
        close: false,
    }
}

/// A chunked 200 that sends `body` as one chunk, then, after `pause`, either stalls (the
/// connection stays open) or, with `close`, drops the connection without ending the body.
pub fn interrupted(body: &str, pause: Duration, close: bool) -> Answer {
    Answer {
        parts: vec![
            (
                Duration::ZERO,
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n",
                    body.len()
                ),
            ),
            (pause, String::new()),
        ],
        close,
    }
}

#[derive(Debug, Clone)]
pub struct Received {
    pub head: String,
    pub body: String,
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
pub async fn serve(answers: Vec<Answer>) -> (String, Arc<Mutex<Vec<Received>>>) {
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
                    let Some(Answer { parts, close }) = answers.lock().unwrap().next() else {
                        return;
                    };
                    for (pause, part) in parts {
                        tokio::time::sleep(pause).await;
                        if stream.write_all(part.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                    if close {
                        return;
                    }
                }
            });
        }
    });
    (url, received)
}
