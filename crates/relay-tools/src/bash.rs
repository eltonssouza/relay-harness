//! The `bash` and `powershell` tools (`bash.ts`, `powershell.ts`): a command in the shell,
//! stdout and stderr together, the last 2000 lines or 50 KB of it for the model and all of it in
//! an output file when that cuts anything, with an optional timeout.
//!
//! The shell runs with its output read on two threads and its exit awaited on a third. A fourth
//! thread waits as `waitForChildProcess` does: once the shell exits, until both pipes close or
//! they stay quiet for 100 ms, so a background process holding them open does not hold the call.
//! It also enforces the timeout and ticks, so throttled updates reach the caller.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use futures_channel::mpsc::{unbounded, UnboundedReceiver, UnboundedSender};
use futures_util::future::{select, BoxFuture, Either};
use futures_util::StreamExt;
use relay_agent::{AgentTool, AgentToolResult, ToolUpdate};
use relay_ai::abort::AbortSignal;
use relay_ai::{InputBlock, TextContent, Tool};
use serde_json::{json, Map, Value};

use crate::js::number;
use crate::output::{OutputAccumulator, OutputAccumulatorOptions, OutputSnapshot};
use crate::shell::{
    hide_window, kill_process_tree, power_shell_config, shell_config, shell_env,
    track_detached_child, untrack_detached_child, CommandTransport, ShellConfig,
};
use crate::truncate::{format_size, TruncatedBy, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES};

const MAX_TIMEOUT_MS: f64 = 2_147_483_647.0;
/// Output limit of `structuredContent.output`, which programmatic callers receive.
const STRUCTURED_OUTPUT_MAX_BYTES: u64 = 1024 * 1024;
/// Updates come at most this often (`BASH_UPDATE_THROTTLE_MS`).
const UPDATE_THROTTLE: Duration = Duration::from_millis(100);
/// How long the pipes may stay quiet after the shell exits (`EXIT_STDIO_GRACE_MS`).
const EXIT_STDIO_GRACE: Duration = Duration::from_millis(100);
/// Makes PowerShell write UTF-8.
const UTF8_OUTPUT_PREFIX: &str =
    "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
/// Session variables a command sees only from its own session.
const SESSION_VARIABLES: [&str; 5] = [
    "RELAY_SESSION_ID",
    "RELAY_SESSION_FILE",
    "RELAY_PROVIDER",
    "RELAY_MODEL",
    "RELAY_REASONING_LEVEL",
];
const SESSION_GUIDELINE: &str =
    "You can inspect RELAY_* environment variables for current model and session details.";

/// What a command runs with; a spawn hook may change any of it (`BashSpawnContext`).
#[derive(Debug, Clone, PartialEq)]
pub struct SpawnContext {
    pub command: String,
    pub cwd: String,
    pub env: Vec<(OsString, OsString)>,
}

/// Adjusts a command before it runs (`BashSpawnHook`).
pub type SpawnHook = Arc<dyn Fn(SpawnContext) -> SpawnContext + Send + Sync>;

/// What the running session tells a call: the parts of `ExtensionContext` the tool reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShellSession {
    /// Overrides the tool's working directory.
    pub cwd: Option<String>,
    pub session_id: String,
    pub session_file: Option<String>,
    /// The model's provider and id.
    pub model: Option<(String, String)>,
    pub thinking_level: Option<String>,
}

/// Reads the session at each call.
pub type SessionSource = Arc<dyn Fn() -> ShellSession + Send + Sync>;

/// The tool's options (`BashToolOptions`).
#[derive(Clone)]
pub struct ShellToolOptions {
    /// Prepended to every command on its own line, such as shell setup.
    pub command_prefix: Option<String>,
    /// The bash to run, from settings; the powershell tool ignores it.
    pub shell_path: Option<String>,
    /// Exposes the session as `RELAY_*` variables.
    pub expose_session_environment: bool,
    pub session: Option<SessionSource>,
    pub spawn_hook: Option<SpawnHook>,
}

