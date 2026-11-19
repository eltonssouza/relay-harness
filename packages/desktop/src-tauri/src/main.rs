//! Relay's desktop shell: one window showing the screen in `packages/desktop/dist`, and the
//! `relay --mode rpc` process behind it. The shell only moves lines: the window's commands go to
//! the process's stdin (`rpc_send`), and each line the process writes comes back as an `rpc-line`
//! event; `rpc-exit` reports that it ended. All agent logic stays in relay.
//!
//! The installers carry relay's standalone binary in `<resources>/relay/`, and the shell runs it.
//! `RELAY_DESKTOP_COMMAND` replaces it (for example `node /path/to/cli.js`); without either, the
//! shell runs `relay` from `PATH`. `RELAY_DESKTOP_CWD` sets the working directory, which is
//! otherwise the shell's own.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

/// The relay process, started by the window's first command.
#[derive(Default)]
struct Relay {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

/// The relay binary an installer carries. tauri.conf.json bundles `resources/relay/`, where the
/// release workflow extracts the platform's standalone binary; a local build has none.
fn bundled_relay(resource_dir: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "relay.exe" } else { "relay" };
    let path = resource_dir.join("relay").join(name);
    path.is_file().then_some(path)
}

/// The program and arguments that start relay in RPC mode: the configured command, else the
/// bundled binary, else `relay` from `PATH`.
fn relay_command(configured: Option<&str>, bundled: Option<PathBuf>) -> (PathBuf, Vec<String>) {
    let mut words = configured.unwrap_or_default().split_whitespace();
    let (program, mut args) = match words.next() {
        Some(program) => (PathBuf::from(program), words.map(str::to_string).collect()),
        None => (
            bundled.unwrap_or_else(|| PathBuf::from("relay")),
            Vec::new(),
        ),
    };
    args.extend(["--mode".to_string(), "rpc".to_string()]);
    (program, args)
}

fn spawn(program: &Path, args: &[String], cwd: &Path) -> std::io::Result<Child> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    // The window has no console, so Windows would open one for relay; CREATE_NO_WINDOW prevents it.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    command.spawn()
}

/// Start relay and forward its stdout to the window, line by line.
fn start(app: &AppHandle, relay: &Relay) -> Result<ChildStdin, String> {
    let configured = std::env::var("RELAY_DESKTOP_COMMAND").ok();
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|dir| bundled_relay(&dir));
    let (program, args) = relay_command(configured.as_deref(), bundled);
    let cwd = std::env::var_os("RELAY_DESKTOP_CWD")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .ok_or("no working directory")?;
    let mut child = match spawn(&program, &args, &cwd) {
        // npm installs relay as a `relay.cmd` script on Windows, which needs its extension.
        Err(error)
            if error.kind() == ErrorKind::NotFound
                && cfg!(windows)
                && program.extension().is_none() =>
        {
            spawn(&program.with_extension("cmd"), &args, &cwd)
        }
        other => other,
    }
    .map_err(|error| format!("could not start {}: {error}", program.display()))?;
    let stdin = child.stdin.take().ok_or("relay has no stdin")?;
    let stdout = child.stdout.take().ok_or("relay has no stdout")?;
    *relay.child.lock().map_err(|_| "relay state is poisoned")? = Some(child);
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if handle.emit("rpc-line", line).is_err() {
                break;
            }
        }
        let relay = handle.state::<Relay>();
        let code = relay
            .child
            .lock()
            .ok()
            .and_then(|mut child| child.take())
            .and_then(|mut child| child.wait().ok())
            .and_then(|status| status.code());
        if let Ok(mut stdin) = relay.stdin.lock() {
            *stdin = None;
        }
        let _ = handle.emit("rpc-exit", code);
    });
    Ok(stdin)
}

/// Write one JSON line to relay, starting it on the first call.
#[tauri::command]
fn rpc_send(line: String, app: AppHandle, relay: State<'_, Relay>) -> Result<(), String> {
    if line.contains('\n') {
        return Err("an RPC command is one line".into());
    }
    let mut stdin = relay.stdin.lock().map_err(|_| "relay state is poisoned")?;
    if stdin.is_none() {
        *stdin = Some(start(&app, &relay)?);
    }
    let pipe = stdin.as_mut().ok_or("relay is not running")?;
    pipe.write_all(line.as_bytes())
        .and_then(|()| pipe.write_all(b"\n"))
        .and_then(|()| pipe.flush())
        .map_err(|error| format!("relay stopped reading: {error}"))
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Relay::default())
        .invoke_handler(tauri::generate_handler![rpc_send])
        .build(tauri::generate_context!())
        .expect("the Relay window could not be created");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let relay = app.state::<Relay>();
            // Closing stdin ends relay's RPC loop; the kill covers a process that does not exit.
            if let Ok(mut stdin) = relay.stdin.lock() {
                *stdin = None;
            }
            let child = relay.child.lock().ok().and_then(|mut child| child.take());
            if let Some(mut child) = child {
                let _ = child.kill();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rpc(program: &str, args: &[&str]) -> (PathBuf, Vec<String>) {
        let mut args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        args.extend(["--mode".to_string(), "rpc".to_string()]);
        (PathBuf::from(program), args)
    }

    #[test]
    fn the_configured_command_comes_first() {
        let bundled = Some(PathBuf::from("/opt/relay/relay"));
        assert_eq!(
            relay_command(Some("node /src/cli.js"), bundled),
            rpc("node", &["/src/cli.js"])
        );
    }

    #[test]
    fn the_bundled_binary_comes_before_path() {
        let bundled = PathBuf::from("/opt/relay/relay");
        assert_eq!(
            relay_command(None, Some(bundled.clone())),
            rpc("/opt/relay/relay", &[])
        );
        // An empty command is not a configured one.
        assert_eq!(
            relay_command(Some("  "), Some(bundled)),
            rpc("/opt/relay/relay", &[])
        );
    }

    #[test]
    fn without_either_relay_comes_from_path() {
        assert_eq!(relay_command(None, None), rpc("relay", &[]));
    }

    #[test]
    fn a_bundled_binary_is_a_file_in_the_relay_folder() {
        let resources =
            std::env::temp_dir().join(format!("relay-desktop-test-{}", std::process::id()));
        let folder = resources.join("relay");
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(bundled_relay(&resources), None);
        let binary = folder.join(if cfg!(windows) { "relay.exe" } else { "relay" });
        std::fs::write(&binary, b"").unwrap();
        assert_eq!(bundled_relay(&resources), Some(binary));
        std::fs::remove_dir_all(&resources).unwrap();
    }
}
