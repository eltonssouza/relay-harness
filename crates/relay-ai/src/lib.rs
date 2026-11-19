//! Relay's model layer in Rust, ported from `packages/ai`.
//!
//! - `message`: the transcript types, what a provider receives and a session file stores.
//! - `model`: the catalog fields request building reads.
//! - `transcript`, `transform`, `strict`, `text`: the shared steps every adapter applies.
//! - `anthropic`, `anthropic_stream`: the Anthropic Messages request body, and reading its
//!   response stream into `event::AssistantEvent`s.
//! - `openai_completions`, `openai_completions_stream`: the OpenAI Chat Completions request body,
//!   for OpenAI and the servers that speak its API, and reading its stream.
//! - `openai_responses`, `openai_responses_stream`: the OpenAI Responses request body, and
//!   reading its stream as the OpenAI SDK parses it.
//! - `options`: request options adapters share.
//! - `json`, `sse`: provider output helpers (JSON repair and partial parsing, server-sent events).
//!
//! The tests compare against what the TypeScript code does, recorded in `crates/fixtures/`
//! (`npm run parity:record`): `tests/scenarios.rs` reads the agent's messages back unchanged,
//! `tests/anthropic.rs`, `tests/openai_responses.rs` and `tests/openai_completions.rs` build the
//! same bodies byte for byte,
//! `tests/anthropic_stream.rs`, `tests/openai_responses_stream.rs` and
//! `tests/openai_completions_stream.rs` decode the same streams into the same events, and `tests/json.rs` parses as the TypeScript helpers do.

pub mod anthropic;
pub mod anthropic_stream;
pub mod event;
pub mod json;
pub mod message;
pub mod model;
pub mod openai_completions;
pub mod openai_completions_stream;
pub mod openai_responses;
pub mod openai_responses_stream;
mod openai_sdk;
pub mod options;
pub mod sse;
pub mod strict;
pub mod text;
pub mod transcript;
pub mod transform;

pub use message::*;
pub use model::{calculate_cost, CostTier, FallbackModel, Model, ModelCompat, ModelCost};
