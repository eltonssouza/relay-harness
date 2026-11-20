//! Server-sent events from a byte stream, as the Anthropic adapter decodes them
//! (`iterateSseMessages`): UTF-8 decoded incrementally like `TextDecoder`, lines split at `\r`,
//! `\n` or `\r\n`, events dispatched at a blank line.
//!
//! The Anthropic decoder keeps one quirk: a `\r\n` pair split between two chunks reads as two line
//! ends, so the `\n` dispatches the event early. The OpenAI SDK's decoder
//! (`SseDecoder::joining_split_crlf`) reads such a pair as one line end.

/// One event: its `event` field and its `data` lines joined with `\n`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerSentEvent {
    pub event: Option<String>,
    pub data: String,
    /// The event's lines as received, for error messages.
    pub raw: Vec<String>,
}

/// UTF-8 decoding across chunk boundaries; invalid bytes become U+FFFD.
#[derive(Debug, Default)]
pub(crate) struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub(crate) fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut text = String::new();
        let mut rest: &[u8] = &self.pending;
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    text.push_str(valid);
                    rest = &[];
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    text.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match error.error_len() {
                        Some(length) => {
                            text.push('\u{FFFD}');
                            rest = &after[length..];
                        }
                        // An incomplete character at the end waits for the next chunk.
                        None if !last => {
                            rest = after;
                            break;
                        }
                        None => {
                            text.push('\u{FFFD}');
                            rest = &[];
                            break;
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        text
    }
}

#[derive(Debug, Default)]
pub struct SseDecoder {
    utf8: Utf8Decoder,
    buffer: String,
    event: Option<String>,
    data: Vec<String>,
    raw: Vec<String>,
    /// Read a `\r\n` pair split between chunks as one line end.
    joins_split_crlf: bool,
    /// The last chunk ended with a `\r` line end, so a `\n` starting the next one belongs to it.
    after_cr: bool,
}

impl SseDecoder {
    /// The OpenAI SDK's line splitting: `\r`, `\n` or `\r\n`, wherever the chunks break.
    pub fn joining_split_crlf() -> Self {
        SseDecoder {
            joins_split_crlf: true,
            ..SseDecoder::default()
        }
    }

    /// The events completed by this chunk.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<ServerSentEvent> {
        let mut text = self.utf8.decode(bytes, false);
        if self.after_cr && !text.is_empty() {
            self.after_cr = false;
            if text.starts_with('\n') {
                text.remove(0);
            }
        }
        self.buffer.push_str(&text);
        self.consume_lines()
    }

    /// The events left when the body ends, including a last line without a line end.
    pub fn finish(&mut self) -> Vec<ServerSentEvent> {
        let text = self.utf8.decode(&[], true);
        self.buffer.push_str(&text);
        let mut events = self.consume_lines();
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            events.extend(self.decode_line(&line));
        }
        events.extend(self.flush());
        events
    }

    fn consume_lines(&mut self) -> Vec<ServerSentEvent> {
        let mut events = Vec::new();
        while let Some(line_end) = self.buffer.find(['\r', '\n']) {
            let line = self.buffer[..line_end].to_string();
            let mut next = line_end + 1;
            if self.buffer.as_bytes()[line_end] == b'\r' {
                match self.buffer.as_bytes().get(next) {
                    Some(b'\n') => next += 1,
                    None => self.after_cr = self.joins_split_crlf,
                    Some(_) => {}
                }
            }
            self.buffer.drain(..next);
            events.extend(self.decode_line(&line));
        }
        events
    }

    fn flush(&mut self) -> Option<ServerSentEvent> {
        // An empty `event` field counts as none, as in JavaScript.
        if self.event.as_deref().unwrap_or_default().is_empty() && self.data.is_empty() {
            return None;
        }
        Some(ServerSentEvent {
            event: self.event.take(),
            data: std::mem::take(&mut self.data).join("\n"),
            raw: std::mem::take(&mut self.raw),
        })
    }

    fn decode_line(&mut self, line: &str) -> Option<ServerSentEvent> {
        if line.is_empty() {
            return self.flush();
        }
        self.raw.push(line.to_string());
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.find(':') {
            Some(colon) => (&line[..colon], &line[colon + 1..]),
            None => (line, ""),
        };
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_split_characters_and_lines() {
        let mut decoder = SseDecoder::default();
        let text = "event: a\ndata: caf\u{e9}\n\ndata: x";
        let bytes = text.as_bytes();
        let split = text.find('\u{e9}').unwrap() + 1;
        let mut events = decoder.push(&bytes[..split]);
        events.extend(decoder.push(&bytes[split..]));
        events.extend(decoder.finish());
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data, "caf\u{e9}");
        assert_eq!(events[1].event, None);
        assert_eq!(events[1].data, "x");
    }
}