impl Default for ShellToolOptions {
    fn default() -> Self {
        ShellToolOptions {
            command_prefix: None,
            shell_path: None,
            expose_session_environment: true,
            session: None,
            spawn_hook: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shell {
    Bash,
    PowerShell,
}

/// Runs commands in bash or PowerShell.
pub struct ShellTool {
    declaration: Tool,
    shell: Shell,
    cwd: String,
    options: ShellToolOptions,
}

fn declaration(name: &str, shell_name: &str) -> Tool {
    Tool {
        name: name.into(),
        description: format!(
            "Execute a {shell_name} command in the current working directory. Returns stdout and stderr. Output is truncated to last {DEFAULT_MAX_LINES} lines or {}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
            DEFAULT_MAX_BYTES / 1024
        ),
        parameters: json!({
            "type": "object",
            "required": ["command"],
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute"},
                "timeout": {"type": "number", "description": "Timeout in seconds (optional, no default timeout)"},
            },
        }),
        constrained_sampling: Some(json!({"type": "json_schema", "strict": "prefer"})),
    }
}

/// Why a command gave no exit code.
enum ExecError {
    Aborted,
    /// The timeout as the call gave it.
    TimedOut(f64),
    Failed(String),
}

/// What the shell's threads report.
enum ShellEvent {
    Data(Vec<u8>),
    /// Time passed; a throttled update may be due.
    Tick,
    Done {
        code: i32,
        timed_out: bool,
    },
}

/// What the reader and waiter threads report to the thread that decides when the shell is done.
enum Internal {
    Data(Vec<u8>),
    End,
    Exit(i32),
}

/// The exit code, or `128 + signal` for a shell a signal ended.
fn exit_code(status: std::io::Result<std::process::ExitStatus>) -> i32 {
    let Ok(status) = status else {
        return 1;
    };
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

fn read_pipe(mut pipe: impl Read + Send + 'static, events: mpsc::Sender<Internal>) {
    thread::spawn(move || {
        let mut buffer = vec![0; 64 * 1024];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if events
                        .send(Internal::Data(buffer[..read].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = events.send(Internal::End);
    });
}

/// Waits for the shell as `waitForChildProcess` does, with the timeout, forwarding its output.
fn supervise(
    pid: u32,
    events: mpsc::Receiver<Internal>,
    out: UnboundedSender<ShellEvent>,
    timeout: Option<Duration>,
) {
    let deadline = timeout.map(|timeout| Instant::now() + timeout);
    let mut timed_out = false;
    let mut code = None;
    let mut open_pipes = 2;
    let mut quiet_until: Option<Instant> = None;
    loop {
        let now = Instant::now();
        let mut wait = UPDATE_THROTTLE;
        if let Some(until) = quiet_until {
            wait = wait.min(until.saturating_duration_since(now));
        }
        if let (Some(deadline), false) = (deadline, timed_out) {
            wait = wait.min(deadline.saturating_duration_since(now));
        }
        match events.recv_timeout(wait) {
            Ok(Internal::Data(bytes)) => {
                let _ = out.unbounded_send(ShellEvent::Data(bytes));
                // Output still arriving after the exit defers the end.
                if code.is_some() {
                    quiet_until = Some(Instant::now() + EXIT_STDIO_GRACE);
                }
            }
            Ok(Internal::End) => open_pipes -= 1,
            Ok(Internal::Exit(exit)) => {
                code = Some(exit);
                quiet_until = Some(Instant::now() + EXIT_STDIO_GRACE);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = out.unbounded_send(ShellEvent::Tick);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if code.is_some() && open_pipes == 0 {
            break;
        }
        let now = Instant::now();
        if deadline.is_some_and(|deadline| !timed_out && now >= deadline) {
            timed_out = true;
            kill_process_tree(pid);
        }
        if quiet_until.is_some_and(|until| now >= until) {
            break;
        }
    }
    let _ = out.unbounded_send(ShellEvent::Done {
        code: code.unwrap_or(1),
        timed_out,
    });
}

/// Node's wording of a failed spawn: `spawn /bin/bash ENOENT`.
fn spawn_error(shell: &str, error: &std::io::Error) -> String {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        _ => return format!("spawn {shell} {error}"),
    };
    format!("spawn {shell} {code}")
}

/// Starts the shell; its output and end arrive on the returned stream.
fn spawn_shell(
    config: &ShellConfig,
    context: &SpawnContext,
    timeout: Option<Duration>,
) -> Result<(u32, UnboundedReceiver<ShellEvent>), String> {
    let from_stdin = config.transport == CommandTransport::Stdin;
    let mut command = Command::new(&config.shell);
    command.args(&config.args);
    if !from_stdin {
        command.arg(&context.command);
    }
    command
        .current_dir(&context.cwd)
        .env_clear()
        .envs(context.env.iter().map(|(key, value)| (key, value)))
        .stdin(if from_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    #[cfg(unix)]
    crate::shell::detach(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| spawn_error(&config.shell, &error))?;
    let pid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        let text = context.command.clone();
        thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        });
    }
    let (internal, events) = mpsc::channel();
    read_pipe(
        child.stdout.take().expect("stdout is piped"),
        internal.clone(),
    );
    read_pipe(
        child.stderr.take().expect("stderr is piped"),
        internal.clone(),
    );
    thread::spawn(move || {
        let _ = internal.send(Internal::Exit(exit_code(child.wait())));
    });
    let (out, stream) = unbounded();
    thread::spawn(move || supervise(pid, events, out, timeout));
    Ok((pid, stream))
}

/// The timeout in milliseconds (`resolveTimeoutMs`).
fn timeout_ms(timeout: Option<f64>) -> Result<Option<f64>, String> {
    let Some(timeout) = timeout else {
        return Ok(None);
    };
    if !timeout.is_finite() || timeout <= 0.0 {
        return Err("Invalid timeout: must be a finite number of seconds".to_string());
    }
    let ms = timeout * 1000.0;
    if ms > MAX_TIMEOUT_MS {
        return Err(format!(
            "Invalid timeout: maximum is {} seconds",
            number(MAX_TIMEOUT_MS / 1000.0)
        ));
    }
    Ok(Some(ms))
}

fn text_block(text: String) -> InputBlock {
    InputBlock::Text(TextContent {
        text,
        text_signature: None,
        volatile: None,
    })
}

fn appended(text: &str, status: &str) -> String {
    if text.is_empty() {
        status.to_string()
    } else {
        format!("{text}\n\n{status}")
    }
}

/// Throttled partial results.
struct Updates<'a> {
    on_update: ToolUpdate<'a>,
    last: Option<Instant>,
    dirty: bool,
}

impl Updates<'_> {
    fn emit(&mut self, output: &mut OutputAccumulator) {
        if !self.dirty {
            return;
        }
        self.dirty = false;
        self.last = Some(Instant::now());
        let snapshot = output.snapshot(true);
        let mut details = Map::new();
        if snapshot.truncation.truncated {
            details.insert(
                "truncation".into(),
                serde_json::to_value(&snapshot.truncation).expect("serializable"),
            );
        }
        if let Some(path) = snapshot.full_output_path {
            details.insert("fullOutputPath".into(), Value::String(path));
        }
        (self.on_update)(AgentToolResult {
            content: vec![text_block(snapshot.content)],
            details: Some(Value::Object(details)),
            structured_content: None,
            usage: None,
            is_error: None,
            terminate: None,
        });
    }

    fn due(&self) -> bool {
        self.last
            .is_none_or(|last| last.elapsed() >= UPDATE_THROTTLE)
    }
}

/// The output text with its truncation notice, and the details naming the output file.
fn format_output(
    snapshot: &OutputSnapshot,
    last_line_bytes: u64,
    empty: &str,
) -> (String, Option<Value>) {
    let truncation = &snapshot.truncation;
    let mut text = if snapshot.content.is_empty() {
        empty.to_string()
    } else {
        snapshot.content.clone()
    };
    if !truncation.truncated {
        return (text, None);
    }
    let path = snapshot.full_output_path.clone().unwrap_or_default();
    let mut details = Map::new();
    details.insert(
        "truncation".into(),
        serde_json::to_value(truncation).expect("serializable"),
    );
    if let Some(path) = &snapshot.full_output_path {
        details.insert("fullOutputPath".into(), Value::String(path.clone()));
    }
    let start = truncation.total_lines - truncation.output_lines + 1;
    let end = truncation.total_lines;
    if truncation.last_line_partial {
        text.push_str(&format!(
            "\n\n[Showing last {} of line {end} (line is {}). Full output: {path}]",
            format_size(truncation.output_bytes),
            format_size(last_line_bytes)
        ));
    } else if truncation.truncated_by == Some(TruncatedBy::Lines) {
        text.push_str(&format!(
            "\n\n[Showing lines {start}-{end} of {}. Full output: {path}]",
            truncation.total_lines
        ));
    } else {
        text.push_str(&format!(
            "\n\n[Showing lines {start}-{end} of {} ({} limit). Full output: {path}]",
            truncation.total_lines,
            format_size(DEFAULT_MAX_BYTES)
        ));
    }
    (text, Some(Value::Object(details)))
}

impl ShellTool {
    /// The `bash` tool.
    pub fn bash(cwd: impl Into<String>, options: ShellToolOptions) -> Self {
        ShellTool {
            declaration: declaration("bash", "bash"),
            shell: Shell::Bash,
            cwd: cwd.into(),
            options,
        }
    }

    /// The `powershell` tool, for Windows.
    pub fn powershell(cwd: impl Into<String>, options: ShellToolOptions) -> Self {
        ShellTool {
            declaration: declaration("powershell", "PowerShell"),
            shell: Shell::PowerShell,
            cwd: cwd.into(),
            options,
        }
    }

    /// The tool's line in the system prompt.
    pub fn prompt_snippet(&self) -> &'static str {
        match self.shell {
            Shell::Bash => "Execute bash commands (ls, grep, find, etc.)",
            Shell::PowerShell => "Execute PowerShell commands",
        }
    }

    /// The tool's system prompt guidelines, when it exposes the session.
    pub fn prompt_guidelines(&self) -> Option<Vec<String>> {
        self.options
            .expose_session_environment
            .then(|| vec![SESSION_GUIDELINE.to_string()])
    }

    fn shell_name(&self) -> &'static str {
        match self.shell {
            Shell::Bash => "bash",
            Shell::PowerShell => "PowerShell",
        }
    }

