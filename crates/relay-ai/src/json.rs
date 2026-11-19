//! JSON helpers. `js_number` writes numbers as JavaScript does. The others apply to provider
//! output, as `packages/ai/src/utils/json-parse.ts` defines them: repairing malformed string
//! literals, and parsing tool arguments while they stream, with the `partial-json` 0.1.7 rules
//! (all partial kinds allowed).
//!
//! The partial parser keeps the library's JavaScript behavior, including where it is odd: its
//! `substring` swaps reversed bounds and its `lastIndexOf` searches the whole input, so a few
//! malformed inputs drop more than the last value. Every boundary it cuts at is an ASCII
//! character or an end, so working on UTF-8 bytes gives the same slices as UTF-16 indices.

use serde_json::{Map, Value};

use crate::text::js_trim;

/// A number as JavaScript writes it: whole values without a fraction (`0`, not `0.0`), and
/// `null` for NaN and the infinities.
pub fn js_number(number: f64) -> Value {
    const SAFE: f64 = 9_007_199_254_740_992.0;
    if number.fract() == 0.0 && number.abs() < SAFE {
        Value::from(number as i64)
    } else {
        serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
    }
}

/// Escape raw control characters in string literals and double the backslash of an escape JSON
/// does not have.
pub fn repair_json(json: &str) -> String {
    let characters: Vec<char> = json.chars().collect();
    let mut repaired = String::with_capacity(json.len());
    let mut in_string = false;
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if !in_string {
            repaired.push(character);
            in_string = character == '"';
            index += 1;
            continue;
        }
        if character == '"' {
            repaired.push(character);
            in_string = false;
            index += 1;
            continue;
        }
        if character == '\\' {
            let Some(&next) = characters.get(index + 1) else {
                repaired.push_str("\\\\");
                index += 1;
                continue;
            };
            if next == 'u' {
                let digits: String = characters.iter().skip(index + 2).take(4).collect();
                if digits.len() == 4 && digits.chars().all(|digit| digit.is_ascii_hexdigit()) {
                    repaired.push_str("\\u");
                    repaired.push_str(&digits);
                    index += 6;
                    continue;
                }
            }
            if matches!(next, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u') {
                repaired.push('\\');
                repaired.push(next);
                index += 2;
                continue;
            }
            repaired.push_str("\\\\");
            index += 1;
            continue;
        }
        match character {
            '\u{8}' => repaired.push_str("\\b"),
            '\u{C}' => repaired.push_str("\\f"),
            '\n' => repaired.push_str("\\n"),
            '\r' => repaired.push_str("\\r"),
            '\t' => repaired.push_str("\\t"),
            control if (control as u32) <= 0x1f => {
                repaired.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => repaired.push(other),
        }
        index += 1;
    }
    repaired
}

/// `JSON.parse`, then once more after `repair_json` when that changes the text.
pub fn parse_json_with_repair(json: &str) -> Result<Value, serde_json::Error> {
    match serde_json::from_str(json) {
        Ok(value) => Ok(value),
        Err(error) => {
            let repaired = repair_json(json);
            if repaired != json {
                serde_json::from_str(&repaired)
            } else {
                Err(error)
            }
        }
    }
}

/// Tool arguments from possibly incomplete JSON. Always a value: `{}` when nothing parses.
pub fn parse_streaming_json(partial_json: &str) -> Value {
    if partial_json.is_empty() || js_trim(partial_json).is_empty() {
        return Value::Object(Map::new());
    }
    if let Ok(value) = parse_json_with_repair(partial_json) {
        return value;
    }
    let or_empty = |parsed: Parsed| match parsed {
        Parsed::Null => Value::Object(Map::new()),
        other => other.into_value(),
    };
    if let Ok(parsed) = partial_parse(partial_json) {
        return or_empty(parsed);
    }
    match partial_parse(&repair_json(partial_json)) {
        Ok(parsed) => or_empty(parsed),
        Err(()) => Value::Object(Map::new()),
    }
}

/// A parsed value as JavaScript holds it: `null`, `NaN` or an infinity (which JSON writes as
/// null), or anything else.
#[derive(Debug, Clone, PartialEq)]
enum Parsed {
    Null,
    NonFinite,
    Json(Value),
}

impl Parsed {
    fn into_value(self) -> Value {
        match self {
            Parsed::Null | Parsed::NonFinite => Value::Null,
            Parsed::Json(value) => value,
        }
    }
}

fn from_json(text: &[u8]) -> Result<Parsed, ()> {
    let text = std::str::from_utf8(text).map_err(|_| ())?;
    match serde_json::from_str::<Value>(text).map_err(|_| ())? {
        Value::Null => Ok(Parsed::Null),
        value => Ok(Parsed::Json(value)),
    }
}

/// `partial-json`'s `parse` with every partial kind allowed. `Err` stands for any exception.
fn partial_parse(text: &str) -> Result<Parsed, ()> {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return Err(());
    }
    let mut parser = PartialParser {
        text: trimmed.as_bytes(),
        index: 0,
    };
    parser.parse_any()
}

struct PartialParser<'a> {
    text: &'a [u8],
    index: usize,
}

