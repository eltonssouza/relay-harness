//! Where grep and find get ripgrep and fd (`getToolPath` in `utils/tools-manager.ts`): Relay's own
//! binary directory first, then the system path. The TypeScript agent also downloads a missing
//! tool from its GitHub release; that is not ported yet, so a missing tool is reported as one that
//! could not be downloaded.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::paths::home_dir;

/// The agent's directory (`getAgentDir`): `RELAY_CODING_AGENT_DIR`, else `~/.relay/agent`.
pub fn agent_dir() -> Option<String> {
    if let Some(dir) = std::env::var("RELAY_CODING_AGENT_DIR")
        .ok()
        .filter(|dir| !dir.is_empty())
    {
        let home = home_dir();
        return Some(crate::paths::normalize_path(
            &dir,
            &crate::paths::PathInput {
                home: home.as_deref(),
                windows: cfg!(windows),
                ..crate::paths::PathInput::default()
            },
        ));
    }
    home_dir().map(|home| {
        Path::new(&home)
            .join(".relay")
            .join("agent")
            .to_string_lossy()
            .into_owned()
    })
}

/// Whether a command runs (`commandExists`): it starts with `--version`.
fn command_exists(command: &str) -> bool {
    Command::new(command)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

/// A search tool's path or command name, if it is installed.
pub fn tool_path(tool: &str) -> Option<String> {
    let (binary, system_names): (&str, &[&str]) = match tool {
        "fd" => ("fd", &["fd", "fdfind"]),
        "rg" => ("rg", &["rg"]),
        _ => return None,
    };
    if let Some(dir) = agent_dir() {
        let name = if cfg!(windows) {
            format!("{binary}.exe")
        } else {
            binary.to_string()
        };
        let local = Path::new(&dir).join("bin").join(name);
        if local.exists() {
            return Some(local.to_string_lossy().into_owned());
        }
    }
    system_names
        .iter()
        .find(|name| command_exists(name))
        .map(|name| name.to_string())
}
