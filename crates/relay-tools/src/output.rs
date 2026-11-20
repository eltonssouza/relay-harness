//! Streamed command output (`output-accumulator.ts`) and the files that keep it
//! (`utils/output-files.ts`).
//!
//! The accumulator decodes chunks as a streaming `TextDecoder` does (a character split between
//! chunks waits for its end, invalid bytes become U+FFFD, a leading BOM is dropped), keeps only a
//! tail of the text for the display snapshot, and moves the raw bytes to an output file once the
//! output is over a limit, so the model can read all of it.

use std::collections::hash_map::RandomState;
use std::fs::{File, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};

use crate::js::fs_error;
use crate::truncate::{
    truncate_tail, TruncatedBy, TruncationOptions, TruncationResult, DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
};

/// UTF-8 decoding as `TextDecoder` does it: invalid sequences become U+FFFD by maximal subparts,
/// a BOM that is the stream's first character is dropped, and in streaming mode an incomplete
/// sequence at the end waits for the next chunk.
#[derive(Debug, Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
    bom_seen: bool,
}

impl Utf8Decoder {
    pub fn new() -> Self {
        Utf8Decoder::default()
    }

    /// `decode(data, { stream })`; `stream: false` also ends the stream.
    pub fn decode(&mut self, data: &[u8], stream: bool) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(data);
        let mut text = String::new();
        let mut rest = &bytes[..];
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    text.push_str(valid);
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    text.push_str(std::str::from_utf8(valid).expect("validated"));
                    match error.error_len() {
                        Some(length) => {
                            text.push('\u{FFFD}');
                            rest = &after[length..];
                        }
                        None if stream => {
                            self.pending = after.to_vec();
                            break;
                        }
                        None => {
                            text.push('\u{FFFD}');
                            break;
                        }
                    }
                }
            }
        }
        if !self.bom_seen && !text.is_empty() {
            self.bom_seen = true;
            if let Some(stripped) = text.strip_prefix('\u{FEFF}') {
                text = stripped.to_string();
            }
        }
        if !stream {
            *self = Utf8Decoder::default();
        }
        text
    }
}

/// The text of `bytes` in one decode.
fn decode_all(bytes: &[u8]) -> String {
    Utf8Decoder::new().decode(bytes, false)
}

/// The system's temporary directory as Node's `os.tmpdir()` finds it.
pub fn temp_dir() -> String {
    let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    if cfg!(windows) {
        let mut path = env("TEMP").or_else(|| env("TMP")).unwrap_or_else(|| {
            format!(
                "{}\\temp",
                env("SystemRoot")
                    .or_else(|| env("windir"))
                    .unwrap_or_default()
            )
        });
        if path.len() > 1 && path.ends_with('\\') && !path.ends_with(":\\") {
            path.pop();
        }
        path
    } else {
        let mut path = env("TMPDIR")
            .or_else(|| env("TMP"))
            .or_else(|| env("TEMP"))
            .unwrap_or_else(|| "/tmp".to_string());
        if path.len() > 1 && path.ends_with('/') {
            path.pop();
        }
        path
    }
}

/// Sixteen random hexadecimal digits.
fn random_hex() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|time| time.as_nanos())
            .unwrap_or_default(),
    );
    format!("{:016x}", hasher.finish())
}

/// A new, unused output file path: `<temp>/<prefix>-<random hex><extension>`.
pub fn output_file_path(prefix: &str, extension: &str) -> String {
    let separator = if cfg!(windows) { '\\' } else { '/' };
    format!(
        "{}{separator}{prefix}-{}{extension}",
        temp_dir(),
        random_hex()
    )
}

/// Creates the output file at `path` (`createOutputFileStream`). Only the user may read it:
/// output can carry private data. It is created new, so it never follows a link someone else
/// placed at the path.
pub fn create_output_file(path: &str) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
        .open(path)
        .map_err(|error| fs_error(&error, "open", path))
}

/// The accumulator's limits and output file name.
#[derive(Debug, Clone)]
pub struct OutputAccumulatorOptions {
    pub max_lines: u64,
    pub max_bytes: u64,
    pub temp_file_prefix: String,
}

impl Default for OutputAccumulatorOptions {
    fn default() -> Self {
        OutputAccumulatorOptions {
            max_lines: DEFAULT_MAX_LINES,
            max_bytes: DEFAULT_MAX_BYTES,
            temp_file_prefix: "relay-output".to_string(),
        }
    }
}

/// The display view of the output so far (`OutputSnapshot`).
#[derive(Debug, Clone, PartialEq)]
pub struct OutputSnapshot {
    pub content: String,
    pub truncation: TruncationResult,
    pub full_output_path: Option<String>,
}

