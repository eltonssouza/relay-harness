//! Relay's agent loop in Rust, ported from `packages/agent`.
//!
//! - `agent_loop`: `run_agent_loop` and `run_agent_loop_continue`. A run asks the model, runs the
//!   tool calls it makes (in parallel unless a tool or the config says otherwise), appends the
//!   results and asks again. Between turns it takes steered messages; when it would stop,
//!   follow-ups. Before each request, tools the transcript does not declare are announced.
//! - `types`: the messages, events, tool results, the `AgentTool`, `AgentHooks`, `EventSink` and
//!   `StreamFn` traits, and the config. The loop awaits each event and pulls each provider event,
//!   as the TypeScript loop awaits its listeners and its event stream.
//! - `provider`: `ProviderStream`, the stream function over the provider adapters
//!   (`relay_ai::simple::stream_simple`), chosen by the model's API.
//!
//! `tests/loop_parity.rs` replays `crates/fixtures/loop/`: what the TypeScript loop emitted,
//! sent, asked its hooks and ran in each case of `packages/agent/test/parity/loop-record.ts`
//! (`npm run parity:record`). `tests/sink.rs` checks that a listener is awaited and that tool
//! updates reach it while the tool runs. `tests/provider.rs` answers through each
//! adapter with the responses recorded in `crates/fixtures/*-stream/`, from a local server.

pub mod agent_loop;
pub mod provider;
pub mod types;

pub use agent_loop::{run_agent_loop, run_agent_loop_continue, LoopRuntime};
pub use provider::ProviderStream;
pub use types::*;
