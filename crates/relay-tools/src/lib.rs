//! Relay's built-in tools in Rust, ported from `packages/coding-agent/src/core/tools`. The model
//! reads their outputs, so they match the TypeScript tools byte for byte.
//!
//! - `read`: a text file's lines, cut to 2000 lines or 50 KB with a notice on how to continue.
//!   Images are not supported yet.
//! - `ls`: a directory's entries in `localeCompare` order.
//! - `write`: creates or overwrites a file and its parent directories.
//! - `edit`: exact-text replacements with a fuzzy fallback (`edit_diff`), reported with jsdiff's
//!   line diff and unified patch (`diff`). Changes to one file wait for each other (`mutation`).
//! - `grep`, `find`: ripgrep and fd (`process` runs them, `tools_manager` finds them), their
//!   output relative to the searched directory.
//! - `truncate`: the line and byte limits the tools share (head, tail, middle, one line).
//! - `paths`: input paths resolved as the TypeScript tools resolve them.
//! - `mime`: the image types `read` attaches, by their first bytes.
//! - `js`: JavaScript's collation, `slice` indices and number formatting, and Node's error
//!   wording.
//!
//! `tests/tools.rs` replays `crates/fixtures/tools/`, what the TypeScript tools and helpers
//! returned (`packages/coding-agent/test/parity/tools-record.ts`, `npm run parity:record`).

pub mod diff;
pub mod edit;
pub mod edit_diff;
pub mod find;
pub mod grep;
pub mod js;
pub mod ls;
pub mod mime;
pub mod mutation;
pub mod paths;
pub mod process;
pub mod read;
pub mod tools_manager;
pub mod truncate;
pub mod write;

pub use edit::EditTool;
pub use find::FindTool;
pub use grep::GrepTool;
pub use ls::LsTool;
pub use read::ReadTool;
pub use write::WriteTool;