    /// The command, directory and environment the call runs with (`resolveSpawnContext`).
    fn spawn_context(&self, command: String) -> SpawnContext {
        let session = self.options.session.as_ref().map(|session| session());
        let cwd = session
            .as_ref()
            .and_then(|session| session.cwd.clone())
            .filter(|cwd| !cwd.is_empty())
            .unwrap_or_else(|| self.cwd.clone());
        let mut env = shell_env();
        env.retain(|(key, _)| !SESSION_VARIABLES.iter().any(|name| key == *name));
        if let (true, Some(session)) = (self.options.expose_session_environment, &session) {
            env.push(("RELAY_SESSION_ID".into(), session.session_id.clone().into()));
            if let Some(file) = session
                .session_file
                .as_ref()
                .filter(|file| !file.is_empty())
            {
                env.push(("RELAY_SESSION_FILE".into(), file.into()));
            }
            if let Some((provider, model)) = &session.model {
                env.push(("RELAY_PROVIDER".into(), provider.into()));
                env.push(("RELAY_MODEL".into(), model.into()));
            }
            if let Some(level) = session
                .thinking_level
                .as_ref()
                .filter(|level| !level.is_empty())
            {
                env.push(("RELAY_REASONING_LEVEL".into(), level.into()));
            }
        }
        let context = SpawnContext { command, cwd, env };
        match &self.options.spawn_hook {
            Some(hook) => hook(context),
            None => context,
        }
    }

