//! Relay's model layer in Rust, ported from `packages/ai`.
//!
//! - `message`: the transcript types, what a provider receives and a session file stores.
//! - `model`: the catalog fields request building reads.
//! - `transcript`, `transform`, `strict`, `text`: the shared steps every adapter applies.
//! - `anthropic`: the Anthropic Messages request body.
//!
//! The tests compare against what the TypeScript code does, recorded in `crates/fixtures/`
//! (`npm run parity:record`): `tests/scenarios.rs` reads the agent's messages back unchanged, and
//! `tests/anthropic.rs` builds the same Anthropic bodies byte for byte.

pub mod anthropic;
pub mod message;
pub mod model;
pub mod strict;
pub mod text;
pub mod transcript;
pub mod transform;

pub use message::*;
pub use model::{FallbackModel, Model, ModelCompat};
