//! Relay's sessions in Rust, ported from `packages/coding-agent/src/core/session-manager.ts`:
//! the JSONL files both agents read and write.
//!
//! - `entries`: reading a file (malformed lines skipped, a missing final newline added),
//!   migrating versions 1 and 2, and projecting the path to a leaf into model context with
//!   compactions, branch summaries, custom messages and context edits.
//! - `manager`: `SessionManager`, the append-only tree with its leaf, labels, branches and the
//!   rule that a file is written only once the session holds a conversation.
//! - `list`: listings of a directory or of every project.
//! - `date`, `ids`: JavaScript dates, and UUIDv7 and short entry ids. Lines are written with
//!   `relay_ai::json::stringify`, `JSON.stringify`'s number formatting.
//!
//! `tests/session.rs` replays `crates/fixtures/session/`, what the TypeScript manager did
//! (`packages/coding-agent/test/parity/session-record.ts`, `npm run parity:record`).

pub mod date;
pub mod entries;
pub mod ids;
pub mod list;
pub mod manager;
pub mod paths;

pub use list::SessionInfo;
pub use manager::{NewSessionOptions, SessionContext, SessionManager, TreeNode};
