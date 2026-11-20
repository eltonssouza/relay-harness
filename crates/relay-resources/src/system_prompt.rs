//! The system prompt (`system-prompt.ts`): ordered sections, each but the preamble wrapped in a tag
//! of its name, so a later system message can replace one section by name.

use std::collections::HashMap;

use relay_ai::message::{Content, Sections, SystemMessage};
use relay_ai::text::js_trim;
use relay_ai::transcript::system_message_text;

use crate::skills::{format_skills_for_prompt, Skill, SkillReadTool};

/// The package's documentation, which the default prompt points the model to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocsPaths {
    pub readme: String,
    pub docs: String,
    pub examples: String,
}

/// A loaded context file such as `AGENTS.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextFile {
    pub path: String,
    pub content: String,
}

/// What the prompt is built from (`BuildSystemPromptOptions`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SystemPromptOptions {
    /// Replaces the default preamble, tools, rules and documentation; empty keeps them.
    pub custom_prompt: Option<String>,
    /// The whole prompt, set by a `before_agent_start` handler; it has no sections.
    pub force_system_prompt: Option<String>,
    /// The active tools; `None` is `read`, `bash`, `edit` and `write`.
    pub selected_tools: Option<Vec<String>>,
    /// One line per tool; a tool without one is not listed.
    pub tool_snippets: HashMap<String, String>,
    /// Rules each tool adds while it is selected.
    pub tool_guidelines: HashMap<String, Vec<String>>,
    pub prompt_guidelines: Vec<String>,
    /// The user's appended instructions; empty adds no section.
    pub append_system_prompt: String,
    /// Extra sections in order; an empty one is left out, and a built-in name replaces that
    /// section where it stands.
    pub sections: Vec<(String, String)>,
    pub cwd: String,
    pub context_files: Vec<ContextFile>,
    /// The project's `AGENTS.md` to create and keep during development tasks.
    pub project_agents_path: Option<String>,
    pub skills: Vec<Skill>,
    pub docs: DocsPaths,
}

/// The prompt as a system message holds it: a forced prompt in `content` with no sections, else
/// the sections with empty `content` (`buildSystemPromptState`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemPromptState {
    pub content: String,
    pub sections: Option<Vec<(String, String)>>,
}

/// `^[a-z][a-z0-9_-]*$`.
fn valid_section_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_lowercase())
        && characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '-')
        })
}

/// Sets a section, in place when it is already there.
fn set_section(sections: &mut Vec<(String, String)>, name: &str, content: String) {
    match sections.iter_mut().find(|(existing, _)| existing == name) {
        Some((_, text)) => *text = content,
        None => sections.push((name.to_string(), content)),
    }
}

fn render_project_context(files: &[ContextFile]) -> String {
    let mut parts = vec!["Project-specific instructions and guidelines:".to_string()];
    parts.extend(files.iter().map(|file| {
        format!(
            "<project_instructions path=\"{}\">\n{}\n</project_instructions>",
            file.path, file.content
        )
    }));
    parts.join("\n\n")
}

