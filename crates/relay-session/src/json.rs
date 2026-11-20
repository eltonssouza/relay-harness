//! `JSON.stringify` for parsed values: compact, keys in order, and numbers as JavaScript writes
//! them (`0.0000012`, where serde_json writes `1.2e-6`), so a rewritten session file matches the
//! TypeScript agent's byte for byte.

use serde_json::Value;

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::Number(number) => {
            if number.is_f64() {
                out.push_str(&relay_ai::text::js_number_to_string(
                    number.as_f64().unwrap_or_default(),
                ));
            } else {
                out.push_str(&number.to_string());
            }
        }
        Value::String(text) => out.push_str(&Value::String(text.clone()).to_string()),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(fields) => {
            out.push('{');
            for (index, (name, item)) in fields.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(name.clone()).to_string());
                out.push(':');
                write(item, out);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_numbers_as_javascript_does() {
        let value: Value =
            serde_json::from_str(r#"{"a":0.0000012,"b":1.5,"c":3,"d":-0.0,"e":"x\u0001"}"#)
                .unwrap();
        assert_eq!(
            stringify(&value),
            r#"{"a":0.0000012,"b":1.5,"c":3,"d":0,"e":"x\u0001"}"#
        );
        assert_eq!(stringify(&json!([1, null, true])), "[1,null,true]");
    }
}
