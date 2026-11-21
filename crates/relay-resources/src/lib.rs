//! Relay's resources in Rust, ported from `packages/coding-agent/src/core`:
//!
//! - `skills`: a skill as the resource loader reads it, and the listing the system prompt shows
//!   (`formatSkillsForPrompt`).
//! - `system_prompt`: the system prompt's sections (`system-prompt.ts`), the text they make, and
//!   the patch that brings the model's sections up to date.
//!
//! `tests/system_prompt.rs` replays `crates/fixtures/resources/`, what the TypeScript code did
//! (`packages/coding-agent/test/parity/resources-record.ts`, `npm run parity:record`).

pub mod skills;
pub mod system_prompt;

pub use skills::{format_skills_for_prompt, Skill, SkillReadTool, SourceInfo};
pub use system_prompt::{
    build_system_prompt, build_system_prompt_sections, build_system_prompt_state,
    diff_system_prompt_sections, ContextFile, DocsPaths, SystemPromptOptions, SystemPromptState,
};