impl PartialParser<'_> {
    fn at(&self, index: usize) -> Option<u8> {
        self.text.get(index).copied()
    }

    /// `String.prototype.substring`: bounds clamp to the text, and reversed bounds swap.
    fn substring(&self, start: isize, end: isize) -> &[u8] {
        let clamp = |bound: isize| bound.clamp(0, self.text.len() as isize) as usize;
        let (start, end) = (clamp(start), clamp(end));
        let (start, end) = if start > end {
            (end, start)
        } else {
            (start, end)
        };
        &self.text[start..end]
    }

    /// `lastIndexOf` over the whole text; -1 when absent.
    fn last_index_of(&self, byte: u8) -> isize {
        self.text
            .iter()
            .rposition(|&candidate| candidate == byte)
            .map_or(-1, |position| position as isize)
    }

    fn rest_is_prefix_of(&self, word: &str) -> bool {
        let rest = &self.text[self.index..];
        rest.len() < word.len() && word.as_bytes().starts_with(rest)
    }

    fn skip_blank(&mut self) {
        while matches!(self.at(self.index), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.index += 1;
        }
    }

    fn parse_any(&mut self) -> Result<Parsed, ()> {
        self.skip_blank();
        if self.index >= self.text.len() {
            return Err(());
        }
        match self.at(self.index) {
            Some(b'"') => return self.parse_str(),
            Some(b'{') => return self.parse_obj(),
            Some(b'[') => return self.parse_arr(),
            _ => {}
        }
        let rest = &self.text[self.index..];
        let literals: [(&str, Parsed); 5] = [
            ("null", Parsed::Null),
            ("true", Parsed::Json(Value::Bool(true))),
            ("false", Parsed::Json(Value::Bool(false))),
            ("Infinity", Parsed::NonFinite),
            ("-Infinity", Parsed::NonFinite),
        ];
        for (word, value) in literals {
            let partial_allowed = word != "-Infinity" || rest.len() > 1;
            if rest.starts_with(word.as_bytes())
                || (partial_allowed && self.rest_is_prefix_of(word))
            {
                self.index += word.len();
                return Ok(value);
            }
        }
        if rest.starts_with(b"NaN") || self.rest_is_prefix_of("NaN") {
            self.index += 3;
            return Ok(Parsed::NonFinite);
        }
        self.parse_num()
    }

    fn parse_str(&mut self) -> Result<Parsed, ()> {
        let start = self.index;
        let mut escape = false;
        self.index += 1;
        while self.index < self.text.len()
            && (self.text[self.index] != b'"' || (escape && self.text[self.index - 1] == b'\\'))
        {
            escape = if self.text[self.index] == b'\\' {
                !escape
            } else {
                false
            };
            self.index += 1;
        }
        let escape_offset = isize::from(escape);
        if self.at(self.index) == Some(b'"') {
            self.index += 1;
            let end = self.index as isize - escape_offset;
            return from_json(self.substring(start as isize, end));
        }
        let unterminated = |end: isize| {
            let mut quoted = self.substring(start as isize, end).to_vec();
            quoted.push(b'"');
            from_json(&quoted)
        };
        unterminated(self.index as isize - escape_offset)
            .or_else(|()| unterminated(self.last_index_of(b'\\')))
    }

    fn parse_obj(&mut self) -> Result<Parsed, ()> {
        self.index += 1;
        self.skip_blank();
        let mut object = Map::new();
        while self.at(self.index) != Some(b'}') {
            self.skip_blank();
            if self.index >= self.text.len() {
                return Ok(Parsed::Json(Value::Object(object)));
            }
            let key = match self.parse_str() {
                Ok(Parsed::Json(Value::String(key))) => key,
                _ => return Ok(Parsed::Json(Value::Object(object))),
            };
            self.skip_blank();
            self.index += 1;
            match self.parse_any() {
                Ok(value) => {
                    object.insert(key, value.into_value());
                }
                Err(()) => return Ok(Parsed::Json(Value::Object(object))),
            }
            self.skip_blank();
            if self.at(self.index) == Some(b',') {
                self.index += 1;
            }
        }
        self.index += 1;
        Ok(Parsed::Json(Value::Object(object)))
    }

    fn parse_arr(&mut self) -> Result<Parsed, ()> {
        self.index += 1;
        let mut array = Vec::new();
        while self.at(self.index) != Some(b']') {
            match self.parse_any() {
                Ok(value) => array.push(value.into_value()),
                Err(()) => return Ok(Parsed::Json(Value::Array(array))),
            }
            self.skip_blank();
            if self.at(self.index) == Some(b',') {
                self.index += 1;
            }
        }
        self.index += 1;
        Ok(Parsed::Json(Value::Array(array)))
    }

    fn parse_num(&mut self) -> Result<Parsed, ()> {
        if self.index == 0 {
            if self.text == b"-" {
                return Err(());
            }
            return from_json(self.text)
                .or_else(|()| from_json(self.substring(0, self.last_index_of(b'e'))));
        }
        let start = self.index;
        if self.at(self.index) == Some(b'-') {
            self.index += 1;
        }
        while let Some(byte) = self.at(self.index) {
            if matches!(byte, b',' | b']' | b'}') {
                break;
            }
            self.index += 1;
        }
        let number = self.substring(start as isize, self.index as isize);
        if let Ok(value) = from_json(number) {
            return Ok(value);
        }
        if number == b"-" {
            return Err(());
        }
        from_json(self.substring(start as isize, self.last_index_of(b'e')))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_partial_values() {
        assert_eq!(parse_streaming_json(r#"{"a": "hel"#), json!({ "a": "hel" }));
        assert_eq!(
            parse_streaming_json(r#"{"a": [1, tr"#),
            json!({ "a": [1, true] })
        );
        assert_eq!(parse_streaming_json("null"), Value::Null);
        assert_eq!(parse_streaming_json("nu"), json!({}));
        assert_eq!(parse_streaming_json("Infinity"), Value::Null);
    }
}