fn build_rules(
    selected: &[String],
    tool_guidelines: &HashMap<String, Vec<String>>,
    prompt_guidelines: &[String],
) -> String {
    let mut rules: Vec<String> = Vec::new();
    let mut add_rule = |rule: &str| {
        let normalized = js_trim(rule);
        if !normalized.is_empty() && !rules.iter().any(|existing| existing == normalized) {
            rules.push(normalized.to_string());
        }
    };
    let has = |name: &str| selected.iter().any(|tool| tool == name);
    let (bash, powershell) = (has("bash"), has("powershell"));
    if (bash || powershell) && !has("grep") && !has("find") && !has("ls") {
        add_rule(if bash && powershell {
            "Use bash or PowerShell for file operations like listing, searching, and finding files"
        } else if powershell {
            "Use PowerShell for file operations like listing, searching, and finding files"
        } else {
            "Use bash for file operations like ls, rg, find"
        });
    }
    for name in selected {
        for rule in tool_guidelines.get(name).into_iter().flatten() {
            add_rule(rule);
        }
    }
    for rule in prompt_guidelines {
        add_rule(rule);
    }
    add_rule("Be concise in your responses");
    add_rule("Show file paths clearly when working with files");
    rules
        .iter()
        .map(|rule| format!("- {rule}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The prompt's sections in order, each but `preamble` wrapped in `<name>` tags
/// (`buildSystemPromptSections`); an extra section with a name outside `^[a-z][a-z0-9_-]*$`, or
/// named `preamble`, is an error.
pub fn build_system_prompt_sections(
    options: &SystemPromptOptions,
) -> Result<Vec<(String, String)>, String> {
    for (name, _) in &options.sections {
        if !valid_section_name(name) || name == "preamble" {
            return Err(format!("Invalid system prompt section name: {name}"));
        }
    }
    let default_tools: Vec<String> = ["read", "bash", "edit", "write"].map(String::from).to_vec();
    let selected = options.selected_tools.as_ref().unwrap_or(&default_tools);

    let mut sections: Vec<(String, String)> = Vec::new();
    match options
        .custom_prompt
        .as_deref()
        .filter(|prompt| !prompt.is_empty())
    {
        Some(prompt) => set_section(&mut sections, "preamble", prompt.to_string()),
        None => {
            set_section(
                &mut sections,
                "preamble",
                "You are an expert coding assistant operating inside relay, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.".into(),
            );
            let listed: Vec<String> = selected
                .iter()
                .filter_map(|name| {
                    let snippet = options
                        .tool_snippets
                        .get(name)
                        .filter(|snippet| !snippet.is_empty())?;
                    Some(format!("- {name}: {snippet}"))
                })
                .collect();
            let tools = if listed.is_empty() {
                "(none)".to_string()
            } else {
                listed.join("\n")
            };
            set_section(
                &mut sections,
                "tools",
                format!("{tools}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project."),
            );
            set_section(
                &mut sections,
                "rules",
                build_rules(
                    selected,
                    &options.tool_guidelines,
                    &options.prompt_guidelines,
                ),
            );
            let DocsPaths {
                readme,
                docs,
                examples,
            } = &options.docs;
            set_section(
                &mut sections,
                "docs",
                format!(
                    "Relay documentation (read only when the user asks about relay itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: {readme}
- Additional docs: {docs}
- Examples: {examples} (extensions, custom tools, SDK)
- When reading relay docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), relay packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)
- When working on relay topics, read the docs and examples, and follow .md cross-references before implementing
- Always read relay .md files completely and follow links to related docs (e.g., tui.md for TUI API details)"
                ),
            );
        }
    }

    if !options.append_system_prompt.is_empty() {
        set_section(
            &mut sections,
            "addendum",
            options.append_system_prompt.clone(),
        );
    }
    if !options.context_files.is_empty() {
        set_section(
            &mut sections,
            "project_context",
            render_project_context(&options.context_files),
        );
    }
    if let Some(path) = options
        .project_agents_path
        .as_deref()
        .filter(|path| !path.is_empty())
    {
        set_section(
            &mut sections,
            "project_documentation",
            format!(
                "Project development guide: {}
- When the user starts a development task that changes project code, ensure this AGENTS.md exists before changing the implementation. Do not create it for questions, read-only reviews, or unrelated tasks.
- If it is missing, inspect the project's README, dependency manifests, source layout, tests, CI configuration, and existing instruction files, then use the available tools to create a project-specific AGENTS.md. Follow the user's constraints and all applicable existing instructions. If writing is unavailable or forbidden, explain the limitation and continue within the allowed scope.
- Document verified architecture, technology stack, setup and validation commands, environment variable names and purposes (never secret values), directory layout, services, jobs, data models, design patterns, workflows and schedules where defined, known hurdles with confirmed solutions, and a post-implementation checklist. Omit sections that do not apply; do not invent facts or pad to a fixed length.
- Read and follow an existing guide; never replace it with a generic template. Preserve CLAUDE.md and AGENTS.override.md instructions when creating AGENTS.md.
- Keep the guide current as development reveals confirmed hurdles, solutions, or conventions useful in future sessions. Record durable project knowledge, not transient task logs. Relay reloads context files before subsequent model calls.",
                path.replace('\\', "/")
            ),
        );
    }
    let read_tool = if selected.iter().any(|tool| tool == "read") {
        Some(SkillReadTool::Read)
    } else if selected.iter().any(|tool| tool == "bash") {
        Some(SkillReadTool::Bash)
    } else {
        None
    };
    if let Some(tool) = read_tool.filter(|_| !options.skills.is_empty()) {
        let listing = format_skills_for_prompt(&options.skills, tool);
        let listing = js_trim(&listing);
        if !listing.is_empty() {
            set_section(&mut sections, "skills", listing.to_string());
        }
    }
    set_section(&mut sections, "cwd", options.cwd.replace('\\', "/"));
    for (name, content) in &options.sections {
        if !content.is_empty() {
            set_section(&mut sections, name, content.clone());
        }
    }

    Ok(sections
        .into_iter()
        .map(|(name, content)| {
            if name == "preamble" {
                (name, content)
            } else {
                let wrapped = format!("<{name}>\n{content}\n</{name}>");
                (name, wrapped)
            }
        })
        .collect())
}

/// The prompt as a system message holds it (`buildSystemPromptState`).
pub fn build_system_prompt_state(
    options: &SystemPromptOptions,
) -> Result<SystemPromptState, String> {
    if let Some(forced) = &options.force_system_prompt {
        return Ok(SystemPromptState {
            content: forced.clone(),
            sections: None,
        });
    }
    Ok(SystemPromptState {
        content: String::new(),
        sections: Some(build_system_prompt_sections(options)?),
    })
}

/// The prompt's text, as the transcript's system message replays it (`buildSystemPrompt`).
pub fn build_system_prompt(options: &SystemPromptOptions) -> Result<String, String> {
    let state = build_system_prompt_state(options)?;
    Ok(system_message_text(&SystemMessage {
        content: Content::Text(state.content),
        sections: state.sections.map(|sections| {
            Sections(
                sections
                    .into_iter()
                    .map(|(name, text)| (name, Some(text)))
                    .collect(),
            )
        }),
        tools_added: None,
        tools_removed: None,
        timestamp: 0,
    }))
}

/// The patch that brings the model's sections (`previous`, replayed from the transcript) to
/// `current`: changed and new sections, then `None` for each removed one; `None` when nothing
/// changed (`diffSystemPromptSections`).
pub fn diff_system_prompt_sections(
    previous: &Sections,
    current: &[(String, String)],
) -> Option<Sections> {
    let mut patch: Vec<(String, Option<String>)> = Vec::new();
    for (name, text) in current {
        let unchanged = previous
            .0
            .iter()
            .any(|(existing, value)| existing == name && value.as_deref() == Some(text.as_str()));
        if !unchanged {
            patch.push((name.clone(), Some(text.clone())));
        }
    }
    for (name, _) in &previous.0 {
        if !current.iter().any(|(existing, _)| existing == name) {
            patch.push((name.clone(), None));
        }
    }
    (!patch.is_empty()).then_some(Sections(patch))
}
