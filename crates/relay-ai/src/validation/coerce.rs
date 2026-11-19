//! Relay's argument coercion (`coerceWithJsonSchema` and `normalizeOptionalNulls` in
//! `packages/ai/src/utils/validation.ts`): models often send `"5"` for a number or `null` for an
//! omitted option. Sub-schemas are checked on their own, as `getSubSchemaValidator` compiles them.

use serde_json::{Map, Value};

use super::engine::Validator;
use crate::json::js_number;
use crate::text::{js_number_to_string, js_string_to_number, js_trim};

fn check_alone(schema: &Value, value: &Value) -> bool {
    Validator::new(schema).check(value)
}

fn schema_types(schema: &Map<String, Value>) -> Vec<&str> {
    match schema.get("type") {
        Some(Value::String(name)) => vec![name.as_str()],
        Some(Value::Array(names)) => names.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

fn matches_type(value: &Value, name: &str) -> bool {
    match name {
        "number" => value.is_number(),
        "integer" => value
            .as_f64()
            .is_some_and(|number| number.is_finite() && number.fract() == 0.0),
        "boolean" => value.is_boolean(),
        "string" => value.is_string(),
        "null" => value.is_null(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => false,
    }
}

/// `coercePrimitiveByType`: the coerced value, or none when it stays as it is.
fn coerce_primitive(value: &Value, name: &str) -> Option<Value> {
    match name {
        "number" | "integer" => match value {
            Value::Null => Some(js_number(0.0)),
            Value::String(text) if !js_trim(text).is_empty() => {
                let parsed = js_string_to_number(text);
                let accepted = if name == "number" {
                    parsed.is_finite()
                } else {
                    parsed.is_finite() && parsed.fract() == 0.0
                };
                accepted.then(|| js_number(parsed))
            }
            Value::Bool(flag) => Some(js_number(if *flag { 1.0 } else { 0.0 })),
            _ => None,
        },
        "boolean" => match value {
            Value::Null => Some(Value::Bool(false)),
            Value::String(text) if text == "true" => Some(Value::Bool(true)),
            Value::String(text) if text == "false" => Some(Value::Bool(false)),
            Value::Number(number) if number.as_f64() == Some(1.0) => Some(Value::Bool(true)),
            Value::Number(number) if number.as_f64() == Some(0.0) => Some(Value::Bool(false)),
            _ => None,
        },
        "string" => match value {
            Value::Null => Some(Value::String(String::new())),
            Value::Number(number) => number
                .as_f64()
                .map(|number| Value::String(js_number_to_string(number))),
            Value::Bool(flag) => Some(Value::String(flag.to_string())),
            _ => None,
        },
        "null" => match value {
            Value::String(text) if text.is_empty() => Some(Value::Null),
            Value::Number(number) if number.as_f64() == Some(0.0) => Some(Value::Null),
            Value::Bool(false) => Some(Value::Null),
            _ => None,
        },
        _ => None,
    }
}

/// `coerceWithUnionSchema`: a value a member accepts stays; else the first member's coercion that
/// member accepts, as a new value.
fn coerce_union(value: Value, members: &[Value]) -> (Value, bool) {
    if members.iter().any(|member| check_alone(member, &value)) {
        return (value, false);
    }
    for member in members {
        let (coerced, _) = coerce(value.clone(), member);
        if check_alone(member, &coerced) {
            return (coerced, true);
        }
    }
    (value, false)
}

/// `coerceWithJsonSchema`. The flag tells whether the value itself was replaced (in TypeScript,
/// a different object), not only changed inside.
pub(crate) fn coerce(value: Value, schema: &Value) -> (Value, bool) {
    let Value::Object(schema) = schema else {
        return (value, false);
    };
    let mut next = value;
    let mut replaced = false;
    if let Some(Value::Array(all)) = schema.get("allOf") {
        for nested in all {
            let (coerced, changed) = coerce(next, nested);
            next = coerced;
            replaced |= changed;
        }
    }
    for keyword in ["anyOf", "oneOf"] {
        if let Some(Value::Array(members)) = schema.get(keyword) {
            let (coerced, changed) = coerce_union(next, members);
            next = coerced;
            replaced |= changed;
        }
    }
    let types = schema_types(schema);
    let member_matches = types.len() > 1 && types.iter().any(|name| matches_type(&next, name));
    if !types.is_empty() && !member_matches {
        if let Some(coerced) = types.iter().find_map(|name| coerce_primitive(&next, name)) {
            next = coerced;
            replaced = true;
        }
    }
    if types.contains(&"object") {
        if let Value::Object(object) = &mut next {
            coerce_object(object, schema);
        }
    }
    if types.contains(&"array") {
        if let Value::Array(items) = &mut next {
            coerce_array(items, schema);
        }
    }
    (next, replaced)
}

fn coerce_object(object: &mut Map<String, Value>, schema: &Map<String, Value>) {
    let properties = schema.get("properties").and_then(Value::as_object);
    for (key, property) in properties.into_iter().flatten() {
        if let Some(slot) = object.get_mut(key) {
            *slot = coerce(slot.take(), property).0;
        }
    }
    if let Some(additional) = schema
        .get("additionalProperties")
        .filter(|additional| additional.is_object() || additional.is_array())
    {
        for (key, slot) in object.iter_mut() {
            if properties.is_some_and(|properties| properties.contains_key(key)) {
                continue;
            }
            *slot = coerce(slot.take(), additional).0;
        }
    }
}

fn coerce_array(items: &mut [Value], schema: &Map<String, Value>) {
    match schema.get("items") {
        Some(Value::Array(item_schemas)) => {
            for (slot, item_schema) in items.iter_mut().zip(item_schemas) {
                *slot = coerce(slot.take(), item_schema).0;
            }
        }
        Some(item_schema) if item_schema.is_object() => {
            for slot in items.iter_mut() {
                *slot = coerce(slot.take(), item_schema).0;
            }
        }
        _ => {}
    }
}

/// `normalizeOptionalNulls`: a `null` for an optional property its schema rejects is removed, as
/// if the model had left it out.
pub(crate) fn normalize_optional_nulls(value: &mut Value, schema: &Value) {
    if let Value::Array(items) = value {
        match schema.get("items") {
            Some(Value::Array(item_schemas)) => {
                for (item, item_schema) in items.iter_mut().zip(item_schemas) {
                    normalize_optional_nulls(item, item_schema);
                }
            }
            Some(item_schema) => {
                for item in items.iter_mut() {
                    normalize_optional_nulls(item, item_schema);
                }
            }
            None => {}
        }
        return;
    }
    let (Value::Object(object), Some(Value::Object(properties))) =
        (value, schema.get("properties"))
    else {
        return;
    };
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|required| required.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    for (key, property) in properties {
        let Some(slot) = object.get_mut(key) else {
            continue;
        };
        let removable = slot.is_null()
            && !required.contains(&key.as_str())
            && !property.get("$ref").is_some_and(Value::is_string)
            && !check_alone(property, &Value::Null);
        if removable {
            object.shift_remove(key);
        } else {
            normalize_optional_nulls(slot, property);
        }
    }
}
