//! Relay's desktop shell: one window showing the screen in `packages/desktop/dist`, and the
//! `relay --mode rpc` process behind it. The shell only moves lines: the window's commands go to
//! the process's stdin (`rpc_send`), and each line the process writes comes back as an `rpc-line`
//! event; `rpc-exit` reports that it ended. All agent logic stays in relay.
//!
//! `RELAY_DESKTOP_COMMAND` replaces the `relay` command (for example `node /path/to/cli.js`), and
//! `RELAY_DESKTOP_CWD` the working directory, which is otherwise the shell's own.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

/// The relay process, started by the window's first command.
#[derive(Default)]
struct Relay {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

/// The program and arguments that start relay in RPC mode.
fn relay_command() -> (String, Vec<String>) {
    let configured = std::env::var("RELAY_DESKTOP_COMMAND").unwrap_or_default();
    let mut words = configured.split_whitespace().map(str::to_string);
    let program = words.next().unwrap_or_else(|| "relay".to_string());
    let mut args: Vec<String> = words.collect();
    args.extend(["--mode".to_string(), "rpc".to_string()]);
    (program, args)
}

fn spawn(program: &str, args: &[String], cwd: &PathBuf) -> std::io::Result<Child> {
    Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
}

/// Start relay and forward its stdout to the window, line by line.
fn start(app: &AppHandle, relay: &Relay) -> Result<ChildStdin, String> {
    let (program, args) = relay_command();
    let cwd = std::env::var_os("RELAY_DESKTOP_CWD")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .ok_or("no working directory")?;
    let mut child = match spawn(&program, &args, &cwd) {
        // npm installs relay as a `relay.cmd` script on Windows, which needs its extension.
        Err(error)
            if error.kind() == ErrorKind::NotFound && cfg!(windows) && !program.contains('.') =>
        {
            spawn(&format!("{program}.cmd"), &args, &cwd)
        }
        other => other,
    }
    .map_err(|error| format!("could not start {program}: {error}"))?;
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
