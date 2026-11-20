//! Relay's model layer in Rust, ported from `packages/ai`.
//!
//! - `message`: the transcript types, what a provider receives and a session file stores.
//! - `model`: a catalog chat model.
//! - `catalog`: the built-in models, from the provider files the TypeScript catalog loads.
//! - `oauth`, `resolve`: each OAuth provider's token refresh and request auth, and resolving a
//!   provider's auth from the request, `auth.json` and the environment.
//! - `auth`, `auth_file`, `config_value`: credentials, each built-in provider's API-key
//!   resolution, the `auth.json` store the TypeScript agent shares, and the `$VAR` and `!command`
//!   values stored keys may be.
//! - `transcript`, `transform`, `strict`, `text`: the shared steps every adapter applies.
//! - `anthropic`, `anthropic_stream`: the Anthropic Messages request body, and reading its
//!   response stream into `event::AssistantEvent`s.
//! - `openai_completions`, `openai_completions_stream`: the OpenAI Chat Completions request body,
//!   for OpenAI and the servers that speak its API, and reading its stream.
//! - `openai_responses`, `openai_responses_stream`: the OpenAI Responses request body, and
//!   reading its stream as the OpenAI SDK parses it.
//! - `google`, `google_stream`: the Google Gemini request (the SDK parameters, the URL and the
//!   HTTP body), and reading its stream.
//! - `options`: request options adapters share.
//! - `abort`, `retry`, `http`: cancellation, the SDKs' retry policy, and sending requests.
//! - `provider_request`: each adapter's URL, headers and wire body, and its HTTP error messages.
//! - `stream`: each adapter's `stream()`, sending the request and decoding the response; each
//!   event comes with the message decoded so far.
//! - `simple`: the provider-neutral options (`streamSimple`) mapped to each adapter's, the context
//!   estimate that limits the output, and `stream_simple`, which sends through the adapter for the
//!   model's API.
//! - `validation`: tool arguments checked against their JSON Schema as TypeBox checks them.
//! - `json`, `sse`: provider output helpers (JSON repair and partial parsing, server-sent events).
//!
//! The tests compare against what the TypeScript code does, recorded in `crates/fixtures/`
//! (`npm run parity:record`): `tests/scenarios.rs` reads the agent's messages back unchanged,
//! `tests/anthropic.rs`, `tests/openai_responses.rs`, `tests/openai_completions.rs` and
//! `tests/google.rs` build the same requests, `tests/simple.rs` the same requests from the
//! provider-neutral options, `tests/*_stream.rs` decode the same streams into the same events,
//! and `tests/json.rs` parses as the TypeScript helpers do.

pub mod abort;
pub mod anthropic;
pub mod anthropic_stream;
pub mod auth;
pub mod auth_file;
pub mod catalog;
pub mod config_value;
pub mod event;
pub mod google;
pub mod google_stream;
pub mod http;
pub mod json;
pub mod message;
pub mod model;
pub mod oauth;
pub mod openai_completions;
pub mod openai_completions_stream;
pub mod openai_responses;
pub mod openai_responses_stream;
mod openai_sdk;
pub mod options;
pub mod provider_request;
pub mod resolve;
pub mod retry;
pub mod simple;
pub mod sse;
pub mod stream;
pub mod strict;
pub mod text;
pub mod transcript;
pub mod transform;
pub mod validation;

pub use message::*;
pub use model::{
    calculate_cost, CostTier, FallbackModel, ImageInputLimits, ImageResize, InputLimits, Model,
    ModelCompat, ModelCost,
};
