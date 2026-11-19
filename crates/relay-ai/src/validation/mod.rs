//! Tool-argument validation (`validateToolArguments`, `packages/ai/src/utils/validation.ts`): the
//! arguments a model sent, made to fit the tool's JSON Schema where a reasonable conversion exists,
//! then checked. The error lists every problem (up to 8) and the arguments as received, for the
//! model to correct its call:
//!
//! ```text
//! Validation failed for tool "read":
//!   - offset: must be number
//!
//! Received arguments:
//! { ... }
//! ```
//!
//! Three steps change the arguments first: a `null` for an optional property the schema rejects
//! is dropped; for a built-in tool, TypeBox's `Value.Convert` runs (`typebox`); then Relay's own
//! coercion. The check is TypeBox's (`engine`).

mod coerce;
mod convert;
mod engine;
mod formats;
mod regex;

use serde_json::Value;

pub use engine::{SchemaError, Validator};

/// Where an error is, as Relay writes it: `edits.0.newText`, or `root`. A missing required
/// property is named in the path.
fn error_path(error: &SchemaError) -> String {
    let base = error
        .instance_path
        .strip_prefix('/')
        .unwrap_or(&error.instance_path)
        .replace('/', ".");
    if error.keyword == "required" {
        if let Some(missing) = error.missing.first() {
            return if base.is_empty() {
                missing.clone()
            } else {
                format!("{base}.{missing}")
            };
        }
    }
    if base.is_empty() {
        "root".into()
    } else {
        base
    }
}

/// The arguments, converted and checked against the tool's schema. `typebox` is set for the
/// built-in tools, whose schemas the TypeScript agent builds with TypeBox: only those get
/// TypeBox's conversion. The error is the message the model receives.
pub fn validate_tool_arguments(
    tool_name: &str,
    schema: &Value,
    typebox: bool,
    arguments: &Value,
) -> Result<Value, String> {
    let mut args = arguments.clone();
    coerce::normalize_optional_nulls(&mut args, schema);
    // `Value.Convert`'s result is not kept: only its changes inside the arguments object count.
    let object_schema = schema.get("type").and_then(Value::as_str) == Some("object");
    if typebox && object_schema && args.is_object() {
        args = convert::Converter::new(schema).convert(schema, args);
    }
    let validator = Validator::new(schema);
    let (coerced, replaced) = coerce::coerce(args.clone(), schema);
    if replaced && !(args.is_object() && coerced.is_object()) {
        return Ok(if validator.check(&coerced) {
            coerced
        } else {
            args
        });
    }
    args = coerced;
    if validator.check(&args) {
        return Ok(args);
    }
    let errors: Vec<String> = validator
        .errors(&args)
        .iter()
        .map(|error| format!("  - {}: {}", error_path(error), error.message))
        .collect();
    let errors = if errors.is_empty() {
        "Unknown validation error".to_string()
    } else {
        errors.join("\n")
    };
    let received = serde_json::to_string_pretty(arguments).unwrap_or_default();
    Err(format!(
        "Validation failed for tool \"{tool_name}\":\n{errors}\n\nReceived arguments:\n{received}"
    ))
}
