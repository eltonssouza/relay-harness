//! Tool paths as `path-utils.ts` and `utils/paths.ts` resolve them: unicode spaces and a leading
//! `@` cleaned up, `~` and Git Bash drive paths expanded, then Node's `path.resolve` against the
//! working directory. Reads also try the names macOS gives screenshots.

use std::path::Path;

use unicode_normalization::UnicodeNormalization;

/// The unicode spaces `normalizePath` turns into plain spaces.
fn is_unicode_space(character: char) -> bool {
    matches!(
        character,
        '\u{00A0}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}'
    )
}

/// Git Bash, MSYS, Cygwin and WSL drive paths (`/c/x`, `/mnt/c/x`, `/cygdrive/c/x`) as Windows
/// writes them (`normalizeWindowsShellPath`).
pub fn normalize_windows_shell_path(path: &str) -> String {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return path.to_string();
    }
    let rest = &path[1..];
    let rest = rest
        .strip_prefix("mnt/")
        .or_else(|| rest.strip_prefix("cygdrive/"))
        .unwrap_or(rest);
    let mut characters = rest.chars();
    let Some(drive) = characters.next().filter(char::is_ascii_alphabetic) else {
        return path.to_string();
    };
    let after = characters.as_str();
    let suffix = match after {
        "" => "",
        _ => match after.strip_prefix('/') {
            Some(suffix) => suffix,
            None => return path.to_string(),
        },
    };
    format!(
        "{}:\\{}",
        drive.to_ascii_uppercase(),
        suffix.replace('/', "\\")
    )
}

/// How an input path is cleaned up (`PathInputOptions`).
#[derive(Debug, Clone, Default)]
pub struct PathInput<'a> {
    pub normalize_unicode_spaces: bool,
    pub strip_at_prefix: bool,
    /// For `~`; none skips the expansion.
    pub home: Option<&'a str>,
    pub windows: bool,
}

/// `normalizePath`.
pub fn normalize_path(input: &str, options: &PathInput<'_>) -> String {
    let mut normalized: String = if options.normalize_unicode_spaces {
        input
            .chars()
            .map(|character| {
                if is_unicode_space(character) {
                    ' '
                } else {
                    character
                }
            })
            .collect()
    } else {
        input.to_string()
    };
    if options.strip_at_prefix {
        if let Some(rest) = normalized.strip_prefix('@') {
            normalized = rest.to_string();
        }
    }
    if options.windows {
        normalized = normalize_windows_shell_path(&normalized);
    }
    if let Some(home) = options.home {
        if normalized == "~" {
            return home.to_string();
        }
        let rest = normalized.strip_prefix("~/").or_else(|| {
            options
                .windows
                .then(|| normalized.strip_prefix("~\\"))
                .flatten()
        });
        if let Some(rest) = rest {
            return join(home, rest, options.windows);
        }
    }
    if let Some(url) = normalized.strip_prefix("file://") {
        return file_url_path(url, options.windows);
    }
    normalized
}

/// `fileURLToPath` for `file://` URLs without a host: percent-decoded; a drive path on Windows.
fn file_url_path(rest: &str, windows: bool) -> String {
    let path = rest.strip_prefix("localhost").unwrap_or(rest);
    let mut bytes = Vec::with_capacity(path.len());
    let raw = path.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        let hex = |at: usize| (raw[at] as char).to_digit(16);
        if raw[index] == b'%' && index + 2 < raw.len() {
            if let (Some(high), Some(low)) = (hex(index + 1), hex(index + 2)) {
                bytes.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        bytes.push(raw[index]);
        index += 1;
    }
    let decoded = String::from_utf8_lossy(&bytes).into_owned();
    if windows {
        let trimmed = decoded.strip_prefix('/').unwrap_or(&decoded);
        trimmed.replace('/', "\\")
    } else {
        decoded
    }
}

fn join(base: &str, rest: &str, windows: bool) -> String {
    resolve_lexically(&[base, rest], windows)
}

/// The root of a Windows path (`C:\`, `\\server\share\`, `\`) and the rest.
fn windows_root(path: &str) -> (String, &str) {
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        if bytes.len() >= 3 && (bytes[2] == b'\\' || bytes[2] == b'/') {
            return (format!("{}\\", &path[..2]), &path[3..]);
        }
        return (path[..2].to_string(), &path[2..]);
    }
    let is_separator = |byte: u8| byte == b'\\' || byte == b'/';
    if bytes.len() >= 2 && is_separator(bytes[0]) && is_separator(bytes[1]) {
        let parts: Vec<&str> = path[2..].splitn(3, ['\\', '/']).collect();
        if parts.len() >= 2 && !parts[0].is_empty() && !parts[1].is_empty() {
            let root = format!("\\\\{}\\{}\\", parts[0], parts[1]);
            let rest = parts.get(2).copied().unwrap_or("");
            return (root, rest);
        }
    }
    if !bytes.is_empty() && is_separator(bytes[0]) {
        return ("\\".to_string(), &path[1..]);
    }
    (String::new(), path)
}

