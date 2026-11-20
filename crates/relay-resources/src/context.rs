//! The files the resource loader reads into the prompt (`resource-loader.ts`): context files such
//! as `AGENTS.md` from the agent directory and every folder from the working directory up, the
//! project guide's path, and the system prompt and appended prompt (`SYSTEM.md`,
//! `APPEND_SYSTEM.md`, or the sources given). Also `findGitPaths` (`footer-data-provider.ts`),
//! which finds the repository a folder is in.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use relay_ai::text::js_trim;
use relay_settings::trust::canonicalize_path;
use relay_tools::paths;

use crate::system_prompt::ContextFile;

const CONFIG_DIR_NAME: &str = ".relay";
/// The names a folder's context file may have, the first found winning.
const CONTEXT_FILE_NAMES: [&str; 5] = [
    "AGENTS.override.md",
    "AGENTS.md",
    "AGENTS.MD",
    "CLAUDE.md",
    "CLAUDE.MD",
];

fn windows() -> bool {
    cfg!(windows)
}

fn separator() -> &'static str {
    if windows() {
        "\\"
    } else {
        "/"
    }
}

fn join(dir: &str, name: &str) -> String {
    paths::node_join(dir, name, windows())
}

fn dirname(path: &str) -> String {
    paths::dirname(path, windows())
}

fn exists(path: &str) -> bool {
    !path.is_empty() && Path::new(path).exists()
}

/// `resolvePath(path)` from the process's working directory.
fn resolve(path: &str) -> String {
    let home = paths::home_dir();
    let process = std::env::current_dir()
        .map(|cwd| cwd.to_string_lossy().into_owned())
        .unwrap_or_default();
    paths::resolve_path(
        path,
        &process,
        &paths::PathInput {
            home: home.as_deref(),
            windows: windows(),
            ..paths::PathInput::default()
        },
    )
}

/// `readFileSync(path, "utf8")`: invalid UTF-8 becomes replacement characters.
fn read_text(path: &str) -> std::io::Result<String> {
    fs::read(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn strip_bom(text: String) -> String {
    match text.strip_prefix('\u{FEFF}') {
        Some(rest) => rest.to_string(),
        None => text,
    }
}

/// Where a folder's repository keeps its metadata (`GitPaths`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitPaths {
    /// The folder holding `.git`: the repository's or the linked worktree's root.
    pub repo_dir: String,
    /// The git directory shared by all of the repository's worktrees.
    pub common_git_dir: String,
    pub head_path: String,
}

/// The repository `cwd` is in, walking up (`findGitPaths`): a `.git` folder, or a `.git` file
/// pointing at a worktree's git directory with `gitdir: `. `None` when the nearest one has no
/// `HEAD`, or none is found.
pub fn find_git_paths(cwd: &str) -> Option<GitPaths> {
    let mut dir = cwd.to_string();
    loop {
        let git_path = join(&dir, ".git");
        if exists(&git_path) {
            let metadata = fs::metadata(&git_path).ok()?;
            if metadata.is_file() {
                let content = read_text(&git_path).ok()?;
                if let Some(target) = js_trim(&content).strip_prefix("gitdir: ") {
                    let git_dir = paths::node_resolve(&[&dir, js_trim(target)], windows());
                    let head_path = join(&git_dir, "HEAD");
                    if !exists(&head_path) {
                        return None;
                    }
                    let common_dir_path = join(&git_dir, "commondir");
                    let common_git_dir = if exists(&common_dir_path) {
                        let common = read_text(&common_dir_path).ok()?;
                        paths::node_resolve(&[&git_dir, js_trim(&common)], windows())
                    } else {
                        git_dir
                    };
                    return Some(GitPaths {
                        repo_dir: dir,
                        common_git_dir,
                        head_path,
                    });
                }
            } else if metadata.is_dir() {
                let head_path = join(&git_path, "HEAD");
                if !exists(&head_path) {
                    return None;
                }
                return Some(GitPaths {
                    repo_dir: dir,
                    common_git_dir: git_path,
                    head_path,
                });
            }
        }
        let parent = dirname(&dir);
        if parent == dir {
            return None;
        }
        dir = parent;
    }
}

/// The first context file in `dir` that is a readable file (`loadContextFileFromDir`); the others
/// that could not be read are reported in `warnings`.
fn load_context_file_from_dir(dir: &str, warnings: &mut Vec<String>) -> Option<ContextFile> {
    for name in CONTEXT_FILE_NAMES {
        let path = join(dir, name);
        if !exists(&path) {
            continue;
        }
        let result = fs::metadata(&path).and_then(|metadata| {
            if metadata.is_file() {
                read_text(&path).map(Some)
            } else {
                Ok(None)
            }
        });
        match result {
            Ok(Some(content)) => {
                return Some(ContextFile {
                    path,
                    content: strip_bom(content),
                })
            }
            Ok(None) => {}
            Err(error) => warnings.push(format!(
                "Could not read {path}: Error: {}",
                relay_tools::js::fs_error(&error, "open", &path)
            )),
        }
    }
    None
}

/// The main repository's context file that a nested linked worktree's own one replaces
/// (`findShadowedContextFile`): both cover the same repository, so loading both would apply that
/// context twice. Canonical, as git writes the worktree's `gitdir:` target.
fn find_shadowed_context_file(cwd: &str, warnings: &mut Vec<String>) -> Option<String> {
    let git_paths = find_git_paths(cwd)?;
    let common_git_dir = canonicalize_path(&git_paths.common_git_dir);
    let worktree_root = canonicalize_path(&git_paths.repo_dir);
    let main_repo_root = dirname(&common_git_dir);
    // Not for an ordinary repository, where both are the same folder, nor for a worktree outside
    // the main one.
    if !worktree_root.starts_with(&format!("{main_repo_root}{}", separator())) {
        return None;
    }
    // Not for a bare layout or a submodule, whose git directory's folder tracks nothing.
    if canonicalize_path(&join(&main_repo_root, ".git")) != common_git_dir {
        return None;
    }
    let own = load_context_file_from_dir(&worktree_root, warnings)?;
    Some(join(
        &main_repo_root,
        &paths::basename(&own.path, windows()),
    ))
}

/// The context files for `cwd` and what could not be read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContextFiles {
    /// The agent directory's, then each folder's from the outermost down to `cwd`.
    pub files: Vec<ContextFile>,
    pub warnings: Vec<String>,
}

