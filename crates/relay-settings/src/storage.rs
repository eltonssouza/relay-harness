//! Where settings live (`SettingsStorage`): `settings.json` in the agent directory and in the
//! project's `.relay` directory, read and written under the lock `proper-lockfile` takes, or in
//! memory.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// Which settings file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SettingsScope {
    Global,
    Project,
}

impl SettingsScope {
    pub fn name(self) -> &'static str {
        match self {
            SettingsScope::Global => "global",
            SettingsScope::Project => "project",
        }
    }
}

/// Why reading or writing settings failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageError {
    pub message: String,
    /// A JSON syntax error, which V8 words differently.
    pub syntax: bool,
}

impl StorageError {
    pub fn new(message: impl Into<String>) -> Self {
        StorageError {
            message: message.into(),
            syntax: false,
        }
    }
}

/// Gets a scope's current text, if any, and returns its new text, or `None` to leave it.
pub type Change<'a> = dyn FnMut(Option<&str>) -> Result<Option<String>, StorageError> + 'a;

/// A read-modify-write of one scope's text: `change` gets the current text, if any, and returns
/// the new text, or `None` to leave it (`SettingsStorage.withLock`).
pub trait SettingsStorage: Send + Sync {
    fn with_lock(&self, scope: SettingsScope, change: &mut Change<'_>) -> Result<(), StorageError>;
}

/// How long a lock stands before it is taken over (`proper-lockfile`'s default `stale`).
const STALE: Duration = Duration::from_secs(10);
/// Attempts at a held lock, and the pause between them.
const ATTEMPTS: u32 = 10;
const PAUSE: Duration = Duration::from_millis(20);

/// The two settings files (`FileSettingsStorage`).
#[derive(Debug, Clone)]
pub struct FileSettingsStorage {
    global: PathBuf,
    project: PathBuf,
}

impl FileSettingsStorage {
    pub fn new(global: PathBuf, project: PathBuf) -> Self {
        FileSettingsStorage { global, project }
    }

    pub fn path(&self, scope: SettingsScope) -> &Path {
        match scope {
            SettingsScope::Global => &self.global,
            SettingsScope::Project => &self.project,
        }
    }
}

fn lock(path: &Path) -> Result<relay_ai::auth_file::FileLock, StorageError> {
    relay_ai::auth_file::lock_file(path, STALE, ATTEMPTS, PAUSE).map_err(|error| {
        if error.starts_with("Lock file is already being held") {
            StorageError::new("Lock file is already being held")
        } else {
            StorageError::new(error)
        }
    })
}

fn fs_error(error: &std::io::Error, syscall: &str, path: &Path) -> StorageError {
    StorageError::new(relay_tools::js::fs_error(
        error,
        syscall,
        &path.to_string_lossy(),
    ))
}

impl SettingsStorage for FileSettingsStorage {
    fn with_lock(&self, scope: SettingsScope, change: &mut Change<'_>) -> Result<(), StorageError> {
        let path = self.path(scope);
        // The lock is taken only for a file that exists or is about to be written.
        let exists = path.exists();
        let mut held = if exists { Some(lock(path)?) } else { None };
        let current = if exists {
            Some(fs::read_to_string(path).map_err(|error| fs_error(&error, "open", path))?)
        } else {
            None
        };
        let Some(next) = change(current.as_deref())? else {
            return Ok(());
        };
        if let Some(dir) = path.parent() {
            if !dir.exists() {
                fs::create_dir_all(dir).map_err(|error| fs_error(&error, "mkdir", dir))?;
            }
        }
        if held.is_none() {
            held = Some(lock(path)?);
        }
        fs::write(path, next).map_err(|error| fs_error(&error, "open", path))?;
        drop(held);
        Ok(())
    }
}

/// Settings held in memory (`InMemorySettingsStorage`).
#[derive(Debug, Default)]
pub struct InMemorySettingsStorage {
    global: Mutex<Option<String>>,
    project: Mutex<Option<String>>,
}

impl SettingsStorage for InMemorySettingsStorage {
    fn with_lock(&self, scope: SettingsScope, change: &mut Change<'_>) -> Result<(), StorageError> {
        let slot = match scope {
            SettingsScope::Global => &self.global,
            SettingsScope::Project => &self.project,
        };
        let mut slot = slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(next) = change(slot.as_deref())? {
            *slot = Some(next);
        }
        Ok(())
    }
}
