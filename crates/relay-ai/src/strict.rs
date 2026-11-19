//! JSON-schema constrained sampling, as `packages/ai/src/api/constrained-sampling.ts` does it:
//! whether a tool goes out in strict mode, and the strict form of its schema.
//!
//! Key order follows JavaScript objects: a key that is set again keeps its place, a new key goes
//! last. `serde_json` with `preserve_order` behaves the same, so the schema reaches the provider in
//! the order the TypeScript adapter sends.

use serde_json::{json, Map, Value};

use crate::message::Tool;

/// Whether a provider's strict mode rejects this keyword with this value.
pub type UnsupportedKeyword = fn(&str, &Value) -> bool;

const UNSUPPORTED_KEYS: [&str; 16] = [
    "$ref",
    "$defs",
    "definitions",
    "allOf",
    "oneOf",
    "patternProperties",
    "dependentSchemas",
    "dependencies",
    "unevaluatedProperties",
    "propertyNames",
    "contains",
    "prefixItems",
    "not",
    "if",
    "then",
    "else",
];

/// Why a schema has no strict form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedSchema(pub String);

fn unsupported(reason: impl Into<String>) -> UnsupportedSchema {
    UnsupportedSchema(reason.into())
}

fn type_names(schema: &Map<String, Value>) -> Vec<&Value> {
    match schema.get("type") {
        Some(Value::String(_)) => vec![&schema["type"]],
        Some(Value::Array(types)) => types.iter().collect(),
        _ => Vec::new(),
    }
}

fn is_structured(schema: &Value) -> bool {
    let Value::Object(schema) = schema else {
        return false;
    };
    let types = type_names(schema);
    types
        .iter()
        .any(|kind| *kind == "object" || *kind == "array")
        || schema.contains_key("properties")
        || schema.contains_key("items")
}

fn allows_null(schema: &Value) -> bool {
    let Value::Object(schema) = schema else {
        return false;
    };
    if schema.get("type") == Some(&json!("null"))
        || schema
            .get("type")
            .and_then(Value::as_array)
            .is_some_and(|types| types.contains(&json!("null")))
    {
        return true;
    }
    if schema.get("const") == Some(&Value::Null)
        || schema
            .get("enum")
            .and_then(Value::as_array)
            .is_some_and(|values| values.contains(&Value::Null))
    {
        return true;
    }
    schema
        .get("anyOf")
        .and_then(Value::as_array)
        .is_some_and(|variants| variants.iter().any(allows_null))
}

fn make_node_strict(
    schema: &mut Value,
    unsupported_keyword: Option<UnsupportedKeyword>,
) -> Result<(), UnsupportedSchema> {
    let Value::Object(node) = schema else {
        return Err(unsupported("boolean schemas are unsupported"));
    };
    for key in UNSUPPORTED_KEYS {
        if node.contains_key(key) {
            return Err(unsupported(format!("{key} schemas are unsupported")));
        }
    }
    if let Some(check) = unsupported_keyword {
        for (key, value) in node.iter() {
            if check(key, value) {
                return Err(unsupported(format!("{key}: {value} is unsupported")));
            }
        }
    }
    if let Some(any_of) = node.get_mut("anyOf") {
        let Some(variants) = any_of
            .as_array_mut()
            .filter(|variants| !variants.is_empty())
        else {
            return Err(unsupported("anyOf must contain at least one schema"));
        };
        for variant in variants {
            if is_structured(variant) {
                return Err(unsupported("object and array unions are unsupported"));
            }
            make_node_strict(variant, unsupported_keyword)?;
        }
    }
    if let Some(items) = node.get_mut("items") {
        if items.is_array() {
            return Err(unsupported("tuple schemas are unsupported"));
        }
        make_node_strict(items, unsupported_keyword)?;
    }
    let is_object = node.get("type") == Some(&json!("object"));
    if node.contains_key("properties") && !is_object {
        return Err(unsupported("properties require type object"));
    }
    if !is_object {
        return Ok(());
    }
    if node
        .get("additionalProperties")
        .is_some_and(|value| value != &Value::Bool(false))
    {
        return Err(unsupported(
            "schema-valued or true additionalProperties is unsupported",
        ));
    }
    if node
        .get("properties")
        .is_some_and(|value| !value.is_object())
    {
        return Err(unsupported("object properties must be a schema map"));
    }
    let required: Vec<String> = match node.get("required") {
        None => Vec::new(),
        Some(Value::Array(keys)) if keys.iter().all(Value::is_string) => keys
            .iter()
            .map(|key| key.as_str().unwrap_or_default().to_string())
            .collect(),
        Some(_) => return Err(unsupported("object required must be a string array")),
    };
    // Without `properties`, JavaScript works on a fresh object the schema never sees.
    let mut detached = Map::new();
    let properties = match node.get_mut("properties") {
        Some(Value::Object(properties)) => properties,
        _ => &mut detached,
    };
    let names: Vec<String> = properties.keys().cloned().collect();
    if required.iter().any(|key| !names.contains(key)) {
        return Err(unsupported("required contains an unknown property"));
    }
    for name in &names {
        let property = properties
            .get_mut(name)
            .expect("the name was read from the map");
        make_node_strict(property, unsupported_keyword)?;
        if !required.contains(name) && !allows_null(property) {
            let original = property.take();
            *property = json!({ "anyOf": [original, { "type": "null" }] });
        }
    }
    node.insert(
        "required".to_string(),
        Value::Array(names.into_iter().map(Value::String).collect()),
    );
    node.insert("additionalProperties".to_string(), Value::Bool(false));
    Ok(())
}

