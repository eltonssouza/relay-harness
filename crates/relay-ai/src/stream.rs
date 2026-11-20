//! Each adapter's `stream()`: build the request, send it with the retry policy, feed the response
//! to the adapter's decoder, and end with the decoder's last event, or an error event when the
//! request fails, as the TypeScript adapters end it.
//!
//! - The request never got a response: an error event and no `start`, worded as the adapter's
//!   SDK words it; an abort before the response is `Request aborted`.
//! - The connection drops mid-body: `terminated`, undici's word for it.
//! - The request is aborted mid-body: Anthropic and Google report the cancelled read
//!   (`This operation was aborted`, or Anthropic's `Request was aborted` when it notices before
//!   reading); the OpenAI SDK ends the stream quietly, so Chat Completions closes its blocks and
//!   reports `Request was aborted`, and Responses reports what its end-of-stream check finds.
//!   The stop reason is `aborted` either way.
//!
//! Each event comes with the message as decoded so far, after the chunk that produced it.
//! The TypeScript events carry the adapter's live message instead, which is further along
//! by the time a slow consumer reads it.

use crate::abort::AbortSignal;
use crate::anthropic::{self, AnthropicOptions};
use crate::anthropic_stream::AnthropicStream;
use crate::event::AssistantEvent;
use crate::google::GoogleOptions;
use crate::google_stream::GoogleStream;
use crate::http::{post, HttpRequest};
use crate::openai_completions::OpenAICompletionsOptions;
use crate::openai_completions_stream::OpenAICompletionsStream;
use crate::openai_responses::OpenAIResponsesOptions;
use crate::openai_responses_stream::OpenAIResponsesStream;
use crate::provider_request::{
    anthropic_error_message, anthropic_request, google_error_message, google_request,
    openai_completions_error_message, openai_completions_request, openai_responses_error_message,
    openai_responses_request, RequestOptions,
};
use crate::retry::{RequestError, RetryOptions};
use crate::{AssistantMessage, Message, Model, StopReason};

/// How to send a request: its auth and headers, the retry policy, the cancellation, and the
/// clock that times the output.
#[derive(Clone, Copy)]
pub struct SendOptions<'a> {
    pub request: &'a RequestOptions,
    pub retry: RetryOptions,
    pub signal: &'a AbortSignal,
    pub clock: fn() -> u64,
}

/// What the glue needs from a decoder.
trait Decoder: Send {
    fn output(&self) -> &AssistantMessage;
    fn push(&mut self, bytes: &[u8]) -> Vec<AssistantEvent>;
    fn finish(&mut self) -> Vec<AssistantEvent>;
    fn end_with_error(&mut self, reason: StopReason, message: String) -> AssistantEvent;
    /// The request was aborted mid-body; `during_read` when a read was waiting.
    fn abort(&mut self, during_read: bool) -> Vec<AssistantEvent>;
}

const ABORTED_READ: &str = "This operation was aborted";
const ABORTED: &str = "Request was aborted";

impl Decoder for AnthropicStream {
    fn output(&self) -> &AssistantMessage {
        AnthropicStream::output(self)
    }
    fn push(&mut self, bytes: &[u8]) -> Vec<AssistantEvent> {
        AnthropicStream::push(self, bytes)
    }
    fn finish(&mut self) -> Vec<AssistantEvent> {
        AnthropicStream::finish(self)
    }
    fn end_with_error(&mut self, reason: StopReason, message: String) -> AssistantEvent {
        AnthropicStream::end_with_error(self, reason, message)
    }
    fn abort(&mut self, during_read: bool) -> Vec<AssistantEvent> {
        let message = if during_read { ABORTED_READ } else { ABORTED };
        vec![self.end_with_error(StopReason::Aborted, message.into())]
    }
}

