//! TypeBox's `Value.Convert` (`typebox/build/value/convert`), which runs only on schemas built
//! with TypeBox: the built-in tools'. TypeBox dispatches on each schema's hidden kind; the kind of
//! a TypeBox-built schema follows from its JSON (`Type.Number()` is `{"type":"number"}`), so it is
//! read from that here.
//!
//! The conversions are TypeBox's `Try*` rules: a number from a numeric string, `true`/`false`, a
//! boolean or null; a string from any scalar (`null` becomes `"null"`); a boolean from
//! `"true"`/`"false"`/`"1"`/`"0"`, 1/0 or null; an array from anything (wrapped). A union keeps a
//! value one member accepts, else the first member's conversion the union accepts.

use serde_json::{Map, Value};

use super::engine::{deep_equal, Validator};
use super::regex::js_regex;
use crate::json::js_number;
use crate::text::{js_number_to_string, js_string_to_number};

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn try_string(value: &Value) -> Option<Value> {
    match value {
        Value::Bool(flag) => Some(Value::String(flag.to_string())),
        Value::Number(number) => Some(Value::String(js_number_to_string(number.as_f64()?))),
        Value::Null => Some(Value::String("null".into())),
        Value::String(_) => Some(value.clone()),
        _ => None,
    }
}

/// The integer a string names for `BigInt`: `12n`, `12.7` (truncated) or `12`.
fn string_big_integer(text: &str) -> Option<f64> {
    let integer = |digits: &str| {
        let body = digits.strip_prefix('-').unwrap_or(digits);
        let valid = body == "0"
            || (body.starts_with(|first: char| ('1'..='9').contains(&first))
                && body.chars().all(|digit| digit.is_ascii_digit()));
        valid.then(|| digits.parse::<f64>().ok()).flatten()
    };
    if let Some(digits) = text.strip_suffix('n') {
        return integer(digits);
    }
    if let Some((whole, fraction)) = text.split_once('.') {
        if !fraction.is_empty() && fraction.chars().all(|digit| digit.is_ascii_digit()) {
            return integer(whole);
        }
        return None;
    }
    integer(text)
}

fn try_number(value: &Value) -> Option<f64> {
    match value {
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Number(number) => number.as_f64(),
        Value::Null => Some(0.0),
        Value::String(text) => {
            let coerced = js_string_to_number(text);
            if coerced.is_finite() {
                return Some(coerced);
            }
            match text.to_lowercase().as_str() {
                "false" => return Some(0.0),
                "true" => return Some(1.0),
                _ => {}
            }
            string_big_integer(text).filter(|number| number.abs() <= MAX_SAFE_INTEGER)
        }
        _ => None,
    }
}

fn try_boolean(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::Number(number) => {
            let number = number.as_f64();
            if number == Some(0.0) {
                Some(false)
            } else if number == Some(1.0) {
                Some(true)
            } else {
                None
            }
        }
        Value::Null => Some(false),
        Value::String(text) => match (text.to_lowercase().as_str(), text.as_str()) {
            ("false", _) | (_, "0") => Some(false),
            ("true", _) | (_, "1") => Some(true),
            _ => None,
        },
        _ => None,
    }
}

fn try_null(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => !flag,
        Value::Number(number) => number.as_f64() == Some(0.0),
        Value::Null => true,
        Value::String(text) => {
            matches!(text.to_lowercase().as_str(), "undefined" | "null")
                || text.is_empty()
                || text == "0"
        }
        _ => false,
    }
}

fn type_is(schema: &Map<String, Value>, name: &str) -> bool {
    schema.get("type").and_then(Value::as_str) == Some(name)
}

/// `^key$`, as TypeBox matches property names: the key read as a pattern.
fn key_matches(property: &str, key: &str) -> bool {
    match js_regex(&format!("^{property}$")) {
        Some(regex) => regex.is_match(key).unwrap_or(false),
        None => property == key,
    }
}

pub(crate) struct Converter<'a> {
    validator: Validator<'a>,
}

impl<'a> Converter<'a> {
    pub(crate) fn new(root: &'a Value) -> Self {
        Converter {
            validator: Validator::new(root),
        }
    }

    fn check(&self, schema: &Value, value: &Value) -> bool {
        self.validator.check_schema(schema, value)
    }

