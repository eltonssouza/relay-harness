//! `ensure_tool` against a local HTTP server standing in for GitHub: the version from the
//! `/releases/latest` redirect, the archive download with its retries, extraction with the
//! system's tools, and the status messages `ensureTool` reports. Nothing reaches GitHub.
//!
//! The archive is the running system's kind (zip on Windows, tar.gz elsewhere), made with the
//! system's `tar`, since the TypeScript agent extracts each kind only where its assets use it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use relay_tools::tools_manager::ToolStatusKind::{Info, Warning};
use relay_tools::tools_manager::{ensure_tool, node_platform, ToolDownloads, ToolStatus};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// One scripted answer.
#[derive(Clone)]
struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn reply(status: u16) -> Reply {
    Reply {
        status,
        headers: Vec::new(),
        body: Vec::new(),
    }
}

fn redirect(location: &str) -> Reply {
    Reply {
        status: 302,
        headers: vec![("location".into(), location.into())],
        body: Vec::new(),
    }
}

fn body(bytes: Vec<u8>) -> Reply {
    Reply {
        status: 200,
        headers: Vec::new(),
        body: bytes,
    }
}

/// Each path's answers.
type Script = Vec<(String, Vec<Reply>)>;

/// The requests received: path and user agent.
type Log = Arc<Mutex<Vec<(String, Option<String>)>>>;

/// Answers each path from its script in order; the last answer repeats. Unknown paths get 404.
async fn serve(script: Script) -> (String, Log) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let script: Arc<Mutex<HashMap<String, Vec<Reply>>>> =
        Arc::new(Mutex::new(script.into_iter().collect()));
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let received = log.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let script = script.clone();
            let received = received.clone();
            tokio::spawn(async move {
                let mut data = Vec::new();
                let mut buffer = [0u8; 4096];
                while !data.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut buffer).await {
                        Ok(0) | Err(_) => return,
                        Ok(read) => data.extend_from_slice(&buffer[..read]),
                    }
                }
                let head = String::from_utf8_lossy(&data).into_owned();
                let path = head.split(' ').nth(1).unwrap_or_default().to_string();
                let agent = head.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("user-agent")
                        .then(|| value.trim().to_string())
                });
                received.lock().unwrap().push((path.clone(), agent));
                let answer = {
                    let mut script = script.lock().unwrap();
                    match script.get_mut(&path) {
                        Some(replies) if replies.len() > 1 => replies.remove(0),
                        Some(replies) => replies[0].clone(),
                        None => reply(404),
                    }
                };
                let mut head = format!(
                    "HTTP/1.1 {} Scripted\r\ncontent-length: {}\r\nconnection: close\r\n",
                    answer.status,
                    answer.body.len()
                );
                for (name, value) in &answer.headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(&answer.body).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    (origin, log)
}

/// A fresh directory, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "relay-download-{label}-{}-{nanos}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn windows() -> bool {
    node_platform() == "win32"
}