impl Decoder for GoogleStream {
    fn output(&self) -> &AssistantMessage {
        GoogleStream::output(self)
    }
    fn push(&mut self, bytes: &[u8]) -> Vec<AssistantEvent> {
        GoogleStream::push(self, bytes)
    }
    fn finish(&mut self) -> Vec<AssistantEvent> {
        GoogleStream::finish(self)
    }
    fn end_with_error(&mut self, reason: StopReason, message: String) -> AssistantEvent {
        GoogleStream::end_with_error(self, reason, message)
    }
    fn abort(&mut self, _during_read: bool) -> Vec<AssistantEvent> {
        // The SDK's next read fails either way.
        vec![self.end_with_error(StopReason::Aborted, ABORTED_READ.into())]
    }
}

impl Decoder for OpenAICompletionsStream {
    fn output(&self) -> &AssistantMessage {
        OpenAICompletionsStream::output(self)
    }
    fn push(&mut self, bytes: &[u8]) -> Vec<AssistantEvent> {
        OpenAICompletionsStream::push(self, bytes)
    }
    fn finish(&mut self) -> Vec<AssistantEvent> {
        OpenAICompletionsStream::finish(self)
    }
    fn end_with_error(&mut self, reason: StopReason, message: String) -> AssistantEvent {
        OpenAICompletionsStream::end_with_error(self, reason, message)
    }
    fn abort(&mut self, _during_read: bool) -> Vec<AssistantEvent> {
        let mut events = self.close_blocks();
        if !matches!(events.last(), Some(AssistantEvent::Error { .. })) {
            events.push(self.end_with_error(StopReason::Aborted, ABORTED.into()));
        }
        events
    }
}

impl Decoder for OpenAIResponsesStream {
    fn output(&self) -> &AssistantMessage {
        OpenAIResponsesStream::output(self)
    }
    fn push(&mut self, bytes: &[u8]) -> Vec<AssistantEvent> {
        OpenAIResponsesStream::push(self, bytes)
    }
    fn finish(&mut self) -> Vec<AssistantEvent> {
        OpenAIResponsesStream::finish(self)
    }
    fn end_with_error(&mut self, reason: StopReason, message: String) -> AssistantEvent {
        OpenAIResponsesStream::end_with_error(self, reason, message)
    }
    fn abort(&mut self, _during_read: bool) -> Vec<AssistantEvent> {
        // The stream ends where it stopped; its end-of-stream check reports, as aborted.
        let mut events = self.finish();
        match events.pop() {
            Some(AssistantEvent::Error { error, .. }) => {
                let message = match &error {
                    Message::Assistant(output) => output.error_message.clone(),
                    _ => None,
                };
                events.push(self.end_with_error(StopReason::Aborted, message.unwrap_or_default()));
            }
            // A complete stream: the adapter's own check fails the request.
            _ => events.push(self.end_with_error(StopReason::Aborted, ABORTED.into())),
        }
        events
    }
}

/// Send, decode, end. `error_message` words a request error as the adapter does.
async fn run(
    decoder: &mut dyn Decoder,
    request: Result<HttpRequest, String>,
    retry: RetryOptions,
    signal: &AbortSignal,
    error_message: &(dyn Fn(&RequestError) -> String + Sync),
    emit: &mut (dyn FnMut(AssistantEvent, &AssistantMessage) + Send),
) {
    let request = match request {
        Ok(request) => request,
        Err(message) => {
            let event = decoder.end_with_error(StopReason::Error, message);
            return emit(event, decoder.output());
        }
    };
    let mut response = match post(&request, retry, signal).await {
        Ok(response) => response,
        Err(error) => {
            let event = if signal.is_aborted() || error == RequestError::Aborted {
                decoder.end_with_error(StopReason::Aborted, "Request aborted".into())
            } else {
                decoder.end_with_error(StopReason::Error, error_message(&error))
            };
            return emit(event, decoder.output());
        }
    };
    emit(AssistantEvent::Start, decoder.output());
    loop {
        if signal.is_aborted() {
            for event in decoder.abort(false) {
                emit(event, decoder.output());
            }
            return;
        }
        let events = match response.chunk(signal).await {
            Ok(Some(bytes)) => decoder.push(&bytes),
            Ok(None) => {
                for event in decoder.finish() {
                    emit(event, decoder.output());
                }
                return;
            }
            Err(RequestError::Aborted) => decoder.abort(true),
            Err(_) => vec![decoder.end_with_error(StopReason::Error, "terminated".into())],
        };
        let done = events.iter().any(|event| {
            matches!(
                event,
                AssistantEvent::Done { .. } | AssistantEvent::Error { .. }
            )
        });
        for event in events {
            emit(event, decoder.output());
        }
        if done {
            return;
        }
    }
}

