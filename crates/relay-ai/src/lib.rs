//! Relay's model layer in Rust, ported from `packages/ai`.
//!
//! This first part holds the transcript types (`message`): what a provider receives and what a
//! session file stores. The provider adapters, the model catalog and the credentials follow in the
//! next phase of the port. `tests/scenarios.rs` reads the messages the TypeScript agent recorded in
//! `crates/fixtures/scenarios/` and checks that these types read and write them unchanged.

pub mod message;

pub use message::*;
