//! Where grep and find get ripgrep and fd (`utils/tools-manager.ts`): Relay's own binary
//! directory first, then the system path, else the latest GitHub release, downloaded into
//! Relay's binary directory.
//!
//! The release version comes from the redirect of `/releases/latest`, which costs no API quota.
//! The archive is extracted with the system's tools, as the TypeScript agent does: `tar` for
//! `.tar.gz`; for `.zip`, Windows' `tar.exe` then PowerShell's `Expand-Archive`, else `unzip`
//! then `tar`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::redirect::Policy;
use reqwest::{Client, Response, Url};

use crate::paths::home_dir;
use crate::shell::hide_window;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(10);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// Attempts after the first (`fetchWithRetry`'s default).
const MAX_RETRIES: u32 = 2;
const RETRYABLE_STATUS_CODES: [u16; 7] = [408, 425, 429, 500, 502, 503, 504];
/// Node's message for a request its timeout signal aborted.
const TIMEOUT_MESSAGE: &str = "The operation was aborted due to timeout";
const USER_AGENT: &str = "relay-coding-agent";

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

/// A tool Relay can download (`ToolConfig`).
struct ToolConfig {
    /// For messages.
    name: &'static str,
    repo: &'static str,
    binary_name: &'static str,
    /// Command names to try on the path before downloading.
    system_names: &'static [&'static str],
    /// Before the version in the tag.
    tag_prefix: &'static str,
    /// The archive's name without the version and platform parts.
    asset_stem: &'static str,
}

const FD: ToolConfig = ToolConfig {
    name: "fd",
    repo: "sharkdp/fd",
    binary_name: "fd",
    system_names: &["fd", "fdfind"],
    tag_prefix: "v",
    asset_stem: "fd-v",
};

const RG: ToolConfig = ToolConfig {
    name: "ripgrep",
    repo: "BurntSushi/ripgrep",
    binary_name: "rg",
    system_names: &["rg"],
    tag_prefix: "",
    asset_stem: "ripgrep-",
};

fn config(tool: &str) -> Option<&'static ToolConfig> {
    match tool {
        "fd" => Some(&FD),
        "rg" => Some(&RG),
        _ => None,
    }
}

/// The platform as Node's `os.platform()` names it.
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// The architecture as Node's `os.arch()` names it.
pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "powerpc64" => "ppc64",
        other => other,
    }
}

/// The release archive for a platform (`getAssetName`).
fn asset_name(config: &ToolConfig, version: &str, platform: &str, arch: &str) -> Option<String> {
    let arch = if arch == "arm64" { "aarch64" } else { "x86_64" };
    let target = match platform {
        "darwin" => format!("{arch}-apple-darwin.tar.gz"),
        "linux" => format!("{arch}-unknown-linux-musl.tar.gz"),
        "win32" => format!("{arch}-pc-windows-msvc.zip"),
        _ => return None,
    };
    Some(format!("{}{version}-{target}", config.asset_stem))
}

/// Whether a command runs (`commandExists`): it starts with `--version`.
fn command_exists(command: &str) -> bool {
    let mut child = Command::new(command);
    child
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    child.status().is_ok()
}

fn binary_file_name(config: &ToolConfig, platform: &str) -> String {
    if platform == "win32" {
        format!("{}.exe", config.binary_name)
    } else {
        config.binary_name.to_string()
    }
}

/// Relay's binary directory (`getBinDir`).
pub fn bin_dir() -> Option<String> {
    agent_dir().map(|dir| Path::new(&dir).join("bin").to_string_lossy().into_owned())
}

/// A search tool's path in `bin_dir`, else its command name if it is on the path
/// (`getToolPath`).
fn find_tool(config: &ToolConfig, bin_dir: Option<&str>, search_path: bool) -> Option<String> {
    if let Some(dir) = bin_dir {
        let local = Path::new(dir).join(binary_file_name(config, node_platform()));
        if local.exists() {
            return Some(local.to_string_lossy().into_owned());
        }
    }
    if !search_path {
        return None;
    }
    config
        .system_names
        .iter()
        .find(|name| command_exists(name))
        .map(|name| name.to_string())
}

/// A search tool's path or command name, if it is installed (`getToolPath`).
pub fn tool_path(tool: &str) -> Option<String> {
    find_tool(config(tool)?, bin_dir().as_deref(), true)
}

/// How a status message reads (`ToolStatus.type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatusKind {
    Info,
    Warning,
}

/// Progress of `ensure_tool` (`ToolStatus`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolStatus {
    pub kind: ToolStatusKind,
    pub message: String,
}