    /// Runs the command (`createLocalShellOperations().exec`), its output into `handle`.
    async fn exec(
        &self,
        context: &SpawnContext,
        timeout: Option<f64>,
        signal: &AbortSignal,
        mut handle: impl FnMut(Option<&[u8]>),
    ) -> Result<i32, ExecError> {
        let ms = timeout_ms(timeout).map_err(ExecError::Failed)?;
        if signal.is_aborted() {
            return Err(ExecError::Aborted);
        }
        let config = match self.shell {
            Shell::Bash => shell_config(self.options.shell_path.as_deref()),
            Shell::PowerShell => power_shell_config(),
        }
        .map_err(ExecError::Failed)?;
        if !Path::new(&context.cwd).exists() {
            return Err(ExecError::Failed(format!(
                "Working directory does not exist: {}\nCannot execute {} commands.",
                context.cwd,
                self.shell_name()
            )));
        }
        let mut context = context.clone();
        if self.shell == Shell::PowerShell {
            context.command = format!("{UTF8_OUTPUT_PREFIX}{}", context.command);
        }
        // Node's timers take whole milliseconds, at least one.
        let duration = ms.map(|ms| Duration::from_millis((ms.trunc() as u64).max(1)));
        let (pid, mut events) =
            spawn_shell(&config, &context, duration).map_err(ExecError::Failed)?;
        track_detached_child(pid);
        let mut aborted = Box::pin(signal.aborted());
        let mut killed = false;
        let mut result = (1, false);
        loop {
            let event = if killed {
                events.next().await
            } else {
                match select(events.next(), aborted.as_mut()).await {
                    Either::Left((event, _)) => event,
                    Either::Right(((), _)) => {
                        killed = true;
                        kill_process_tree(pid);
                        continue;
                    }
                }
            };
            match event {
                Some(ShellEvent::Data(bytes)) => handle(Some(&bytes)),
                Some(ShellEvent::Tick) => handle(None),
                Some(ShellEvent::Done { code, timed_out }) => {
                    result = (code, timed_out);
                    break;
                }
                None => break,
            }
        }
        untrack_detached_child(pid);
        if signal.is_aborted() {
            return Err(ExecError::Aborted);
        }
        let (code, timed_out) = result;
        if timed_out {
            return Err(ExecError::TimedOut(timeout.unwrap_or_default()));
        }
        Ok(code)
    }