/// The Anthropic Messages `stream()`.
pub async fn stream_anthropic(
    model: &Model,
    messages: &[Message],
    options: &AnthropicOptions,
    send: &SendOptions<'_>,
    emit: &mut (dyn FnMut(AssistantEvent, &AssistantMessage) + Send),
) {
    let SendOptions {
        request,
        retry,
        signal,
        clock,
    } = *send;
    let oauth = request
        .api_key
        .as_deref()
        .is_some_and(|key| anthropic::uses_oauth(model, key));
    let mut decoder =
        AnthropicStream::new(model, messages, oauth, options.effort.as_deref(), clock);
    let http = anthropic_request(model, messages, options, request);
    run(
        &mut decoder,
        http,
        retry,
        signal,
        &anthropic_error_message,
        emit,
    )
    .await;
}

/// The OpenAI Responses `stream()`.
pub async fn stream_openai_responses(
    model: &Model,
    messages: &[Message],
    options: &OpenAIResponsesOptions,
    send: &SendOptions<'_>,
    emit: &mut (dyn FnMut(AssistantEvent, &AssistantMessage) + Send),
) {
    let SendOptions {
        request,
        retry,
        signal,
        clock,
    } = *send;
    let mut decoder =
        match OpenAIResponsesStream::new(model, messages, options.service_tier.clone(), clock) {
            Ok(decoder) => decoder,
            Err(message) => return failed(model, clock, message, emit),
        };
    let http = openai_responses_request(model, messages, options, request);
    let wording = |error: &RequestError| openai_responses_error_message(model, error);
    run(&mut decoder, http, retry, signal, &wording, emit).await;
}

/// The OpenAI Chat Completions `stream()`.
pub async fn stream_openai_completions(
    model: &Model,
    messages: &[Message],
    options: &OpenAICompletionsOptions,
    send: &SendOptions<'_>,
    emit: &mut (dyn FnMut(AssistantEvent, &AssistantMessage) + Send),
) {
    let SendOptions {
        request,
        retry,
        signal,
        clock,
    } = *send;
    let mut decoder = match OpenAICompletionsStream::new(model, messages, clock) {
        Ok(decoder) => decoder,
        Err(message) => return failed(model, clock, message, emit),
    };
    let http = openai_completions_request(model, messages, options, request);
    run(
        &mut decoder,
        http,
        retry,
        signal,
        &openai_completions_error_message,
        emit,
    )
    .await;
}

/// The Google Gemini `stream()`.
pub async fn stream_google(
    model: &Model,
    messages: &[Message],
    options: &GoogleOptions,
    send: &SendOptions<'_>,
    emit: &mut (dyn FnMut(AssistantEvent, &AssistantMessage) + Send),
) {
    let SendOptions {
        request,
        retry,
        signal,
        clock,
    } = *send;
    let mut decoder = GoogleStream::new(model, clock);
    let http = google_request(model, messages, options, request);
    run(
        &mut decoder,
        http,
        retry,
        signal,
        &google_error_message,
        emit,
    )
    .await;
}

/// Ends a request that could not start with an error event, on an empty output for the model.
pub(crate) fn failed(
    model: &Model,
    clock: fn() -> u64,
    message: String,
    emit: &mut (dyn FnMut(AssistantEvent, &AssistantMessage) + Send),
) {
    let mut decoder = GoogleStream::new(model, clock);
    let event = decoder.end_with_error(StopReason::Error, message);
    emit(event, decoder.output());
}
