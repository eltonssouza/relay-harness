//! The model-independent harness core of Relay, in Rust.
//!
//! This crate is a port of `packages/agent/src/harness` (TypeScript). The labelled cases in
//! `packages/coding-agent/test/harness-bench/corpus.json` are the specification both
//! implementations are measured against; `tests/corpus.rs` runs them here.
//!
//! - [`shell`]: a small shell lexer for classification, not a shell.
//! - [`effects`]: what a tool call does to the world (read, write, execute, verify, destructive,
//!   external), the risky operations a command line performs, and the paths its deletions name.
//! - [`alignment`]: constraints, intent, corrections, authorization and the question-turn guard.
//! - [`evidence`]: the evidence ledger and the completion report.
//! - [`text`]: the lexicon helpers, on `fancy-regex` for JavaScript-compatible lookaround.
//!
//! `tests/golden.rs` and `tests/pillars.rs` compare every result with the TypeScript harness.

pub mod alignment;
pub mod context;
pub mod effects;
pub mod engine;
pub mod evidence;
pub mod shell;
pub mod slices;
pub mod text;
