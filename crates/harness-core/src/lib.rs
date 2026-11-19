//! The model-independent harness core of Relay, in Rust.
//!
//! This crate is a port of `packages/agent/src/harness` (TypeScript). The labelled cases in
//! `packages/coding-agent/test/harness-bench/corpus.json` are the specification both
//! implementations are measured against; `tests/corpus.rs` runs them here.
//!
//! - [`shell`]: a small shell lexer for classification, not a shell.
//! - [`effects`]: what a tool call does to the world (read, write, execute, verify, destructive,
//!   external), the risky operations a command line performs, and the paths its deletions name.

pub mod effects;
pub mod shell;
