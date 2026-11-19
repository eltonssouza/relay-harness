//! `auth.json`, the credential store the coding agent keeps in its agent directory
//! (`packages/coding-agent/src/core/auth-storage.ts`): one credential per provider id.
//!
//! Every write is a read-modify-write under the lock `proper-lockfile` takes, so a Rust process
//! and a TypeScript one can share the file: the lock is the directory `auth.json.lock`, created
//! atomically, and a lock older than 30 seconds is stale and taken over. The lock is held only
//! while the file is read and rewritten. The file is written as `JSON.stringify(data, null, 2)`
//! writes it, other providers' entries untouched and in place; a new file gets mode 0600 and a
//! new directory 0700.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Map, Value};

use crate::auth::Credential;
use crate::config_value;

/// A lock this old belongs to a process that died; `proper-lockfile`'s `stale` for auth.json.
const STALE: Duration = Duration::from_secs(30);
/// How long to wait for another process's lock.
const WAIT: Duration = Duration::from_secs(30);

pub struct AuthFile {
    path: PathBuf,
}

/// The lock directory; removed when dropped.
struct Lock {
    path: PathBuf,
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.path);
    }
}

fn is_stale(lock: &Path, stale: Duration) -> bool {
    fs::metadata(lock)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > stale)
}

fn lock(file: &Path) -> Result<Lock, String> {
    lock_with(file, STALE, WAIT)
}

fn lock_with(file: &Path, stale: Duration, wait: Duration) -> Result<Lock, String> {
    let mut lock_path = file.as_os_str().to_owned();
    lock_path.push(".lock");
    let lock_path = PathBuf::from(lock_path);
    let deadline = Instant::now() + wait;
    let mut retry = 0u32;
    loop {
        match fs::create_dir(&lock_path) {
            Ok(()) => return Ok(Lock { path: lock_path }),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if is_stale(&lock_path, stale) {
                    let _ = fs::remove_dir(&lock_path);
                    continue;
                }
                if Instant::now() >= deadline {
                    return Err(format!(
                        "Lock file is already being held: {}",
                        lock_path.display()
                    ));
                }
                // 10 ms doubling to 1 s, as the TypeScript store backs off.
                let delay = Duration::from_millis((10u64 << retry.min(7)).min(1000));
                retry += 1;
                std::thread::sleep(delay.min(deadline - Instant::now()));
            }
            Err(error) => return Err(format!("{}: {error}", lock_path.display())),
        }
    }
}

#[cfg(unix)]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)
}

/// Write `text`; a new file gets mode 0600, an existing one keeps its mode and ACLs.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options.open(path)?.write_all(text.as_bytes())
}

fn parse(text: &str) -> Result<Map<String, Value>, String> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    if text.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str(text) {
        Ok(Value::Object(data)) => Ok(data),
        Ok(_) => Err("Invalid auth.json: expected an object".into()),
        Err(error) => Err(format!("Failed to read auth.json: {error}")),
    }
}

fn credential(provider: &str, value: &Value) -> Result<Credential, String> {
    serde_json::from_value(value.clone())
        .map_err(|_| format!("Invalid auth.json credential for provider \"{provider}\""))
}

/// `JSON.stringify(data, null, 2)`.
fn stringify(data: &Map<String, Value>) -> String {
    serde_json::to_string_pretty(data).unwrap_or_else(|_| "{}".into())
}