fn is_absolute(path: &str, windows: bool) -> bool {
    if windows {
        let (root, _) = windows_root(path);
        root.ends_with('\\')
    } else {
        path.starts_with('/')
    }
}

/// Node's `path.resolve(...segments)`: from the process's working directory.
pub fn node_resolve(segments: &[&str], windows: bool) -> String {
    let process = std::env::current_dir()
        .map(|cwd| cwd.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut all = vec![process.as_str()];
    all.extend_from_slice(segments);
    resolve_lexically(&all, windows)
}

/// Node's `path.join(dir, name)` for a file name in a directory: an absolute directory is
/// normalized as `path.resolve` does; a relative one keeps its leading `..`.
pub fn node_join(dir: &str, name: &str, windows: bool) -> String {
    if is_absolute(dir, windows) {
        return resolve_lexically(&[dir, name], windows);
    }
    let separator = if windows { "\\" } else { "/" };
    let mut parts: Vec<&str> = Vec::new();
    for part in dir
        .split(|character| character == '/' || (windows && character == '\\'))
        .chain(name.split(|character| character == '/' || (windows && character == '\\')))
    {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join(separator)
    }
}

/// Node's `path.resolve` over `segments`, right to left until a path is absolute, then
/// normalized: `.` and `..` resolved, separators collapsed, no trailing separator.
fn resolve_lexically(segments: &[&str], windows: bool) -> String {
    let mut start = 0;
    for (index, segment) in segments.iter().enumerate().rev() {
        if is_absolute(segment, windows) {
            start = index;
            break;
        }
    }
    if windows {
        let (mut root, first_rest) = windows_root(segments[start]);
        // A root without a drive takes the drive of the base before it.
        if root == "\\" && start > 0 {
            let (base_root, _) = windows_root(segments[start - 1]);
            if base_root.len() == 3 {
                root = base_root;
            }
        }
        let mut parts: Vec<&str> = Vec::new();
        let rests = std::iter::once(first_rest).chain(segments[start + 1..].iter().copied());
        for rest in rests {
            for part in rest.split(['\\', '/']) {
                match part {
                    "" | "." => {}
                    ".." => {
                        parts.pop();
                    }
                    part => parts.push(part),
                }
            }
        }
        format!("{root}{}", parts.join("\\"))
    } else {
        let mut parts: Vec<&str> = Vec::new();
        for segment in &segments[start..] {
            for part in segment.split('/') {
                match part {
                    "" | "." => {}
                    ".." => {
                        parts.pop();
                    }
                    part => parts.push(part),
                }
            }
        }
        format!("/{}", parts.join("/"))
    }
}

/// `resolvePath`: the input cleaned up, then resolved against `base`.
pub fn resolve_path(input: &str, base: &str, options: &PathInput<'_>) -> String {
    let normalized = normalize_path(input, options);
    let base_options = PathInput {
        home: options.home,
        windows: options.windows,
        ..PathInput::default()
    };
    let base = normalize_path(base, &base_options);
    if is_absolute(&normalized, options.windows) {
        // `path.resolve` alone: a Windows root without a drive takes the drive of the process's
        // working directory, not the base's.
        let process = std::env::current_dir()
            .map(|cwd| cwd.to_string_lossy().into_owned())
            .unwrap_or_default();
        resolve_lexically(&[&process, &normalized], options.windows)
    } else {
        resolve_lexically(&[&base, &normalized], options.windows)
    }
}

/// The input options the tools use, for this platform: unicode spaces and `@` cleaned up.
pub fn tool_path_input(home: Option<&str>) -> PathInput<'_> {
    PathInput {
        normalize_unicode_spaces: true,
        strip_at_prefix: true,
        home,
        windows: cfg!(windows),
    }
}

/// `resolveToCwd`.
pub fn resolve_to_cwd(path: &str, cwd: &str, home: Option<&str>) -> String {
    resolve_path(path, cwd, &tool_path_input(home))
}

/// The home directory, as Node's `os.homedir()` finds it.
pub fn home_dir() -> Option<String> {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(variable).ok().filter(|home| !home.is_empty())
}

fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

/// `tryMacOSScreenshotPath`: a narrow no-break space before ` AM.` and ` PM.`.
fn screenshot_variant(path: &str) -> String {
    let mut result = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(index) = rest.find(' ') {
        let after = &rest[index + 1..];
        let marker = after.get(..3).filter(|marker| {
            let lower = marker.to_ascii_lowercase();
            lower == "am." || lower == "pm."
        });
        result.push_str(&rest[..index]);
        match marker {
            Some(marker) => {
                result.push('\u{202F}');
                result.push_str(marker);
                rest = &after[3..];
            }
            None => {
                result.push(' ');
                rest = after;
            }
        }
    }
    result.push_str(rest);
    result
}