/// The strict subset of a tool schema that providers' constrained sampling accepts.
pub fn make_strict_json_schema(
    schema: &Value,
    unsupported_keyword: Option<UnsupportedKeyword>,
) -> Result<Value, UnsupportedSchema> {
    if !schema.is_object() {
        return Err(unsupported("root schema must have type object"));
    }
    let mut strict = schema.clone();
    make_node_strict(&mut strict, unsupported_keyword)?;
    if strict.get("type") != Some(&json!("object")) {
        return Err(unsupported("root schema must have type object"));
    }
    Ok(strict)
}

/// The schema to send: the strict form when `strict`, the tool's own otherwise.
pub fn json_schema_tool_parameters(tool: &Tool, strict: bool) -> Value {
    if strict {
        make_strict_json_schema(&tool.parameters, None).unwrap_or_else(|_| tool.parameters.clone())
    } else {
        tool.parameters.clone()
    }
}

/// Whether a JSON-schema tool goes out in strict mode: `Ok(true)` when it can, `Ok(false)` when
/// it falls back, and an error when the tool requires strict mode and cannot have it.
pub fn resolve_json_schema_strict_sampling(
    tool: &Tool,
    supports_strict_mode: bool,
    unsupported_keyword: Option<UnsupportedKeyword>,
) -> Result<bool, String> {
    let Some(Value::Object(config)) = &tool.constrained_sampling else {
        return Ok(false);
    };
    if config.get("type") != Some(&json!("json_schema")) {
        return Ok(false);
    }
    let required = config.get("strict") == Some(&json!("require"));
    if supports_strict_mode {
        return match make_strict_json_schema(&tool.parameters, unsupported_keyword) {
            Ok(_) => Ok(true),
            Err(_) if !required => Ok(false),
            Err(UnsupportedSchema(reason)) => Err(format!(
                "Tool \"{}\" requires JSON-schema constrained sampling, but {reason}.",
                tool.name
            )),
        };
    }
    if required {
        return Err(format!(
            "Tool \"{}\" requires JSON-schema constrained sampling, but strict tools are unsupported.",
            tool.name
        ));
    }
    Ok(false)
}

/// A grammar tool: its syntax (`lark` or `regex`), the grammar, and the one string property its
/// input fills.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grammar {
    pub syntax: &'static str,
    pub definition: String,
    pub input_property: String,
}

fn grammar_input_property(tool: &Tool) -> Result<String, String> {
    let schema = &tool.parameters;
    if schema.get("type") != Some(&json!("object")) {
        return Err("grammar constrained sampling requires an object parameter schema".into());
    }
    let property = match schema.get("required").and_then(Value::as_array) {
        Some(required) if required.len() == 1 && required[0].is_string() => {
            required[0].as_str().unwrap_or_default().to_string()
        }
        _ => {
            return Err(
                "grammar constrained sampling requires exactly one required string property".into(),
            )
        }
    };
    let entry = schema
        .get("properties")
        .and_then(|properties| properties.get(&property));
    let truthy = match entry {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(_) => true,
    };
    if !truthy {
        return Err(format!(
            "grammar constrained sampling requires a properties entry for {property}"
        ));
    }
    if entry.and_then(|entry| entry.get("type")) != Some(&json!("string")) {
        return Err(format!(
            "grammar constrained sampling property {property} must have type string"
        ));
    }
    Ok(property)
}

/// The grammar to send a tool with, when it asks for one and the model takes OpenAI grammar
/// tools. Fails when the tool's grammar configuration cannot be used.
pub fn resolve_grammar_constrained_sampling(
    tool: &Tool,
    supports_openai_grammar_tools: bool,
) -> Result<Option<Grammar>, String> {
    let Some(Value::Object(config)) = &tool.constrained_sampling else {
        return Ok(None);
    };
    if config.get("type") != Some(&json!("grammar")) || !supports_openai_grammar_tools {
        return Ok(None);
    }
    let variant = |name: &str| {
        config
            .get("variants")
            .and_then(|variants| variants.get(name))
            .and_then(Value::as_str)
            .filter(|definition| !crate::text::is_blank(definition))
            .map(str::to_string)
    };
    let (syntax, definition) = match (variant("openai_lark"), variant("openai_regex")) {
        (Some(lark), _) => ("lark", lark),
        (None, Some(regex)) => ("regex", regex),
        (None, None) => {
            return Err(format!(
                "Tool \"{}\" cannot use grammar constrained sampling: no supported grammar variant was provided.",
                tool.name
            ))
        }
    };
    let input_property = grammar_input_property(tool).map_err(|reason| {
        format!(
            "Tool \"{}\" cannot use grammar constrained sampling: {reason}.",
            tool.name
        )
    })?;
    Ok(Some(Grammar {
        syntax,
        definition,
        input_property,
    }))
}

/// The input property of every grammar tool, by tool name.
pub fn grammar_tool_input_properties(
    tools: &[Tool],
    supports_openai_grammar_tools: bool,
) -> Result<Vec<(String, String)>, String> {
    let mut properties: Vec<(String, String)> = Vec::new();
    for tool in tools {
        if let Some(grammar) =
            resolve_grammar_constrained_sampling(tool, supports_openai_grammar_tools)?
        {
            properties.retain(|(name, _)| name != &tool.name);
            properties.push((tool.name.clone(), grammar.input_property));
        }
    }
    Ok(properties)
}

/// A grammar tool call's input: the string in its input property.
pub fn grammar_tool_input(
    tool_name: &str,
    arguments: &Map<String, Value>,
    input_property: &str,
) -> Result<String, String> {
    match arguments.get(input_property) {
        Some(Value::String(input)) => Ok(input.clone()),
        _ => Err(format!(
            "Grammar tool call \"{tool_name}\" requires argument \"{input_property}\" to be a string."
        )),
    }
}