impl AuthFile {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        AuthFile { path: path.into() }
    }

    /// `auth.json` in an agent directory.
    pub fn in_agent_dir(agent_dir: &Path) -> Self {
        AuthFile::new(agent_dir.join("auth.json"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Every entry as stored; a missing file has none.
    pub fn read_all(&self) -> Result<Map<String, Value>, String> {
        match fs::read_to_string(&self.path) {
            Ok(text) => parse(&text),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Map::new()),
            Err(error) => Err(format!("Failed to read auth.json: {error}")),
        }
    }

    /// A provider's credential as stored, without resolving its key.
    pub fn read_stored(&self, provider: &str) -> Result<Option<Credential>, String> {
        self.read_all()?
            .get(provider)
            .map(|value| credential(provider, value))
            .transpose()
    }

    /// A provider's credential with its key resolved (`AuthStorage.read`): a `$VAR` template is
    /// substituted from the credential's env and the process environment, a `!command` runs.
    /// A key that resolves to nothing is removed.
    pub fn read(&self, provider: &str) -> Result<Option<Credential>, String> {
        let mut stored = self.read_stored(provider)?;
        if let Some(Credential::ApiKey(api_key)) = &mut stored {
            if let Some(key) = &api_key.key {
                api_key.key = config_value::resolve(key, api_key.env.as_ref());
            }
        }
        Ok(stored)
    }

    /// Each stored provider and its credential type, without resolving keys.
    pub fn list(&self) -> Result<Vec<(String, String)>, String> {
        Ok(self
            .read_all()?
            .iter()
            .map(|(provider, value)| {
                let kind = value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                (provider.clone(), kind.to_string())
            })
            .collect())
    }

    /// Lock, read, apply `change`, write: the only way to store a credential. `change` sees the
    /// stored credential (none when absent or unreadable) and returns the new one, or none to
    /// leave the entry as it is. Returns the credential stored afterwards.
    pub fn modify(
        &self,
        provider: &str,
        change: impl FnOnce(Option<Credential>) -> Result<Option<Credential>, String>,
    ) -> Result<Option<Credential>, String> {
        self.locked(|data| {
            let current = data
                .get(provider)
                .and_then(|value| credential(provider, value).ok());
            match change(current.clone())? {
                None => Ok((current, false)),
                Some(next) => {
                    let value = serde_json::to_value(&next).map_err(|error| error.to_string())?;
                    data.insert(provider.to_string(), value);
                    Ok((Some(next), true))
                }
            }
        })
    }

    /// Remove a provider's credential (logout).
    pub fn delete(&self, provider: &str) -> Result<(), String> {
        self.locked(|data| {
            data.shift_remove(provider);
            Ok(((), true))
        })
    }

    /// Run `apply` on the stored entries under the lock; it says whether to write them back.
    fn locked<T>(
        &self,
        apply: impl FnOnce(&mut Map<String, Value>) -> Result<(T, bool), String>,
    ) -> Result<T, String> {
        if let Some(directory) = self
            .path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            if !directory.exists() {
                create_private_dir(directory)
                    .map_err(|error| format!("{}: {error}", directory.display()))?;
            }
        }
        if !self.path.exists() {
            write_private(&self.path, "{}")
                .map_err(|error| format!("{}: {error}", self.path.display()))?;
        }
        let _lock = lock(&self.path)?;
        let mut data = self.read_all()?;
        let (result, write) = apply(&mut data)?;
        if write {
            write_private(&self.path, &stringify(&data))
                .map_err(|error| format!("{}: {error}", self.path.display()))?;
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("relay-auth-lock-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        directory.join("auth.json")
    }

    #[test]
    fn takes_over_a_stale_lock() {
        let file = scratch("stale");
        fs::create_dir(file.with_extension("json.lock")).unwrap();
        std::thread::sleep(Duration::from_millis(60));
        let lock = lock_with(&file, Duration::from_millis(20), Duration::from_millis(0)).unwrap();
        assert!(lock.path.exists());
        drop(lock);
        assert!(!file.with_extension("json.lock").exists());
    }

    #[test]
    fn waits_for_a_held_lock_then_gives_up() {
        let file = scratch("held");
        let held = lock(&file).unwrap();
        let error = lock_with(&file, STALE, Duration::from_millis(50))
            .err()
            .unwrap();
        assert!(
            error.starts_with("Lock file is already being held"),
            "{error}"
        );
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(held);
        });
        lock_with(&file, STALE, Duration::from_secs(5)).unwrap();
        releaser.join().unwrap();
    }
}
