//! Paths as `utils/paths.ts` resolves them with its default options: `~` expanded, Windows shell
//! paths (`/c/...`) converted, then Node's `path.resolve` from the process's directory.

use relay_tools::paths::{home_dir, node_join, normalize_path, resolve_path, PathInput};

fn with_options<T>(apply: impl FnOnce(&PathInput<'_>) -> T) -> T {
    let home = home_dir();
    apply(&PathInput {
        home: home.as_deref(),
        windows: cfg!(windows),
        ..PathInput::default()
    })
}

/// `normalizePath(input)`.
pub fn normalize(input: &str) -> String {
    with_options(|options| normalize_path(input, options))
}

/// `resolvePath(input)`, against the process's working directory.
pub fn resolve(input: &str) -> String {
    let process = std::env::current_dir()
        .map(|cwd| cwd.to_string_lossy().into_owned())
        .unwrap_or_default();
    with_options(|options| resolve_path(input, &process, options))
}

/// `path.join(dir, name)`.
pub fn join(dir: &str, name: &str) -> String {
    node_join(dir, name, cfg!(windows))
}