/// The whole output for programmatic callers (`FullOutput`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FullOutput {
    pub content: String,
    /// `content` omits part of the output.
    pub truncated: bool,
}

/// Tracks streamed output with bounded memory (`OutputAccumulator`).
pub struct OutputAccumulator {
    max_lines: u64,
    max_bytes: u64,
    max_rolling_bytes: u64,
    temp_file_prefix: String,
    decoder: Utf8Decoder,
    raw_chunks: Vec<Vec<u8>>,
    tail_text: String,
    tail_bytes: u64,
    tail_starts_at_line_boundary: bool,
    total_raw_bytes: u64,
    total_decoded_bytes: u64,
    completed_lines: u64,
    total_lines: u64,
    current_line_bytes: u64,
    has_open_line: bool,
    finished: bool,
    temp_file_path: Option<String>,
    temp_file: Option<BufWriter<File>>,
    /// The first failure to open or write the output file, reported when it is closed, as the
    /// write stream reports it.
    temp_file_error: Option<String>,
}

impl OutputAccumulator {
    pub fn new(options: OutputAccumulatorOptions) -> Self {
        OutputAccumulator {
            max_lines: options.max_lines,
            max_bytes: options.max_bytes,
            max_rolling_bytes: (options.max_bytes * 2).max(1),
            temp_file_prefix: options.temp_file_prefix,
            decoder: Utf8Decoder::new(),
            raw_chunks: Vec::new(),
            tail_text: String::new(),
            tail_bytes: 0,
            tail_starts_at_line_boundary: true,
            total_raw_bytes: 0,
            total_decoded_bytes: 0,
            completed_lines: 0,
            total_lines: 0,
            current_line_bytes: 0,
            has_open_line: false,
            finished: false,
            temp_file_path: None,
            temp_file: None,
            temp_file_error: None,
        }
    }

    /// Adds a chunk of raw output.
    ///
    /// # Panics
    ///
    /// After `finish`, as the TypeScript accumulator throws.
    pub fn append(&mut self, data: &[u8]) {
        assert!(
            !self.finished,
            "Cannot append to a finished output accumulator"
        );
        self.total_raw_bytes += data.len() as u64;
        let text = self.decoder.decode(data, true);
        self.append_decoded_text(&text);
        if self.temp_file.is_some() || self.should_use_temp_file() {
            self.ensure_temp_file();
            self.write_temp(data);
        } else if !data.is_empty() {
            self.raw_chunks.push(data.to_vec());
        }
    }

