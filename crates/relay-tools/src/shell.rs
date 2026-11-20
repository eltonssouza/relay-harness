//! Finding and stopping the shells the bash and powershell tools run (`utils/shell.ts`).

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, PoisonError};

use crate::tools_manager::bin_dir;

/// How a shell takes a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandTransport {
    /// As the last argument.
    Argv,
    /// On standard input, for shells that cannot take it as an argument.
    Stdin,
}

/// A shell and the arguments before the command (`ShellConfig`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellConfig {
    pub shell: String,
    pub args: Vec<String>,
    pub transport: CommandTransport,
}

/// Windows' legacy WSL launcher, which mangles a command passed as an argument.
fn is_legacy_wsl_bash_path(path: &str) -> bool {
    let normalized = path.replace('/', "\\").to_lowercase();
    let bytes = normalized.as_bytes();
    bytes.len() > 3
        && bytes[0].is_ascii_lowercase()
        && normalized[1..].starts_with(":\\windows\\")
        && matches!(
            &normalized[11..],
            "system32\\bash.exe" | "sysnative\\bash.exe"
        )
}

fn bash_shell_config(shell: &str) -> ShellConfig {
    if is_legacy_wsl_bash_path(shell) {
        ShellConfig {
            shell: shell.to_string(),
            args: vec!["-s".to_string()],
            transport: CommandTransport::Stdin,
        }
    } else {
        ShellConfig {
            shell: shell.to_string(),
            args: vec!["-c".to_string()],
            transport: CommandTransport::Argv,
        }
    }
}

/// The first match of `where` (Windows, checked to exist) or `which`.
fn find_executable_on_path(executable: &str) -> Option<String> {
    let finder = if cfg!(windows) { "where" } else { "which" };
    let mut command = Command::new(finder);
    command
        .arg(executable)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    hide_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout.trim().split('\n').next()?.trim_end_matches('\r');
    if first.is_empty() || (cfg!(windows) && !Path::new(first).exists()) {
        return None;
    }
    Some(first.to_string())
}

/// The bash to run (`getShellConfig`): `custom` when given, else Git Bash or bash on the path on
/// Windows, else `/bin/bash`, bash on the path or `sh`.
pub fn shell_config(custom: Option<&str>) -> Result<ShellConfig, String> {
    if let Some(custom) = custom.filter(|custom| !custom.is_empty()) {
        if Path::new(custom).exists() {
            return Ok(bash_shell_config(custom));
        }
        return Err(format!("Custom shell path not found: {custom}"));
    }
    if cfg!(windows) {
        let mut paths = Vec::new();
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(dir) = std::env::var(variable).ok().filter(|dir| !dir.is_empty()) {
                paths.push(format!("{dir}\\Git\\bin\\bash.exe"));
            }
        }
        if let Some(path) = paths.iter().find(|path| Path::new(path).exists()) {
            return Ok(bash_shell_config(path));
        }
        if let Some(path) = find_executable_on_path("bash.exe") {
            return Ok(bash_shell_config(&path));
        }
        let searched: Vec<String> = paths.iter().map(|path| format!("  {path}")).collect();
        return Err(format!(
            "No bash shell found. Options:\n  1. Install Git for Windows: https://git-scm.com/download/win\n  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n  3. Set shellPath in settings.json\n\nSearched Git Bash in:\n{}",
            searched.join("\n")
        ));
    }
    if Path::new("/bin/bash").exists() {
        return Ok(bash_shell_config("/bin/bash"));
    }
    if let Some(path) = find_executable_on_path("bash") {
        return Ok(bash_shell_config(&path));
    }
    Ok(ShellConfig {
        shell: "sh".to_string(),
        args: vec!["-c".to_string()],
        transport: CommandTransport::Argv,
    })
}

pub const POWERSHELL_ARGS: [&str; 5] = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
];

/// PowerShell on Windows, 7 when installed (`getPowerShellConfig`).
pub fn power_shell_config() -> Result<ShellConfig, String> {
    if !cfg!(windows) {
        return Err("The powershell tool is only available on Windows.".to_string());
    }
    let shell = find_executable_on_path("pwsh.exe")
        .or_else(|| find_executable_on_path("powershell.exe"))
        .ok_or_else(|| {
            "No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH."
                .to_string()
        })?;
    Ok(ShellConfig {
        shell,
        args: POWERSHELL_ARGS.iter().map(|arg| arg.to_string()).collect(),
        transport: CommandTransport::Argv,
    })
}

/// The process environment with Relay's binary directory first on the path (`getShellEnv`).
pub fn shell_env() -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let Some(bin_dir) = bin_dir() else {
        return env;
    };
    let delimiter = if cfg!(windows) { ";" } else { ":" };
    let position = env
        .iter()
        .position(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case("path"));
    let current = position
        .map(|index| env[index].1.to_string_lossy().into_owned())
        .unwrap_or_default();
    if current
        .split(delimiter)
        .filter(|entry| !entry.is_empty())
        .any(|entry| entry == bin_dir)
    {
        return env;
    }
    let updated = if current.is_empty() {
        bin_dir
    } else {
        format!("{bin_dir}{delimiter}{current}")
    };
    match position {
        Some(index) => env[index].1 = updated.into(),
        None => env.push(("PATH".into(), updated.into())),
    }
    env
}

/// Starts a program without a console window (`windowsHide` with every stream redirected).
pub fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::os::windows::process::CommandExt::creation_flags(command, CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Shell processes started in their own session, killed on shutdown.
static DETACHED_CHILDREN: Mutex<Option<HashSet<u32>>> = Mutex::new(None);

pub fn track_detached_child(pid: u32) {
    DETACHED_CHILDREN
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_with(HashSet::new)
        .insert(pid);
}

pub fn untrack_detached_child(pid: u32) {
    if let Some(children) = DETACHED_CHILDREN
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_mut()
    {
        children.remove(&pid);
    }
}

/// Kills every tracked shell with its descendants, for a shutdown signal.
pub fn kill_tracked_detached_children() {
    let children = DETACHED_CHILDREN
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
        .unwrap_or_default();
    for pid in children {
        kill_process_tree(pid);
    }
}

/// Kills a process and its descendants (`killProcessTree`): `taskkill /F /T` from System32 on
/// Windows, else `SIGKILL` to its process group, or to it alone when it has none.
pub fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let root = std::env::var("SystemRoot")
            .ok()
            .filter(|root| !root.is_empty())
            .unwrap_or_else(|| "C:\\Windows".to_string());
        let mut command = Command::new(Path::new(&root).join("System32").join("taskkill.exe"));
        command
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_window(&mut command);
        // Not waited for: taskkill ends on its own, and the caller waits for the shell.
        let _ = command.spawn();
    }
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return;
        };
        // SAFETY: kill only sends a signal; a stale pid makes it fail with ESRCH.
        unsafe {
            if libc::kill(-pid, libc::SIGKILL) != 0 {
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }
}

/// Makes the child lead a new session (Node's `detached`), so killing its process group reaches
/// its descendants and it has no controlling terminal to wait on.
#[cfg(unix)]
pub fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: setsid is async-signal-safe, as code between fork and exec must be.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}