fn exe(name: &str) -> String {
    if windows() {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// The asset name for the running system on x64.
fn asset(stem: &str, version: &str) -> String {
    let target = match node_platform() {
        "win32" => "x86_64-pc-windows-msvc.zip",
        "darwin" => "x86_64-apple-darwin.tar.gz",
        _ => "x86_64-unknown-linux-musl.tar.gz",
    };
    format!("{stem}{version}-{target}")
}

/// An archive of the running system's kind holding `files` (path, contents).
fn archive(name: &str, files: &[(&str, &str)]) -> Vec<u8> {
    let staging = TempDir::new("staging");
    for (path, contents) in files {
        let path = staging.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }
    let output = TempDir::new("archive");
    let target = output.0.join(name);
    let top: Vec<String> = fs::read_dir(&staging.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    let status = if windows() {
        let tar = Path::new(&std::env::var("SystemRoot").unwrap())
            .join("System32")
            .join("tar.exe");
        Command::new(tar)
            .arg("-a")
            .arg("-cf")
            .arg(&target)
            .arg("-C")
            .arg(&staging.0)
            .args(&top)
            .status()
            .unwrap()
    } else {
        Command::new("tar")
            .arg("czf")
            .arg(&target)
            .arg("-C")
            .arg(&staging.0)
            .args(&top)
            .status()
            .unwrap()
    };
    assert!(status.success());
    fs::read(target).unwrap()
}

fn downloads(origin: &str, bin: &TempDir) -> ToolDownloads {
    ToolDownloads {
        origin: origin.to_string(),
        bin_dir: Some(bin.path()),
        search_path: false,
        offline: false,
        platform: node_platform().to_string(),
        arch: "x64".to_string(),
    }
}

async fn ensure(tool: &str, downloads: &ToolDownloads) -> (Option<String>, Vec<ToolStatus>) {
    let statuses = Mutex::new(Vec::new());
    let on_status = |status: ToolStatus| statuses.lock().unwrap().push(status);
    let path = ensure_tool(tool, downloads, Some(&on_status)).await;
    (path, statuses.into_inner().unwrap())
}

fn status(kind: relay_tools::tools_manager::ToolStatusKind, message: &str) -> ToolStatus {
    ToolStatus {
        kind,
        message: message.to_string(),
    }
}

fn entries(dir: &TempDir) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(&dir.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn paths(log: &Log) -> Vec<String> {
    log.lock()
        .unwrap()
        .iter()
        .map(|(path, _)| path.clone())
        .collect()
}

#[tokio::test]
async fn downloads_the_latest_release_into_the_binary_directory() {
    let asset = asset("fd-v", "10.9.0");
    let stem = asset
        .trim_end_matches(".zip")
        .trim_end_matches(".tar.gz")
        .to_string();
    let bytes = archive(
        &asset,
        &[
            (&format!("{stem}/{}", exe("fd")), "the fd binary"),
            (&format!("{stem}/README.md"), "readme"),
        ],
    );
    let (origin, log) = serve(vec![
        (
            "/sharkdp/fd/releases/latest".into(),
            vec![redirect("/sharkdp/fd/releases/tag/v10.9.0")],
        ),
        (
            format!("/sharkdp/fd/releases/download/v10.9.0/{asset}"),
            vec![body(bytes)],
        ),
    ])
    .await;
    let bin = TempDir::new("bin");
    let (path, statuses) = ensure("fd", &downloads(&origin, &bin)).await;
    let binary = bin.0.join(exe("fd")).to_string_lossy().into_owned();
    assert_eq!(path.as_deref(), Some(binary.as_str()));
    assert_eq!(fs::read_to_string(&binary).unwrap(), "the fd binary");
    assert_eq!(
        statuses,
        vec![
            status(Info, "fd not found. Downloading..."),
            status(Info, &format!("fd installed to {binary}")),
        ]
    );
    // The archive and the extraction directory are gone.
    assert_eq!(entries(&bin), vec![exe("fd")]);
    let log = log.lock().unwrap().clone();
    assert_eq!(
        log[0],
        (
            "/sharkdp/fd/releases/latest".to_string(),
            Some("relay-coding-agent".to_string())
        )
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&binary).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    // Once installed, it is found without a request.
    let (again, statuses) = ensure("fd", &downloads(&origin, &bin)).await;
    assert_eq!(again.as_deref(), Some(binary.as_str()));
    assert!(statuses.is_empty());
}

#[tokio::test]
async fn finds_a_binary_anywhere_in_the_archive_and_retries_transient_failures() {
    let asset = asset("ripgrep-", "14.1.1");
    let bytes = archive(&asset, &[(&format!("nested/deeper/{}", exe("rg")), "rg")]);
    let (origin, log) = serve(vec![
        (
            "/BurntSushi/ripgrep/releases/latest".into(),
            vec![
                reply(503),
                reply(429),
                redirect("https://github.com/BurntSushi/ripgrep/releases/tag/14.1.1"),
            ],
        ),
        (
            format!("/BurntSushi/ripgrep/releases/download/14.1.1/{asset}"),
            vec![reply(500), body(bytes)],
        ),
    ])
    .await;
    let bin = TempDir::new("bin");
    let (path, statuses) = ensure("rg", &downloads(&origin, &bin)).await;
    assert_eq!(
        path,
        Some(bin.0.join(exe("rg")).to_string_lossy().into_owned()),
        "{statuses:?}"
    );
    assert_eq!(
        statuses[0],
        status(Info, "ripgrep not found. Downloading...")
    );
    assert_eq!(paths(&log).len(), 5);
}

#[tokio::test]
async fn reports_why_a_download_failed() {
    let fd_asset = asset("fd-v", "10.9.0");
    let download = format!("/sharkdp/fd/releases/download/v10.9.0/{fd_asset}");
    let latest = "/sharkdp/fd/releases/latest".to_string();
    let cases: Vec<(&str, Script, String)> = vec![
        (
            "retries run out",
            vec![(latest.clone(), vec![reply(503)])],
            "Failed to download fd: Failed to resolve latest sharkdp/fd release: HTTP 503 without redirect".into(),
        ),
        (
            "no redirect",
            vec![(latest.clone(), vec![reply(200)])],
            "Failed to download fd: Failed to resolve latest sharkdp/fd release: HTTP 200 without redirect".into(),
        ),
        (
            "unexpected redirect",
            vec![(latest.clone(), vec![redirect("/sharkdp/fd/releases")])],
            "Failed to download fd: Failed to resolve latest sharkdp/fd release: unexpected redirect to /sharkdp/fd/releases".into(),
        ),
        (
            "missing asset",
            vec![
                (latest.clone(), vec![redirect("/sharkdp/fd/releases/tag/v10.9.0")]),
                (download.clone(), vec![reply(404)]),
            ],
            "Failed to download fd: Download failed with HTTP 404: <origin>".to_string() + &download,
        ),
    ];
    for (name, script, expected) in cases {
        let (origin, _) = serve(script).await;
        let bin = TempDir::new("bin");
        let (path, statuses) = ensure("fd", &downloads(&origin, &bin)).await;
        assert_eq!(path, None, "{name}");
        assert_eq!(
            statuses,
            vec![
                status(Info, "fd not found. Downloading..."),
                status(Warning, &expected.replace("<origin>", &origin)),
            ],
            "{name}"
        );
        // Nothing is left behind.
        assert!(entries(&bin).is_empty(), "{name}: {:?}", entries(&bin));
    }
}

#[tokio::test]
async fn an_archive_without_the_binary_fails_and_is_removed() {
    let asset = asset("fd-v", "10.9.0");
    let bytes = archive(&asset, &[("other/file.txt", "not fd")]);
    let (origin, _) = serve(vec![
        (
            "/sharkdp/fd/releases/latest".into(),
            vec![redirect("/sharkdp/fd/releases/tag/v10.9.0")],
        ),
        (
            format!("/sharkdp/fd/releases/download/v10.9.0/{asset}"),
            vec![body(bytes)],
        ),
    ])
    .await;
    let bin = TempDir::new("bin");
    let (path, statuses) = ensure("fd", &downloads(&origin, &bin)).await;
    assert_eq!(path, None);
    let prefix = format!(
        "Failed to download fd: Binary not found in archive: expected {} under {}",
        exe("fd"),
        bin.0.join("extract_tmp_fd_").to_string_lossy()
    );
    assert!(
        statuses[1].message.starts_with(&prefix),
        "{}",
        statuses[1].message
    );
    assert!(entries(&bin).is_empty(), "{:?}", entries(&bin));
}

#[tokio::test]
async fn pins_fd_on_intel_macs_and_decodes_tags() {
    // fd on darwin/x64 skips the version lookup.
    let (origin, log) = serve(Vec::new()).await;
    let bin = TempDir::new("bin");
    let mut options = downloads(&origin, &bin);
    options.platform = "darwin".into();
    ensure("fd", &options).await;
    assert_eq!(
        paths(&log),
        vec!["/sharkdp/fd/releases/download/v10.3.0/fd-v10.3.0-x86_64-apple-darwin.tar.gz"]
    );

    let (origin, log) = serve(vec![(
        "/sharkdp/fd/releases/latest".into(),
        vec![redirect("/sharkdp/fd/releases/tag/v1%2E2")],
    )])
    .await;
    let mut options = downloads(&origin, &bin);
    options.platform = "linux".into();
    options.arch = "arm64".into();
    ensure("fd", &options).await;
    assert_eq!(
        paths(&log)[1],
        "/sharkdp/fd/releases/download/v1.2/fd-v1.2-aarch64-unknown-linux-musl.tar.gz"
    );
}

#[tokio::test]
async fn skips_the_download_offline_on_android_and_on_unknown_platforms() {
    let (origin, log) = serve(vec![(
        "/sharkdp/fd/releases/latest".into(),
        vec![redirect("/sharkdp/fd/releases/tag/v10.9.0")],
    )])
    .await;
    let bin = TempDir::new("bin");

    let mut offline = downloads(&origin, &bin);
    offline.offline = true;
    let (path, statuses) = ensure("fd", &offline).await;
    assert_eq!(path, None);
    assert_eq!(
        statuses,
        vec![status(
            Warning,
            "fd not found. Offline mode enabled, skipping download."
        )]
    );

    let mut android = downloads(&origin, &bin);
    android.platform = "android".into();
    assert_eq!(
        ensure("rg", &android).await.1,
        vec![status(
            Warning,
            "ripgrep not found. Install with: pkg install ripgrep"
        )]
    );
    assert_eq!(
        ensure("fd", &android).await.1,
        vec![status(
            Warning,
            "fd not found. Install with: pkg install fd"
        )]
    );
    assert!(paths(&log).is_empty());

    let mut unknown = downloads(&origin, &bin);
    unknown.platform = "freebsd".into();
    assert_eq!(
        ensure("fd", &unknown).await.1[1],
        status(
            Warning,
            "Failed to download fd: Unsupported platform: freebsd/x64"
        )
    );
    assert_eq!(ensure("nothing", &unknown).await, (None, Vec::new()));
}

#[tokio::test]
async fn a_refused_connection_is_a_fetch_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let bin = TempDir::new("bin");
    let (path, statuses) = ensure("fd", &downloads(&origin, &bin)).await;
    assert_eq!(path, None);
    assert!(
        statuses[1]
            .message
            .starts_with("Failed to download fd: fetch failed: "),
        "{}",
        statuses[1].message
    );
}
