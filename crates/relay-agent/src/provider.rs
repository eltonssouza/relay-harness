//! The stream function over the provider adapters (`streamSimple` in `packages/ai`): each request
//! goes to the adapter for the model's API, and its events reach the loop as they are decoded.
//!
//! The adapters push their events; the loop pulls them. The request runs while the loop reads,
//! and events decoded while the loop waits on its listeners queue up, as the TypeScript event
//! stream queues them.

use futures_channel::mpsc;
use futures_util::future::{ready, FutureExt};
use futures_util::stream::{self, BoxStream, StreamExt};
use relay_ai::event::AssistantEvent;
use relay_ai::simple::{request_options, stream_simple};
use relay_ai::stream::SendOptions;
use relay_ai::{AssistantMessage, Message, Model};

use crate::types::{now, StreamEvent, StreamFn, StreamRequest};

/// Answers each request through the adapter for the model's API: Anthropic Messages, OpenAI
/// Responses, OpenAI Chat Completions or Google Gemini. The key is the request's (the
/// `get_api_key` hook's or the config's); finding it in `auth.json` or the environment is the
/// caller's, as coding-agent's model runtime does before the adapter runs.
#[derive(Debug, Clone, Copy)]
pub struct ProviderStream {
    /// Unix milliseconds, for the times of the decoded messages.
    pub clock: fn() -> u64,
}

impl Default for ProviderStream {
    fn default() -> Self {
        ProviderStream { clock: now }
    }
}

impl StreamFn for ProviderStream {
    fn stream<'a>(
        &'a self,
        model: &'a Model,
        messages: &'a [Message],
        request: &'a StreamRequest,
    ) -> BoxStream<'a, StreamEvent> {
        let (sender, received) = mpsc::unbounded();
        let clock = self.clock;
        let produce = async move {
            let http = request_options(request.api_key.clone(), &request.options);
            let send = SendOptions {
                request: &http,
                retry: request.retry,
                signal: &request.signal,
                clock,
            };
            let mut emit = |event: AssistantEvent, partial: &AssistantMessage| {
                // Fails only once the loop stopped reading.
                let _ = sender.unbounded_send(StreamEvent {
                    event,
                    partial: partial.clone(),
                });
            };
            stream_simple(model, messages, &request.options, &send, &mut emit).await;
        };
        // The request yields no events of its own; the channel ends once it is done.
        let running = produce
            .into_stream()
            .filter_map(|()| ready(None::<StreamEvent>));
        stream::select(running, received).boxed()
    }
}
