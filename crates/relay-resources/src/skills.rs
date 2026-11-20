//! Skills (`skills.ts`): instructions for a kind of task in a `SKILL.md` file, listed in the system
//! prompt so the model can read the file when a task matches.

use serde::{Deserialize, Serialize};

/// Where a resource came from (`SourceInfo` in `source-info.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub path: String,
    pub source: String,
    /// `user`, `project` or `temporary`.
    pub scope: String,
    /// `package` or `top-level`.
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
}

/// A loaded skill (`Skill`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub file_path: String,
    pub base_dir: String,
    pub source_info: SourceInfo,
    /// Only `/skill:name` invokes it; the system prompt leaves it out.
    pub disable_model_invocation: bool,
}

/// The tool the listing tells the model to read skill files with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillReadTool {
    Read,
    Bash,
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The skills the model may invoke, as the Agent Skills XML listing (`formatSkillsForPrompt`);
/// empty when there are none.
pub fn format_skills_for_prompt(skills: &[Skill], tool: SkillReadTool) -> String {
    let visible: Vec<&Skill> = skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation)
        .collect();
    if visible.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        "\n\nThe following skills provide specialized instructions for specific tasks.".to_string(),
        match tool {
            SkillReadTool::Read => "Use the read tool to load a skill's file when the task matches its description.",
            SkillReadTool::Bash => "Use bash to load a skill's file when the task matches its description.",
        }
        .to_string(),
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.".to_string(),
        "Treat a skill file as a router: load the references and scripts it points to when the current step needs them, not all up front, and return to them when debugging or validating.".to_string(),
        String::new(),
        "<available_skills>".to_string(),
    ];
    for skill in visible {
        lines.push("  <skill>".into());
        lines.push(format!("    <name>{}</name>", escape_xml(&skill.name)));
        lines.push(format!(
            "    <description>{}</description>",
            escape_xml(&skill.description)
        ));
        lines.push(format!(
            "    <location>{}</location>",
            escape_xml(&skill.file_path)
        ));
        lines.push("  </skill>".into());
    }
    lines.push("</available_skills>".into());
    lines.join("\n")
}