/// `resolveReadPath`: the resolved path, or the first of the names macOS uses that exists (a
/// narrow no-break space in screenshot times, decomposed accents, a curly apostrophe).
pub fn resolve_read_path(path: &str, cwd: &str, home: Option<&str>) -> String {
    let resolved = resolve_to_cwd(path, cwd, home);
    if exists(&resolved) {
        return resolved;
    }
    let screenshot = screenshot_variant(&resolved);
    if screenshot != resolved && exists(&screenshot) {
        return screenshot;
    }
    let decomposed: String = resolved.nfd().collect();
    if decomposed != resolved && exists(&decomposed) {
        return decomposed;
    }
    let curly = resolved.replace('\'', "\u{2019}");
    if curly != resolved && exists(&curly) {
        return curly;
    }
    let decomposed_curly = decomposed.replace('\'', "\u{2019}");
    if decomposed_curly != resolved && exists(&decomposed_curly) {
        return decomposed_curly;
    }
    resolved
}

/// The parts of a resolved path after its root, and the root.
fn root_and_parts(path: &str, windows: bool) -> (String, Vec<String>) {
    if windows {
        let (root, rest) = windows_root(path);
        let parts = rest
            .split(['\\', '/'])
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect();
        (root, parts)
    } else {
        let parts = path
            .split('/')
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect();
        ("/".to_string(), parts)
    }
}

/// Node's `path.relative(from, to)` for resolved paths: case-insensitive on Windows, where a
/// path on another drive comes back as it is.
pub fn relative(from: &str, to: &str, windows: bool) -> String {
    let from = resolve_lexically(&[from], windows);
    let to = resolve_lexically(&[to], windows);
    let (from_root, from_parts) = root_and_parts(&from, windows);
    let (to_root, to_parts) = root_and_parts(&to, windows);
    let same = |a: &str, b: &str| {
        if windows {
            a.to_lowercase() == b.to_lowercase()
        } else {
            a == b
        }
    };
    if !same(&from_root, &to_root) {
        return to;
    }
    let common = from_parts
        .iter()
        .zip(&to_parts)
        .take_while(|(a, b)| same(a, b))
        .count();
    let separator = if windows { "\\" } else { "/" };
    let mut parts: Vec<&str> = vec![".."; from_parts.len() - common];
    parts.extend(to_parts[common..].iter().map(String::as_str));
    parts.join(separator)
}

/// Node's `path.basename`: the last part, without trailing separators.
pub fn basename(path: &str, windows: bool) -> String {
    let separators: &[char] = if windows { &['\\', '/'] } else { &['/'] };
    let trimmed = path.trim_end_matches(separators);
    let start = trimmed.rfind(separators).map_or(0, |index| index + 1);
    let name = &trimmed[start..];
    if windows && start == 0 && name.len() == 2 && name.ends_with(':') {
        return String::new();
    }
    name.to_string()
}

/// Node's `path.dirname` for a resolved path: the root is its own parent.
pub fn dirname(path: &str, windows: bool) -> String {
    let (root, parts) = root_and_parts(path, windows);
    if parts.len() <= 1 {
        return if root.is_empty() { ".".into() } else { root };
    }
    let separator = if windows { "\\" } else { "/" };
    format!("{root}{}", parts[..parts.len() - 1].join(separator))
}

/// Whether a path is absolute on this kind of system.
pub fn is_absolute_path(path: &str, windows: bool) -> bool {
    is_absolute(path, windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_as_node_does() {
        let posix = PathInput::default();
        assert_eq!(resolve_path("a/../b/./c/", "/root", &posix), "/root/b/c");
        assert_eq!(resolve_path("/x//y/..", "/root", &posix), "/x");
        assert_eq!(resolve_path("..", "/", &posix), "/");
        let windows = PathInput {
            windows: true,
            ..PathInput::default()
        };
        assert_eq!(resolve_path("a/b", "C:\\root", &windows), "C:\\root\\a\\b");
        // A root without a drive takes the drive of a relative base's join, as `path.resolve` does.
        assert_eq!(resolve_lexically(&["D:\\root", "\\x"], true), "D:\\x");
        assert_eq!(
            resolve_path("/c/work/app", "D:\\root", &windows),
            "C:\\work\\app"
        );
        assert_eq!(resolve_path("..\\..\\..", "C:\\a", &windows), "C:\\");
        assert_eq!(relative("C:\\Root", "c:\\root\\a\\b.ts", true), "a\\b.ts");
        assert_eq!(relative("/r/s", "/r/t/u", false), "../t/u");
        assert_eq!(basename("C:\\x\\y.ts", true), "y.ts");
        assert_eq!(dirname("/a/b", false), "/a");
        assert_eq!(dirname("/a", false), "/");
        assert_eq!(dirname("C:\\a", true), "C:\\");
        let home = PathInput {
            home: Some("/home/me"),
            ..PathInput::default()
        };
        assert_eq!(resolve_path("~/notes", "/root", &home), "/home/me/notes");
        assert_eq!(
            screenshot_variant("/x/Shot at 1.00 PM.png"),
            "/x/Shot at 1.00\u{202F}PM.png"
        );
    }
}
