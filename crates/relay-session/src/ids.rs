//! Session and entry ids: `uuidv7` (time-ordered, `utils/uuid.ts`) for sessions, and the first
//! eight hexadecimal digits of a random UUID for entries.

use std::sync::{Mutex, PoisonError};

use crate::date::now_ms;

const MAX_SEQUENCE: u64 = (1 << 41) - 1;

/// The generator's state: the last ordinary timestamp and the sequence, shared by the process
/// as the module state is in TypeScript.
static STATE: Mutex<(i64, Option<u64>)> = Mutex::new((-1, None));

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    getrandom::getrandom(&mut bytes).expect("the operating system's random source");
    bytes
}

/// A time-ordered UUIDv7 (`uuidv7()`): the millisecond time, then a 42-bit sequence that starts
/// at random and counts up, so ids made in the same millisecond still sort in creation order.
pub fn uuidv7() -> String {
    let mut bytes: [u8; 16] = random_bytes();
    let (timestamp, sequence) = {
        let mut state = STATE.lock().unwrap_or_else(PoisonError::into_inner);
        let timestamp = now_ms().max(state.0);
        state.0 = timestamp;
        let sequence = match state.1 {
            None => {
                (u64::from(bytes[1]) << 32)
                    | (u64::from(bytes[2]) << 24)
                    | (u64::from(bytes[3]) << 16)
                    | (u64::from(bytes[4]) << 8)
                    | u64::from(bytes[5])
            }
            Some(sequence) => {
                assert!(
                    sequence != MAX_SEQUENCE,
                    "UUIDv7 generator sequence exhausted"
                );
                sequence + 1
            }
        };
        state.1 = Some(sequence);
        (timestamp, sequence)
    };
    for (index, byte) in bytes.iter_mut().take(6).enumerate() {
        *byte = (timestamp >> ((5 - index) * 8)) as u8;
    }
    bytes[6] = 0x70 | ((sequence >> 37) & 0x0f) as u8;
    bytes[7] = ((sequence >> 29) & 0xff) as u8;
    bytes[8] = 0x80 | ((sequence >> 23) & 0x3f) as u8;
    bytes[9] = ((sequence >> 15) & 0xff) as u8;
    bytes[10] = ((sequence >> 7) & 0xff) as u8;
    bytes[11] = (((sequence & 0x7f) << 1) as u8) | (bytes[11] & 0x01);
    let hex: Vec<String> = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].concat(),
        hex[4..6].concat(),
        hex[6..8].concat(),
        hex[8..10].concat(),
        hex[10..].concat()
    )
}

/// A full random UUID (version 4), the fallback when short ids keep colliding.
fn random_uuid() -> String {
    let mut bytes: [u8; 16] = random_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// An unused short entry id (`generateId`): eight hexadecimal digits, checked against `taken`.
pub fn generate_id(taken: impl Fn(&str) -> bool) -> String {
    for _ in 0..100 {
        let bytes: [u8; 4] = random_bytes();
        let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        if !taken(&id) {
            return id;
        }
    }
    random_uuid()
}

/// Whether a session id is safe in a file name (`assertValidSessionId`).
pub fn assert_valid_session_id(id: &str) -> Result<(), String> {
    let bytes = id.as_bytes();
    let valid = !bytes.is_empty()
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err("Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_version_7_and_ordered() {
        let first = uuidv7();
        let second = uuidv7();
        assert_eq!(first.len(), 36);
        assert_eq!(&first[14..15], "7");
        assert!(matches!(&first[19..20], "8" | "9" | "a" | "b"));
        assert!(first < second, "{first} {second}");
    }
}