    pub async fn run(
        &self,
        params: &Value,
        signal: &AbortSignal,
        on_update: ToolUpdate<'_>,
    ) -> Result<AgentToolResult, String> {
        let command = params["command"].as_str().unwrap_or_default();
        let timeout = params.get("timeout").and_then(Value::as_f64);
        let command = match &self.options.command_prefix {
            Some(prefix) if !prefix.is_empty() => format!("{prefix}\n{command}"),
            _ => command.to_string(),
        };
        let context = self.spawn_context(command);
        let prefix = match self.shell {
            Shell::Bash => "relay-bash",
            Shell::PowerShell => "relay-powershell",
        };
        let mut output = OutputAccumulator::new(OutputAccumulatorOptions {
            temp_file_prefix: prefix.to_string(),
            ..OutputAccumulatorOptions::default()
        });
        let mut updates = Updates {
            on_update,
            last: None,
            dirty: false,
        };
        on_update(AgentToolResult {
            content: Vec::new(),
            details: None,
            structured_content: None,
            usage: None,
            is_error: None,
            terminate: None,
        });
        let started = Instant::now();
        let outcome = self
            .exec(&context, timeout, signal, |data| {
                if let Some(data) = data {
                    output.append(data);
                    updates.dirty = true;
                }
                if updates.dirty && updates.due() {
                    updates.emit(&mut output);
                }
            })
            .await;

        output.finish();
        updates.emit(&mut output);
        let snapshot = output.snapshot(true);
        output.close_temp_file()?;
        let code = match outcome {
            Ok(code) => code,
            Err(error) => {
                let (text, _) = format_output(&snapshot, output.last_line_bytes(), "");
                return Err(match error {
                    ExecError::Aborted => appended(&text, "Command aborted"),
                    ExecError::TimedOut(timeout) => appended(
                        &text,
                        &format!("Command timed out after {} seconds", number(timeout)),
                    ),
                    ExecError::Failed(message) => message,
                });
            }
        };
        let (text, details) = format_output(&snapshot, output.last_line_bytes(), "(no output)");
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let wall_time_seconds = (elapsed / 100.0 + 0.5).floor() / 10.0;
        let full = output.read_full_output(STRUCTURED_OUTPUT_MAX_BYTES)?;
        let mut structured = Map::new();
        structured.insert("output".into(), Value::String(full.content));
        structured.insert("truncated".into(), Value::Bool(full.truncated));
        if let (true, Some(path)) = (full.truncated, &snapshot.full_output_path) {
            structured.insert("full_output_path".into(), Value::String(path.clone()));
        }
        structured.insert("exit_code".into(), json!(code));
        structured.insert("wall_time_seconds".into(), json!(wall_time_seconds));
        let failed = code != 0;
        Ok(AgentToolResult {
            content: vec![text_block(if failed {
                appended(&text, &format!("Command exited with code {code}"))
            } else {
                text
            })],
            details,
            structured_content: Some(Value::Object(structured)),
            usage: None,
            is_error: failed.then_some(true),
            terminate: None,
        })
    }
}

impl AgentTool for ShellTool {
    fn declaration(&self) -> &Tool {
        &self.declaration
    }

    fn typebox(&self) -> bool {
        true
    }

    fn execute<'a>(
        &'a self,
        _tool_call_id: &'a str,
        params: Value,
        signal: &'a AbortSignal,
        on_update: ToolUpdate<'a>,
    ) -> BoxFuture<'a, Result<AgentToolResult, String>> {
        Box::pin(async move { self.run(&params, signal, on_update).await })
    }
}
