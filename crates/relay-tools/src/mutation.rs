//! One change at a time per file (`file-mutation-queue.ts`): edits and writes to the same file,
//! by its real path, wait for each other; other files go on in parallel.

use std::collections::HashMap;
use std::fs;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

fn locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(Mutex::default)
}

/// The queue's key: the real path, or the path itself while the file does not exist.
fn key(path: &str) -> String {
    fs::canonicalize(path)
        .map(|real| real.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

/// Runs `change` while no other change to the same file runs.
pub fn with_file_lock<T>(path: &str, change: impl FnOnce() -> T) -> T {
    let lock = {
        let mut locks = locks().lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(locks.entry(key(path)).or_default())
    };
    let guard = lock.lock().unwrap_or_else(PoisonError::into_inner);
    let result = change();
    drop(guard);
    let mut locks = locks().lock().unwrap_or_else(PoisonError::into_inner);
    // The entry goes once nobody else holds or waits for it.
    if Arc::strong_count(&lock) == 2 {
        locks.remove(&key(path));
    }
    result
}