/// The context files for `cwd` (`loadProjectContextFiles`): the agent directory's, then one per
/// folder from the root down to `cwd`, each path once, without the main repository's file when a
/// nested worktree has its own.
pub fn load_project_context_files(cwd: &str, agent_dir: &str) -> ContextFiles {
    let cwd = resolve(cwd);
    let agent_dir = resolve(agent_dir);
    let mut warnings = Vec::new();
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    if let Some(global) = load_context_file_from_dir(&agent_dir, &mut warnings) {
        seen.insert(global.path.clone());
        files.push(global);
    }
    let shadowed = find_shadowed_context_file(&cwd, &mut warnings);
    let mut ancestors = Vec::new();
    let mut current = cwd;
    loop {
        if let Some(file) = load_context_file_from_dir(&current, &mut warnings) {
            let is_shadowed = shadowed
                .as_deref()
                .is_some_and(|shadowed| canonicalize_path(&file.path) == shadowed);
            if !is_shadowed && seen.insert(file.path.clone()) {
                ancestors.push(file);
            }
        }
        let parent = dirname(&current);
        if parent == current {
            break;
        }
        current = parent;
    }
    ancestors.reverse();
    files.extend(ancestors);
    ContextFiles { files, warnings }
}

/// The project guide the prompt asks the model to keep: `AGENTS.md` at the repository's root, or
/// in `cwd` outside a repository.
pub fn project_agents_path(cwd: &str) -> String {
    let cwd = resolve(cwd);
    let root = find_git_paths(&cwd).map_or(cwd, |paths| paths.repo_dir);
    join(&root, "AGENTS.md")
}

/// How the system prompt files are found (`DefaultResourceLoader`'s options).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PromptFileOptions {
    pub cwd: String,
    pub agent_dir: String,
    /// A trusted project's `.relay` files come before the agent directory's.
    pub project_trusted: bool,
    /// Text or a file to read; `None` looks for `SYSTEM.md`, and an empty one sets no prompt.
    pub system_prompt: Option<String>,
    /// Texts or files to read; `None` looks for `APPEND_SYSTEM.md`.
    pub append_system_prompt: Option<Vec<String>>,
}

/// The system prompt and the text appended to it, with the files they came from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PromptFiles {
    pub system_prompt: Option<String>,
    pub system_prompt_source: Option<String>,
    pub append_system_prompt: Vec<String>,
    pub append_system_prompt_sources: Vec<String>,
    pub warnings: Vec<String>,
}

/// A trusted project's `.relay/<name>`, else the agent directory's `<name>`.
fn discover_prompt_file(
    options: &PromptFileOptions,
    cwd: &str,
    agent_dir: &str,
    name: &str,
) -> Option<String> {
    let project = join(&join(cwd, CONFIG_DIR_NAME), name);
    if options.project_trusted && exists(&project) {
        return Some(project);
    }
    let global = join(agent_dir, name);
    exists(&global).then_some(global)
}

/// The text of a source: an existing file's contents without a byte order mark, else the source
/// itself; an empty source is none (`resolvePromptInput`).
fn resolve_prompt_input(
    input: &str,
    description: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    if input.is_empty() {
        return None;
    }
    if exists(input) {
        return match read_text(input) {
            Ok(text) => Some(strip_bom(text)),
            Err(error) => {
                warnings.push(format!(
                    "Could not read {description} file {input}: Error: {}",
                    relay_tools::js::fs_error(&error, "read", input)
                ));
                Some(input.to_string())
            }
        };
    }
    Some(input.to_string())
}

/// The system prompt and appended prompt, as `DefaultResourceLoader.reload` reads them.
pub fn load_prompt_files(options: &PromptFileOptions) -> PromptFiles {
    let cwd = resolve(&options.cwd);
    let agent_dir = resolve(&options.agent_dir);
    let mut warnings = Vec::new();

    let system_source = options
        .system_prompt
        .clone()
        .or_else(|| discover_prompt_file(options, &cwd, &agent_dir, "SYSTEM.md"));
    let system_prompt = system_source
        .as_deref()
        .and_then(|source| resolve_prompt_input(source, "system prompt", &mut warnings));
    let system_prompt_source = system_source
        .as_deref()
        .filter(|source| exists(source))
        .map(resolve);

    let append_sources = options.append_system_prompt.clone().unwrap_or_else(|| {
        discover_prompt_file(options, &cwd, &agent_dir, "APPEND_SYSTEM.md")
            .into_iter()
            .collect()
    });
    let append_system_prompt = append_sources
        .iter()
        .filter_map(|source| resolve_prompt_input(source, "append system prompt", &mut warnings))
        .collect();
    let append_system_prompt_sources = append_sources
        .iter()
        .filter(|source| exists(source))
        .map(|source| resolve(source))
        .collect();

    PromptFiles {
        system_prompt,
        system_prompt_source,
        append_system_prompt,
        append_system_prompt_sources,
        warnings,
    }
}