/// Where `ensure_tool` looks and downloads. The default is the agent's: GitHub, Relay's binary
/// directory, the system path, and `RELAY_OFFLINE`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDownloads {
    /// The origin of the releases, `https://github.com`.
    pub origin: String,
    pub bin_dir: Option<String>,
    /// Look for the tool on the system path before downloading.
    pub search_path: bool,
    pub offline: bool,
    /// Node's names, as the asset names use them.
    pub platform: String,
    pub arch: String,
}

/// `RELAY_OFFLINE` is `1`, `true` or `yes`.
fn offline_mode() -> bool {
    std::env::var("RELAY_OFFLINE").is_ok_and(|value| {
        value == "1" || value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("yes")
    })
}

impl Default for ToolDownloads {
    fn default() -> Self {
        ToolDownloads {
            origin: "https://github.com".to_string(),
            bin_dir: bin_dir(),
            search_path: true,
            offline: offline_mode(),
            platform: node_platform().to_string(),
            arch: node_arch().to_string(),
        }
    }
}

/// The messages of an error and its causes, without repeats, as `ensureTool` joins them.
fn error_chain(error: &(dyn std::error::Error + 'static)) -> Vec<String> {
    let mut messages: Vec<String> = Vec::new();
    let mut current = Some(error);
    let mut depth = 0;
    while let (Some(error), true) = (current, depth < 5) {
        let message = error.to_string();
        if !messages.contains(&message) {
            messages.push(message);
        }
        current = error.source();
        depth += 1;
    }
    messages
}

/// A failed request as `fetch` reports it: a timeout's message, else `fetch failed` and why.
fn fetch_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return TIMEOUT_MESSAGE.to_string();
    }
    let mut messages = vec!["fetch failed".to_string()];
    for message in error_chain(error) {
        if !messages.contains(&message) {
            messages.push(message);
        }
    }
    messages.join(": ")
}

/// The client for downloads, which follows redirects.
fn download_client() -> Result<&'static Client, String> {
    relay_ai::http::client()
}

/// The client for the version lookup, which reads the redirect instead of following it.
fn lookup_client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    // The shared client installs the TLS provider.
    download_client()?;
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .redirect(Policy::none())
                .connect_timeout(NETWORK_TIMEOUT)
                .build()
                .map_err(|error| format!("Failed to create the HTTP client: {error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// A GET retried on transport failures and transient statuses, within one time budget
/// (`fetchWithRetry`).
async fn fetch_with_retry(
    client: &Client,
    url: &str,
    user_agent: bool,
    budget: Duration,
) -> Result<Response, String> {
    let deadline = Instant::now() + budget;
    for attempt in 0.. {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(TIMEOUT_MESSAGE.to_string());
        }
        let mut request = client.get(url).timeout(remaining);
        if user_agent {
            request = request.header("user-agent", USER_AGENT);
        }
        match request.send().await {
            Ok(response) => {
                let retry = RETRYABLE_STATUS_CODES.contains(&response.status().as_u16())
                    && attempt < MAX_RETRIES;
                if !retry {
                    return Ok(response);
                }
            }
            Err(error) => {
                if error.is_timeout() || attempt >= MAX_RETRIES {
                    return Err(fetch_error(&error));
                }
            }
        }
    }
    unreachable!("the loop returns")
}

/// `decodeURIComponent`.
fn decode_uri_component(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let byte = text
                .get(at + 1..at + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
                .ok_or("URI malformed")?;
            decoded.push(byte);
            at += 3;
        } else {
            decoded.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "URI malformed".to_string())
}

/// The latest release's version, from the redirect of `/releases/latest` (`getLatestVersion`).
async fn latest_version(origin: &str, repo: &str) -> Result<String, String> {
    let url = format!("{origin}/{repo}/releases/latest");
    let response = fetch_with_retry(lookup_client()?, &url, true, NETWORK_TIMEOUT).await?;
    let status = response.status().as_u16();
    let location = if (300..400).contains(&status) {
        response
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .filter(|location| !location.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    // Only the status and headers matter.
    drop(response);
    let Some(location) = location else {
        return Err(format!(
            "Failed to resolve latest {repo} release: HTTP {status} without redirect"
        ));
    };
    let base = Url::parse("https://github.com").expect("a valid URL");
    let tag = base
        .join(&location)
        .ok()
        .and_then(|url| url.path().rsplit('/').next().map(str::to_string))
        .filter(|tag| !tag.is_empty());
    let Some(tag) = tag.filter(|_| location.contains("/releases/tag/")) else {
        return Err(format!(
            "Failed to resolve latest {repo} release: unexpected redirect to {location}"
        ));
    };
    let tag = decode_uri_component(&tag)?;
    Ok(tag.strip_prefix('v').unwrap_or(&tag).to_string())
}

/// Downloads `url` to `dest` (`downloadFile`).
async fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    let mut response = fetch_with_retry(download_client()?, url, false, DOWNLOAD_TIMEOUT).await?;
    if !response.status().is_success() {
        return Err(format!(
            "Download failed with HTTP {}: {url}",
            response.status().as_u16()
        ));
    }
    let file_error =
        |error: std::io::Error| crate::js::fs_error(&error, "open", &dest.to_string_lossy());
    let mut file = fs::File::create(dest).map_err(file_error)?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| fetch_error(&error))?
    {
        file.write_all(&chunk).map_err(file_error)?;
    }
    Ok(())
}

/// Node's wording of a failed `spawnSync`: `spawnSync tar ENOENT`.
fn spawn_sync_error(command: &str, error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => format!("spawnSync {command} ENOENT"),
        std::io::ErrorKind::PermissionDenied => format!("spawnSync {command} EACCES"),
        _ => format!("spawnSync {command} {error}"),
    }
}

