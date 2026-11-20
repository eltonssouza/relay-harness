//! What the OpenAI SDK (7.19.0, `Stream.fromSSEResponse`, the version `packages/ai` loads) does
//! with each server-sent event before an adapter sees it, and helpers both OpenAI stream decoders
//! share.

use serde_json::{json, Value};

use crate::sse::ServerSentEvent;

/// One server-sent event after the SDK.
pub(crate) enum SdkMessage {
    /// `[DONE]`: the SDK stops reading.
    Sentinel,
    /// An event the SDK passes on in another form, which no adapter reads.
    Ignored,
    Data(Value),
}

/// An error the SDK throws: its message, and for an `APIError` the error object it carries
/// (OpenRouter puts extra details in `metadata.raw`).
pub(crate) struct SdkError {
    pub message: String,
    pub error: Option<Value>,
}

impl From<String> for SdkError {
    fn from(message: String) -> Self {
        SdkError {
            message,
            error: None,
        }
    }
}

pub(crate) fn sdk_message(sse: &ServerSentEvent) -> Result<SdkMessage, SdkError> {
    if sse.data == "[DONE]" {
        return Ok(SdkMessage::Sentinel);
    }
    let data: Value = serde_json::from_str(&sse.data).map_err(|_| {
        SdkError::from("Error reading response: malformed server-sent event JSON.".to_string())
    })?;
    let named = sse.event.as_deref();
    if named.is_some_and(|name| name.starts_with("thread.")) {
        return Ok(SdkMessage::Ignored);
    }
    let api_error = |error: &Value| SdkError {
        message: api_error_message(error),
        error: Some(error.clone()),
    };
    if named == Some("error") {
        let error = data
            .get("error")
            .filter(|error| !error.is_null())
            .unwrap_or(&data);
        return Err(api_error(error));
    }
    if let Some(error) = data.get("error").filter(|error| is_truthy(error)) {
        return Err(api_error(error));
    }
    Ok(SdkMessage::Data(data))
}

/// `APIError.makeMessage` for an error object without an HTTP status.
pub(crate) fn api_error_message(error: &Value) -> String {
    match error.get("message") {
        Some(Value::String(message)) if !message.is_empty() => message.clone(),
        Some(message) if is_truthy(message) => message.to_string(),
        _ if is_truthy(error) => error.to_string(),
        _ => "(no status code or body)".into(),
    }
}

/// JavaScript truthiness.
pub(crate) fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

pub(crate) fn text_of(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// `` `${value}` ``: `undefined` when it is missing.
pub(crate) fn template(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".into(),
        Some(other) => other.to_string(),
    }
}

/// `String(value)` for a value appended to a message.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        other => other.to_string(),
    }
}

pub(crate) fn token_count(value: Option<&Value>) -> u64 {
    value
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_f64().map(|float| float as u64))
        })
        .unwrap_or(0)
}

/// The JSON-encoded deltas of a grammar tool's input, as `appendGrammarToolInputJsonDelta` writes
/// them: `{"<property>":"` first, the escaped input as it grows, `"}` when it closes.
#[derive(Debug, Default)]
pub(crate) struct GrammarInput {
    pub property: String,
    input: String,
    started: bool,
    closed: bool,
}

impl GrammarInput {
    pub fn new(property: String) -> Self {
        GrammarInput {
            property,
            ..GrammarInput::default()
        }
    }

    pub fn append(&mut self, next_input: &str, close: bool) -> Result<Option<String>, String> {
        if self.closed {
            if close && next_input == self.input {
                return Ok(None);
            }
            return Err(format!(
                "grammar tool input for property \"{}\" changed after it was closed",
                self.property
            ));
        }
        if !next_input.starts_with(&self.input) {
            return Err(format!(
                "grammar tool input for property \"{}\" changed non-monotonically",
                self.property
            ));
        }
        let input_delta = &next_input[self.input.len()..];
        if !close && input_delta.is_empty() {
            return Ok(None);
        }
        let mut delta = String::new();
        if !self.started {
            delta.push('{');
            delta.push_str(&json!(self.property).to_string());
            delta.push_str(":\"");
            self.started = true;
        }
        let escaped = json!(input_delta).to_string();
        delta.push_str(&escaped[1..escaped.len() - 1]);
        self.input = next_input.to_string();
        if close {
            delta.push_str("\"}");
            self.closed = true;
        }
        Ok(Some(delta))
    }
}
