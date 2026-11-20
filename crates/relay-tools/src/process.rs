//! Running a search program (ripgrep, fd) as the TypeScript tools spawn it: its output read line
//! by line, the program stopped when the reader has enough, killed when the call is aborted.
//!
//! A thread reads the output, so a line handler can stop the program while it still writes; the
//! call waits for the thread or the abort, whichever comes first.

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;

use futures_channel::oneshot;
use futures_util::future::{select, Either};
use relay_ai::abort::AbortSignal;

/// Reads the program's output lines; `false` stops the program.
pub trait LineHandler: Send + 'static {
    fn line(&mut self, line: &str) -> bool;
}

/// How the program ended.
pub struct Finished<H> {
    pub handler: H,
    pub stderr: String,
    /// None when a signal ended it.
    pub code: Option<i32>,
    /// The handler stopped it.
    pub stopped: bool,
}

/// Why the program gave no result.
pub enum RunError {
    /// It could not start.
    Spawn(std::io::Error),
    Aborted,
}

fn kill(child: &Mutex<Child>) {
    let _ = child.lock().unwrap_or_else(PoisonError::into_inner).kill();
}

/// Runs `program` with `args`, its output through `handler`, until it ends, `handler` stops it
/// or `signal` aborts.
pub async fn run<H: LineHandler>(
    program: &str,
    args: &[String],
    signal: &AbortSignal,
    mut handler: H,
) -> Result<Finished<H>, RunError> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(RunError::Spawn)?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let child = Arc::new(Mutex::new(child));

    let errors = thread::spawn(move || {
        let mut text = Vec::new();
        let _ = stderr.read_to_end(&mut text);
        String::from_utf8_lossy(&text).into_owned()
    });
    let (done, finished) = oneshot::channel();
    let running = Arc::clone(&child);
    thread::spawn(move || {
        let mut stopped = false;
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = String::from_utf8_lossy(&line);
            let text = text.strip_suffix('\n').unwrap_or(&text);
            let text = text.strip_suffix('\r').unwrap_or(text);
            if !handler.line(text) {
                stopped = true;
                kill(&running);
                break;
            }
        }
        let code = running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .wait()
            .ok()
            .and_then(|status| status.code());
        let stderr = errors.join().unwrap_or_default();
        let _ = done.send(Finished {
            handler,
            stderr,
            code,
            stopped,
        });
    });

    let aborted = Box::pin(signal.aborted());
    match select(finished, aborted).await {
        Either::Left((Ok(finished), _)) => {
            if signal.is_aborted() {
                return Err(RunError::Aborted);
            }
            Ok(finished)
        }
        Either::Left((Err(_), _)) | Either::Right(_) => {
            kill(&child);
            Err(RunError::Aborted)
        }
    }
}