    /// Ends the output: the decoder's held bytes are decoded.
    pub fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        let text = self.decoder.decode(&[], false);
        self.append_decoded_text(&text);
        if self.should_use_temp_file() {
            self.ensure_temp_file();
        }
    }

    /// The last lines that fit the limits. `persist_if_truncated` opens the output file when they
    /// cut anything, so the snapshot can name it.
    pub fn snapshot(&mut self, persist_if_truncated: bool) -> OutputSnapshot {
        let tail = truncate_tail(
            self.snapshot_text(),
            TruncationOptions {
                max_lines: Some(self.max_lines),
                max_bytes: Some(self.max_bytes),
            },
        );
        let truncated =
            self.total_lines > self.max_lines || self.total_decoded_bytes > self.max_bytes;
        let truncated_by = if truncated {
            Some(
                tail.truncated_by
                    .unwrap_or(if self.total_decoded_bytes > self.max_bytes {
                        TruncatedBy::Bytes
                    } else {
                        TruncatedBy::Lines
                    }),
            )
        } else {
            None
        };
        let truncation = TruncationResult {
            truncated,
            truncated_by,
            total_lines: self.total_lines,
            total_bytes: self.total_decoded_bytes,
            max_lines: self.max_lines,
            max_bytes: self.max_bytes,
            ..tail
        };
        if persist_if_truncated && truncation.truncated {
            self.ensure_temp_file();
        }
        OutputSnapshot {
            content: truncation.content.clone(),
            truncation,
            full_output_path: self.temp_file_path.clone(),
        }
    }

    /// Flushes and closes the output file.
    pub fn close_temp_file(&mut self) -> Result<(), String> {
        if let Some(mut file) = self.temp_file.take() {
            if let Err(error) = file.flush() {
                self.record_temp_error(&error, "write");
            }
        }
        match self.temp_file_error.take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// The complete output, after `finish` and `close_temp_file`. Output longer than `max_bytes`
    /// raw bytes keeps its first and last `max_bytes / 2` bytes around an omission marker.
    pub fn read_full_output(&self, max_bytes: u64) -> Result<FullOutput, String> {
        let Some(path) = &self.temp_file_path else {
            return Ok(FullOutput {
                content: decode_all(&self.raw_chunks.concat()),
                truncated: false,
            });
        };
        let read = || -> io::Result<FullOutput> {
            let mut file = File::open(path)?;
            let size = file.metadata()?.len();
            if size <= max_bytes {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)?;
                return Ok(FullOutput {
                    content: decode_all(&bytes),
                    truncated: false,
                });
            }
            let head_bytes = max_bytes / 2;
            let tail_bytes = max_bytes - head_bytes;
            let mut head = vec![0; head_bytes as usize];
            let mut tail = vec![0; tail_bytes as usize];
            file.read_exact(&mut head)?;
            file.seek(SeekFrom::Start(size - tail_bytes))?;
            file.read_exact(&mut tail)?;
            // Cut at character boundaries: a streaming decode holds back an incomplete last
            // sequence, and the tail skips leading continuation bytes.
            let head_text = Utf8Decoder::new().decode(&head, true);
            let tail_start = tail
                .iter()
                .position(|byte| byte & 0xc0 != 0x80)
                .unwrap_or(tail.len());
            let tail_text = decode_all(&tail[tail_start..]);
            let omitted = size - head_bytes - tail_bytes;
            Ok(FullOutput {
                content: format!("{head_text}\n\n[... {omitted} bytes omitted ...]\n\n{tail_text}"),
                truncated: true,
            })
        };
        read().map_err(|error| fs_error(&error, "open", path))
    }

    /// Bytes of the last, unfinished line.
    pub fn last_line_bytes(&self) -> u64 {
        self.current_line_bytes
    }

    fn append_decoded_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let bytes = text.len() as u64;
        self.total_decoded_bytes += bytes;
        self.tail_text.push_str(text);
        self.tail_bytes += bytes;
        if self.tail_bytes > self.max_rolling_bytes * 2 {
            self.trim_tail();
        }
        let newlines = text.matches('\n').count() as u64;
        if newlines == 0 {
            self.current_line_bytes += bytes;
            self.has_open_line = true;
        } else {
            self.completed_lines += newlines;
            let tail = &text[text.rfind('\n').expect("a newline") + 1..];
            self.current_line_bytes = tail.len() as u64;
            self.has_open_line = !tail.is_empty();
        }
        self.total_lines = self.completed_lines + u64::from(self.has_open_line);
    }

    fn trim_tail(&mut self) {
        let length = self.tail_text.len();
        if length as u64 <= self.max_rolling_bytes {
            self.tail_bytes = length as u64;
            return;
        }
        let mut start = length - self.max_rolling_bytes as usize;
        while start < length && !self.tail_text.is_char_boundary(start) {
            start += 1;
        }
        if start != 0 {
            self.tail_starts_at_line_boundary = self.tail_text.as_bytes()[start - 1] == b'\n';
        }
        self.tail_text = self.tail_text[start..].to_string();
        self.tail_bytes = self.tail_text.len() as u64;
    }

    fn snapshot_text(&self) -> &str {
        if self.tail_starts_at_line_boundary {
            return &self.tail_text;
        }
        match self.tail_text.find('\n') {
            Some(newline) => &self.tail_text[newline + 1..],
            None => &self.tail_text,
        }
    }

    fn should_use_temp_file(&self) -> bool {
        self.total_raw_bytes > self.max_bytes
            || self.total_decoded_bytes > self.max_bytes
            || self.total_lines > self.max_lines
    }

    fn record_temp_error(&mut self, error: &io::Error, syscall: &str) {
        if self.temp_file_error.is_none() {
            let path = self.temp_file_path.clone().unwrap_or_default();
            self.temp_file_error = Some(fs_error(error, syscall, &path));
        }
    }

    fn write_temp(&mut self, data: &[u8]) {
        if let Some(file) = &mut self.temp_file {
            if let Err(error) = file.write_all(data) {
                self.record_temp_error(&error, "write");
            }
        }
    }

    fn ensure_temp_file(&mut self) {
        if self.temp_file_path.is_some() {
            return;
        }
        // The path is named even when opening the file fails, as the write stream's is.
        let path = output_file_path(&self.temp_file_prefix, ".log");
        let opened = create_output_file(&path);
        self.temp_file_path = Some(path);
        match opened {
            Ok(file) => {
                self.temp_file = Some(BufWriter::new(file));
                for chunk in std::mem::take(&mut self.raw_chunks) {
                    self.write_temp(&chunk);
                }
            }
            Err(error) => self.temp_file_error = Some(error),
        }
    }
}
