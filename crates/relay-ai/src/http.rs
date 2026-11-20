//! Sending provider requests: one shared client (rustls with the ring backend, the operating
//! system's certificates, proxies from the environment), a POST that retries as the SDKs do
//! (`retry`), and a response body read chunk by chunk until it ends or the signal aborts.
//!
//! A response that is not 2xx becomes an `HttpError` with its status, reason phrase, headers and
//! body as received; each adapter words the message as its SDK does (`provider_error`). A request
//! that gets no response is an `HttpError` without a status, which the policy retries.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::abort::AbortSignal;
use crate::retry::{retry, HttpError, RequestError, RetryOptions};

/// The longest error body kept (`MAX_PROVIDER_ERROR_BODY_CHARS`).
pub const MAX_ERROR_BODY_CHARS: usize = 4000;
/// How long to wait for a connection; a streamed response may then take as long as it needs.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

/// The client every request shares, so connections are reused.
pub fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // Installing fails only when a provider is already installed, which is as good.
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .build()
                .map_err(|error| format!("Failed to create the HTTP client: {error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// A POST to a provider.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HttpRequest {
    pub url: String,
    /// Sent in order; a later header with the same name is added, not replaced.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

fn header_map(headers: &[(String, String)]) -> Result<HeaderMap, RequestError> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| RequestError::Other(format!("Invalid header name: {name}")))?;
        let value = HeaderValue::from_str(value)
            .map_err(|_| RequestError::Other(format!("Invalid value for header {name}")))?;
        map.append(name, value);
    }
    Ok(map)
}

fn response_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect()
}

/// `truncateErrorText`: the first characters (UTF-16 units, as JavaScript counts them) and how
/// many were cut.
pub fn truncate_error_text(text: &str, max_chars: usize) -> String {
    let length = crate::text::js_length(text);
    if length <= max_chars {
        return text.to_string();
    }
    let mut units = 0;
    let mut end = 0;
    for (index, character) in text.char_indices() {
        if units + character.len_utf16() > max_chars {
            break;
        }
        units += character.len_utf16();
        end = index + character.len_utf8();
    }
    format!(
        "{}... [truncated {} chars]",
        &text[..end],
        length - max_chars
    )
}

/// A response whose status was 2xx; read its body with `chunk`.
#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    response: reqwest::Response,
}

impl HttpResponse {
    /// The next part of the body, or none at its end. An abort ends the read.
    pub async fn chunk(&mut self, signal: &AbortSignal) -> Result<Option<Vec<u8>>, RequestError> {
        tokio::select! {
            chunk = self.response.chunk() => chunk
                .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
                .map_err(|error| RequestError::Http(HttpError {
                    message: format!("Error reading response: {error}"),
                    ..HttpError::default()
                })),
            _ = signal.aborted() => Err(RequestError::Aborted),
        }
    }
}

async fn send_once(
    request: &HttpRequest,
    signal: &AbortSignal,
) -> Result<HttpResponse, RequestError> {
    if signal.is_aborted() {
        return Err(RequestError::Aborted);
    }
    let headers = header_map(&request.headers)?;
    let send = client()
        .map_err(RequestError::Other)?
        .post(&request.url)
        .headers(headers)
        .body(request.body.clone())
        .send();
    let response = tokio::select! {
        response = send => response,
        _ = signal.aborted() => return Err(RequestError::Aborted),
    };
    let response = response.map_err(|error| {
        RequestError::Http(HttpError {
            message: format!("Connection error: {error}"),
            ..HttpError::default()
        })
    })?;
    let status = response.status().as_u16();
    let headers = response_headers(response.headers());
    if response.status().is_success() {
        return Ok(HttpResponse {
            status,
            headers,
            response,
        });
    }
    let status_text = if response.version() == reqwest::Version::HTTP_2 {
        String::new()
    } else {
        response
            .status()
            .canonical_reason()
            .unwrap_or_default()
            .to_string()
    };
    let text = tokio::select! {
        text = response.bytes() => text.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default(),
        _ = signal.aborted() => return Err(RequestError::Aborted),
    };
    let trimmed = crate::text::js_trim(&text);
    let message = if trimmed.is_empty() {
        format!("{status} status code (no body)")
    } else {
        format!(
            "{status} {}",
            truncate_error_text(trimmed, MAX_ERROR_BODY_CHARS)
        )
    };
    Err(RequestError::Http(HttpError {
        status: Some(status),
        status_text,
        headers,
        message,
        body: Some(text),
    }))
}

/// POST `request`, retrying as the SDKs do; the 2xx response's body is left to read.
pub async fn post(
    request: &HttpRequest,
    options: RetryOptions,
    signal: &AbortSignal,
) -> Result<HttpResponse, RequestError> {
    retry(options, signal, || send_once(request, signal)).await
}
