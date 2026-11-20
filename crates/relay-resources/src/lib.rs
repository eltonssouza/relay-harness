//! Relay's resources in Rust, ported from `packages/coding-agent/src/core`:
//!
//! - `skills`: a skill as the resource loader reads it, and the listing the system prompt shows
//!   (`formatSkillsForPrompt`).
//! - `context`: the context files (`AGENTS.md`, `CLAUDE.md`) from the agent directory and the
//!   working directory up, the project guide's path, and the system prompt and appended prompt
//!   files; `find_git_paths` finds a folder's repository.
//! - `system_prompt`: the system prompt's sections (`system-prompt.ts`), the text they make, and
//!   the patch that brings the model's sections up to date.
//!
//! `tests/system_prompt.rs` and `tests/context.rs` replay `crates/fixtures/resources/`, what the TypeScript code did
//! (`packages/coding-agent/test/parity/resources-record.ts`, `npm run parity:record`).

pub mod context;
pub mod skills;
pub mod system_prompt;

pub use context::{
    find_git_paths, load_project_context_files, load_prompt_files, project_agents_path,
    ContextFiles, GitPaths, PromptFileOptions, PromptFiles,
};
pub use skills::{format_skills_for_prompt, Skill, SkillReadTool, SourceInfo};
pub use system_prompt::{
    build_system_prompt, build_system_prompt_sections, build_system_prompt_state,
    diff_system_prompt_sections, ContextFile, DocsPaths, SystemPromptOptions, SystemPromptState,
};