/// Runs an extraction command; the failure as `runExtractionCommand` words it.
fn run_extraction(command: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new(command);
    child.args(args).stdin(Stdio::null());
    hide_window(&mut child);
    let failure = match child.output() {
        Err(error) => spawn_sync_error(command, &error),
        Ok(output) if output.status.success() => return None,
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                match output.status.code() {
                    Some(code) => format!("exit status {code}"),
                    None => "exit status unknown".to_string(),
                }
            }
        }
    };
    Some(format!("{command}: {failure}"))
}

/// Windows' own `tar.exe` (bsdtar, which reads zip files), not Git Bash's GNU tar.
fn windows_tar() -> String {
    let root = std::env::var("SystemRoot")
        .ok()
        .or_else(|| std::env::var("WINDIR").ok())
        .filter(|root| !root.is_empty());
    if let Some(root) = root {
        let tar = Path::new(&root).join("System32").join("tar.exe");
        if tar.exists() {
            return tar.to_string_lossy().into_owned();
        }
    }
    "tar.exe".to_string()
}

fn extract_zip(archive: &str, dir: &str, asset: &str, windows: bool) -> Result<(), String> {
    let mut failures = Vec::new();
    if windows {
        match run_extraction(&windows_tar(), &["xf", archive, "-C", dir]) {
            None => return Ok(()),
            Some(failure) => failures.push(failure),
        }
        let script = "& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
        match run_extraction(
            "powershell.exe",
            &[
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
                archive,
                dir,
            ],
        ) {
            None => return Ok(()),
            Some(failure) => failures.push(failure),
        }
    } else {
        match run_extraction("unzip", &["-q", archive, "-d", dir]) {
            None => return Ok(()),
            Some(failure) => failures.push(failure),
        }
        match run_extraction("tar", &["xf", archive, "-C", dir]) {
            None => return Ok(()),
            Some(failure) => failures.push(failure),
        }
    }
    Err(format!(
        "Failed to extract {asset}: {}",
        failures.join("; ")
    ))
}

/// The first file named `name` under `root`, depth first as `findBinaryRecursively` searches.
fn find_binary(root: &Path, name: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_file() && entry.file_name() == name {
                return Some(path);
            }
            if kind.is_dir() {
                stack.push(path);
            }
        }
    }
    None
}

/// Eight random base-36 digits, for the extraction directory's name.
fn random_base36() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u32(std::process::id());
    let mut value = hasher.finish();
    let mut digits = String::new();
    for _ in 0..8 {
        digits.push(char::from_digit((value % 36) as u32, 36).expect("a base-36 digit"));
        value /= 36;
    }
    digits
}