    /// `FromType`.
    pub(crate) fn convert(&self, schema: &Value, value: Value) -> Value {
        let Value::Object(schema) = schema else {
            return value;
        };
        if type_is(schema, "array") {
            return match schema.get("items") {
                Some(Value::Array(items)) => self.tuple(items, value),
                Some(items) => {
                    // `TryArray`: anything else becomes a one-item array.
                    let list = match value {
                        Value::Array(list) => list,
                        other => vec![other],
                    };
                    Value::Array(
                        list.into_iter()
                            .map(|item| self.convert(items, item))
                            .collect(),
                    )
                }
                None => value,
            };
        }
        if type_is(schema, "boolean") {
            return try_boolean(&value).map_or(value, Value::Bool);
        }
        if let Some(Value::Array(options)) = schema.get("enum") {
            return self.union(
                &options
                    .iter()
                    .map(|option| serde_json::json!({ "const": option }))
                    .collect::<Vec<_>>(),
                &Value::Object(schema.clone()),
                value,
            );
        }
        if type_is(schema, "integer") {
            return try_number(&value).map_or(value, |number| js_number(number.trunc()));
        }
        if let Some(constant) = schema.get("const") {
            return Self::literal(constant, value);
        }
        if type_is(schema, "null") {
            return if try_null(&value) { Value::Null } else { value };
        }
        if type_is(schema, "number") {
            return try_number(&value).map_or(value, js_number);
        }
        if type_is(schema, "object") {
            return match value {
                Value::Object(object) => Value::Object(self.object(schema, object)),
                other => other,
            };
        }
        if type_is(schema, "string") {
            return try_string(&value).unwrap_or(value);
        }
        if let Some(Value::Array(members)) = schema.get("anyOf") {
            return self.union(members, &Value::Object(schema.clone()), value);
        }
        value
    }

    fn tuple(&self, items: &[Value], value: Value) -> Value {
        match value {
            Value::Array(mut list) => {
                for (index, item) in items.iter().enumerate() {
                    if let Some(slot) = list.get_mut(index) {
                        *slot = self.convert(item, slot.take());
                    }
                }
                Value::Array(list)
            }
            other => other,
        }
    }

    fn object(
        &self,
        schema: &Map<String, Value>,
        mut object: Map<String, Value>,
    ) -> Map<String, Value> {
        let properties = schema.get("properties").and_then(Value::as_object);
        let keys: Vec<String> = object.keys().cloned().collect();
        for (property, sub) in properties.into_iter().flatten() {
            for key in &keys {
                if key_matches(property, key) {
                    if let Some(slot) = object.get_mut(key) {
                        *slot = self.convert(sub, slot.take());
                    }
                }
            }
        }
        // `FromAdditionalProperties`: each key a known property's pattern misses is converted,
        // once per known property.
        if let Some(additional) = schema
            .get("additionalProperties")
            .filter(|value| value.is_object())
        {
            let keys: Vec<String> = object.keys().cloned().collect();
            for property in properties
                .into_iter()
                .flatten()
                .map(|(property, _)| property)
            {
                for key in &keys {
                    if !key_matches(property, key) {
                        if let Some(slot) = object.get_mut(key) {
                            *slot = self.convert(additional, slot.take());
                        }
                    }
                }
            }
        }
        object
    }

    fn literal(constant: &Value, value: Value) -> Value {
        if deep_equal(constant, &value) && !constant.is_object() && !constant.is_array() {
            return value;
        }
        let converted = match constant {
            Value::Bool(_) => try_boolean(&value).map(Value::Bool),
            Value::Number(_) => try_number(&value).map(js_number),
            Value::String(_) => try_string(&value),
            _ => None,
        };
        match converted {
            Some(converted) if deep_equal(&converted, constant) => converted,
            _ => value,
        }
    }

    /// `FromUnion`: a value a member accepts stays; else the first member's conversion the whole
    /// union accepts.
    fn union(&self, members: &[Value], union: &Value, value: Value) -> Value {
        if members.iter().any(|member| self.check(member, &value)) {
            return value;
        }
        members
            .iter()
            .map(|member| self.convert(member, value.clone()))
            .find(|candidate| self.check(union, candidate))
            .unwrap_or(value)
    }
}
