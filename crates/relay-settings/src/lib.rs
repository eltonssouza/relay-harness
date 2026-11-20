//! Relay's settings in Rust, ported from `packages/coding-agent/src/core/settings-manager.ts`: the
//! global `settings.json` in the agent directory and a trusted project's `.relay/settings.json`,
//! read and written as the TypeScript agent does, so both agents share them.
//!
//! - `merge`: layers merged key by key, `defaultTools` modifiers, and old settings migrated.
//! - `storage`: the files under `proper-lockfile`'s lock, or memory.
//! - `manager`: `SettingsManager`, its getters' defaults and its setters' field-by-field writes.
//!
//! `tests/settings.rs` replays `crates/fixtures/settings/`, what the TypeScript manager did
//! (`packages/coding-agent/test/parity/settings-record.ts`, `npm run parity:record`).

pub mod manager;
pub mod merge;
pub mod storage;

pub use manager::{SettingsError, SettingsManager};
pub use merge::Settings;
pub use storage::{SettingsScope, SettingsStorage};