/// Downloads and installs a tool into the binary directory (`downloadTool`).
async fn download_tool(config: &ToolConfig, downloads: &ToolDownloads) -> Result<String, String> {
    let platform = downloads.platform.as_str();
    let arch = downloads.arch.as_str();
    // fd is pinned on darwin/x64.
    let version = if config.binary_name == "fd" && platform == "darwin" && arch == "x64" {
        "10.3.0".to_string()
    } else {
        latest_version(&downloads.origin, config.repo).await?
    };
    let asset = asset_name(config, &version, platform, arch)
        .ok_or_else(|| format!("Unsupported platform: {platform}/{arch}"))?;
    let bin_dir = downloads
        .bin_dir
        .clone()
        .ok_or("Relay's binary directory is unknown: no home directory")?;
    let bin_dir = PathBuf::from(bin_dir);
    fs::create_dir_all(&bin_dir)
        .map_err(|error| crate::js::fs_error(&error, "mkdir", &bin_dir.to_string_lossy()))?;
    let url = format!(
        "{}/{}/releases/download/{}{version}/{asset}",
        downloads.origin, config.repo, config.tag_prefix
    );
    let archive = bin_dir.join(&asset);
    let binary_name = binary_file_name(config, platform);
    let binary = bin_dir.join(&binary_name);

    let result = async {
        download_file(&url, &archive).await?;
        // A directory of its own: fd and rg can download at the same time.
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|time| time.as_millis())
            .unwrap_or_default();
        let extract_dir = bin_dir.join(format!(
            "extract_tmp_{}_{}_{millis}_{}",
            config.binary_name,
            std::process::id(),
            random_base36()
        ));
        fs::create_dir_all(&extract_dir).map_err(|error| {
            crate::js::fs_error(&error, "mkdir", &extract_dir.to_string_lossy())
        })?;
        let extracted = (|| {
            let archive_text = archive.to_string_lossy();
            let dir_text = extract_dir.to_string_lossy();
            if asset.ends_with(".tar.gz") {
                if let Some(failure) =
                    run_extraction("tar", &["xzf", &archive_text, "-C", &dir_text])
                {
                    return Err(format!("Failed to extract {asset}: {failure}"));
                }
            } else if asset.ends_with(".zip") {
                // The extractors are the running system's, whatever the asset's platform.
                extract_zip(&archive_text, &dir_text, &asset, cfg!(windows))?;
            } else {
                return Err(format!("Unsupported archive format: {asset}"));
            }
            // Some archives hold the binary at the root, others under a versioned directory.
            let stem = asset
                .strip_suffix(".tar.gz")
                .or_else(|| asset.strip_suffix(".zip"))
                .unwrap_or(&asset);
            let candidates = [
                extract_dir.join(stem).join(&binary_name),
                extract_dir.join(&binary_name),
            ];
            let found = candidates
                .into_iter()
                .find(|candidate| candidate.exists())
                .or_else(|| find_binary(&extract_dir, &binary_name))
                .ok_or_else(|| {
                    format!(
                        "Binary not found in archive: expected {binary_name} under {}",
                        extract_dir.to_string_lossy()
                    )
                })?;
            fs::rename(&found, &binary)
                .map_err(|error| crate::js::fs_error(&error, "rename", &found.to_string_lossy()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).map_err(
                    |error| crate::js::fs_error(&error, "chmod", &binary.to_string_lossy()),
                )?;
            }
            Ok(())
        })();
        let _ = fs::remove_dir_all(&extract_dir);
        extracted
    }
    .await;
    let _ = fs::remove_file(&archive);
    result.map(|()| binary.to_string_lossy().into_owned())
}

/// A tool's path, downloading it when it is missing (`ensureTool`); `None` when it is
/// unavailable. Progress goes to `on_status`.
pub async fn ensure_tool(
    tool: &str,
    downloads: &ToolDownloads,
    on_status: Option<&(dyn Fn(ToolStatus) + Send + Sync)>,
) -> Option<String> {
    let config = config(tool)?;
    if let Some(path) = find_tool(config, downloads.bin_dir.as_deref(), downloads.search_path) {
        return Some(path);
    }
    let status = |kind, message: String| {
        if let Some(on_status) = on_status {
            on_status(ToolStatus { kind, message });
        }
    };
    if downloads.offline {
        status(
            ToolStatusKind::Warning,
            format!(
                "{} not found. Offline mode enabled, skipping download.",
                config.name
            ),
        );
        return None;
    }
    // Linux binaries do not run on Android's libc; Termux users install the package.
    if downloads.platform == "android" {
        let package = if tool == "rg" { "ripgrep" } else { tool };
        status(
            ToolStatusKind::Warning,
            format!(
                "{} not found. Install with: pkg install {package}",
                config.name
            ),
        );
        return None;
    }
    status(
        ToolStatusKind::Info,
        format!("{} not found. Downloading...", config.name),
    );
    match download_tool(config, downloads).await {
        Ok(path) => {
            status(
                ToolStatusKind::Info,
                format!("{} installed to {path}", config.name),
            );
            Some(path)
        }
        Err(message) => {
            status(
                ToolStatusKind::Warning,
                format!("Failed to download {}: {message}", config.name),
            );
            None
        }
    }
}
