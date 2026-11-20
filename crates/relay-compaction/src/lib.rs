//! Relay's compaction in Rust, ported from `packages/coding-agent/src/core/compaction/`: when a
//! session's context nears the window, older messages become a summary and the recent ones stay.
//!
//! - `estimate`: context size from the last reported usage plus characters / 4 after it.
//! - `cut`: where to cut (`findCutPoint`) and what to summarize and keep (`prepareCompaction`).
//! - `utils`: the messages as model messages and as text, and the files tool calls touched.
//! - `summarize`: the summary requests through the agent's stream function (`compact`).
//! - `branch`: the summary of a branch the session leaves (`branch-summarization.ts`).
//!
//! `tests/compaction.rs` replays `crates/fixtures/compaction/`, what the TypeScript code did
//! (`packages/coding-agent/test/parity/compaction-record.ts`, `npm run parity:record`).

pub mod branch;
pub mod cut;
pub mod estimate;
pub mod summarize;
pub mod utils;

pub use cut::{
    prepare_compaction, CompactionPreparation, CompactionSettings, DEFAULT_COMPACTION_SETTINGS,
};
pub use summarize::{CompactionResult, Summarizer};
