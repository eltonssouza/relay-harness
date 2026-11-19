//! JSON Schema checking as TypeBox 1.3's schema engine does it (`typebox/build/schema/engine`):
//! the keywords in its order, its English messages, and its limit of 8 errors per context.
//!
//! An error pass evaluates every keyword, not stopping at the first failure, so a value gets
//! every error up to the limit. Each branch of `anyOf`, `oneOf` and `allOf`, and each `$ref`
//! target, reports into a context of its own, merged into the parent only when the parent fails.
//! Keywords tracking evaluation (`unevaluatedItems`, `unevaluatedProperties`) and dynamic
//! references are not checked.

use serde_json::{Map, Value};

use super::formats::check_format;
use super::regex::{js_regex, property_pattern};
use crate::text::js_number_to_string;

/// TypeBox's `maxErrors`.
const MAX_ERRORS: usize = 8;

/// One validation error: where, which keyword, and its message.
#[derive(Debug, Clone, PartialEq)]
pub struct SchemaError {
    pub keyword: &'static str,
    /// A JSON pointer, `/a/0/b`, with keys unescaped as TypeBox writes them.
    pub instance_path: String,
    pub message: String,
    /// For `required`: the missing properties.
    pub missing: Vec<String>,
}

/// Errors collected for one context, or none in a plain check.
struct Context {
    collect: bool,
    errors: Vec<SchemaError>,
}

impl Context {
    fn check() -> Self {
        Context {
            collect: false,
            errors: Vec::new(),
        }
    }

    fn errors() -> Self {
        Context {
            collect: true,
            errors: Vec::new(),
        }
    }

    fn at_capacity(&self) -> bool {
        self.collect && self.errors.len() >= MAX_ERRORS
    }

    /// Records an error and fails.
    fn add(&mut self, keyword: &'static str, path: &str, message: String) -> bool {
        self.add_error(SchemaError {
            keyword,
            instance_path: path.to_string(),
            message,
            missing: Vec::new(),
        })
    }

    fn add_error(&mut self, error: SchemaError) -> bool {
        if self.collect && !self.at_capacity() {
            self.errors.push(error);
        }
        false
    }

    fn adopt(&mut self, other: Context) {
        for error in other.errors {
            self.add_error(error);
        }
    }
}

/// A numeric limit keyword: its name, the comparison its message names, and the test.
type Limit = (&'static str, &'static str, fn(f64, f64) -> bool);

/// A schema and the root its `$ref`s resolve against.
pub struct Validator<'a> {
    root: &'a Value,
}

/// `+` of JavaScript numbers for limits in messages.
fn number_text(value: &Value) -> String {
    match value.as_f64() {
        Some(number) => js_number_to_string(number),
        None => value.to_string(),
    }
}

fn is_integer(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number.fract() == 0.0)
}

fn type_matches(name: &str, value: &Value) -> bool {
    match name {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "boolean" => value.is_boolean(),
        "integer" => is_integer(value),
        "number" => value.is_number(),
        "null" => value.is_null(),
        "string" => value.is_string(),
        // `undefined`, `void`, `bigint` and the others never hold for JSON; unknown names pass.
        "bigint" | "constructor" | "function" | "symbol" | "undefined" | "void" => false,
        _ => true,
    }
}

/// `IsDeepEqual`: arrays and objects by content, other values strictly.
pub(crate) fn deep_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(a, b)| deep_equal(a, b))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right.get(key).is_some_and(|other| deep_equal(value, other))
                })
        }
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        _ => left == right,
    }
}

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn code_point(units: &[u16], index: usize) -> u32 {
    let unit = u32::from(units[index]);
    if (0xD800..=0xDBFF).contains(&unit) {
        if let Some(&low) = units.get(index + 1) {
            let low = u32::from(low);
            if (0xDC00..=0xDFFF).contains(&low) {
                return 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
            }
        }
    }
    unit
}

fn code_point_length(point: u32) -> usize {
    if point > 0xFFFF {
        2
    } else {
        1
    }
}

fn is_combining_mark(point: u32) -> bool {
    matches!(point, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0xFE20..=0xFE2F)
}

fn is_variation_selector(point: u32) -> bool {
    (0xFE00..=0xFE0F).contains(&point)
}

fn is_regional_indicator(point: u32) -> bool {
    (0x1F1E6..=0x1F1FF).contains(&point)
}

fn consume_modifiers(units: &[u16], mut index: usize) -> usize {
    while index < units.len() {
        let point = code_point(units, index);
        if is_combining_mark(point) || is_variation_selector(point) {
            index += code_point_length(point);
        } else {
            break;
        }
    }
    index
}

/// TypeBox's grapheme cluster step (`NextGraphemeClusterIndex`).
fn next_cluster(units: &[u16], start: usize) -> usize {
    let first = code_point(units, start);
    let mut end = consume_modifiers(units, start + code_point_length(first));
    while end + 1 < units.len() && units[end] == 0x200D {
        let next = code_point(units, end + 1);
        end = consume_modifiers(units, end + 1 + code_point_length(next));
    }
    if is_regional_indicator(first)
        && end < units.len()
        && is_regional_indicator(code_point(units, end))
    {
        end += code_point_length(code_point(units, end));
    }
    end
}

fn is_grapheme_unit(unit: u16) -> bool {
    let unit = u32::from(unit);
    unit >= 0x0300
        && ((0xD800..=0xDBFF).contains(&unit)
            || is_combining_mark(unit)
            || is_variation_selector(unit)
            || unit == 0x200D)
}

/// `IsMinLength`: at least `limit` graphemes, by TypeBox's fast path and segmentation.
fn has_min_length(text: &str, limit: f64) -> bool {
    if limit <= 0.0 {
        return true;
    }
    let units = utf16(text);
    if (units.len() as f64) < limit {
        return false;
    }
    let mut index = 0;
    loop {
        if is_grapheme_unit(units[index]) {
            let (mut count, mut at) = (0.0, 0);
            while at < units.len() {
                at = next_cluster(&units, at);
                count += 1.0;
                if count >= limit {
                    return true;
                }
            }
            return false;
        }
        index += 1;
        if index as f64 >= limit {
            return true;
        }
    }
}

/// `IsMaxLength`: at most `limit` graphemes.
fn has_max_length(text: &str, limit: f64) -> bool {
    let units = utf16(text);
    if units.len() as f64 <= limit {
        return true;
    }
    let mut index = 0;
    loop {
        if is_grapheme_unit(units[index]) {
            let (mut count, mut at) = (0.0, 0);
            while at < units.len() {
                at = next_cluster(&units, at);
                count += 1.0;
                if count > limit {
                    return false;
                }
            }
            return true;
        }
        index += 1;
        if index as f64 > limit {
            return false;
        }
    }
}

/// `IsMultipleOf`, with TypeBox's tolerance for fractions.
fn is_multiple_of(value: f64, divisor: f64) -> bool {
    if !value.is_finite() {
        return true;
    }
    if value.fract() == 0.0 && (1.0 / divisor) % 1.0 == 0.0 {
        return true;
    }
    let remainder = value % divisor;
    remainder
        .abs()
        .min((remainder - divisor).abs())
        .min((remainder + divisor).abs())
        < 1e-10
}

/// A JSON pointer fragment (`#/$defs/name`) in `root`.
fn resolve<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    let pointer = reference.strip_prefix('#')?;
    if pointer.is_empty() {
        return Some(root);
    }
    let mut target = root;
    for part in pointer.strip_prefix('/')?.split('/') {
        let part = part.replace("~1", "/").replace("~0", "~");
        target = match target {
            Value::Object(object) => object.get(&part)?,
            Value::Array(array) => array.get(part.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(target)
}

fn keys_list(keys: &[String]) -> String {
    keys.join(", ")
}

impl<'a> Validator<'a> {
    pub fn new(root: &'a Value) -> Self {
        Validator { root }
    }

    /// `Check`: whether the value is valid.
    pub fn check(&self, value: &Value) -> bool {
        self.eval(self.root, value, "", &mut Context::check())
    }

    /// `Errors`: up to 8 errors, in TypeBox's order.
    pub fn errors(&self, value: &Value) -> Vec<SchemaError> {
        let mut context = Context::errors();
        self.eval(self.root, value, "", &mut context);
        context.errors
    }

    /// Whether `value` is valid for a schema inside this one, its `$ref`s resolved against the root.
    pub(crate) fn check_schema(&self, schema: &Value, value: &Value) -> bool {
        self.eval(schema, value, "", &mut Context::check())
    }

    fn sub_check(&self, schema: &Value, value: &Value) -> bool {
        self.check_schema(schema, value)
    }

    /// `ErrorSchema`: every keyword evaluated, the result their conjunction.
    fn eval(&self, schema: &Value, value: &Value, path: &str, ctx: &mut Context) -> bool {
        if ctx.at_capacity() {
            return false;
        }
        let object = match schema {
            Value::Bool(true) => return true,
            Value::Bool(false) => return ctx.add("boolean", path, "schema is false".into()),
            Value::Object(object) => object,
            _ => return true,
        };
        let mut valid = true;
        if let Some(kind) = object.get("type") {
            valid &= self.keyword_type(kind, value, path, ctx);
        }
        if let Value::Object(map) = value {
            valid &= self.object_keywords(object, map, path, ctx);
        }
        if let Value::Array(items) = value {
            valid &= self.array_keywords(object, items, path, ctx);
        }
        if let Value::String(text) = value {
            valid &= self.string_keywords(object, text, path, ctx);
        }
        if let Some(number) = value.as_f64().filter(|_| value.is_number()) {
            valid &= Self::number_keywords(object, number, path, ctx);
        }
        valid &= self.logic_keywords(object, value, path, ctx);
        valid
    }

    fn keyword_type(&self, kind: &Value, value: &Value, path: &str, ctx: &mut Context) -> bool {
        let (valid, message) = match kind {
            Value::String(name) => (type_matches(name, value), format!("must be {name}")),
            Value::Array(names) => {
                let names: Vec<&str> = names.iter().filter_map(Value::as_str).collect();
                (
                    names.iter().any(|name| type_matches(name, value)),
                    format!("must be either {}", names.join(" or ")),
                )
            }
            _ => (true, String::new()),
        };
        valid || ctx.add("type", path, message)
    }

    fn object_keywords(
        &self,
        schema: &Map<String, Value>,
        value: &Map<String, Value>,
        path: &str,
        ctx: &mut Context,
    ) -> bool {
        let mut valid = true;
        if let Some(Value::Array(required)) = schema.get("required") {
            let missing: Vec<String> = required
                .iter()
                .filter_map(Value::as_str)
                .filter(|key| !value.contains_key(*key))
                .map(str::to_string)
                .collect();
            if !missing.is_empty() {
                valid &= ctx.add_error(SchemaError {
                    keyword: "required",
                    instance_path: path.to_string(),
                    message: format!("must have required properties {}", keys_list(&missing)),
                    missing,
                });
            }
        }
        if let Some(additional) = schema.get("additionalProperties") {
            let known = property_pattern(schema);
            let mut extra = false;
            for (key, item) in value {
                let matched = known
                    .as_ref()
                    .is_some_and(|pattern| pattern.is_match(key).unwrap_or(false));
                if !matched && !self.eval(additional, item, &format!("{path}/{key}"), ctx) {
                    extra = true;
                }
            }
            if extra {
                valid &= ctx.add(
                    "additionalProperties",
                    path,
                    "must not have additional properties".into(),
                );
            }
        }
        if let Some(Value::Object(dependent)) = schema.get("dependentRequired") {
            for (property, needed) in dependent {
                if !value.contains_key(property) {
                    continue;
                }
                let missing: Vec<String> = needed
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|key| !value.contains_key(*key))
                    .map(str::to_string)
                    .collect();
                if !missing.is_empty() {
                    valid &= ctx.add(
                        "dependentRequired",
                        path,
                        format!(
                            "must have properties {} when property {property} is present",
                            keys_list(&missing)
                        ),
                    );
                }
            }
        }
        if let Some(Value::Object(patterns)) = schema.get("patternProperties") {
            for (pattern, sub) in patterns {
                let Some(regex) = js_regex(pattern) else {
                    continue;
                };
                for (key, item) in value {
                    if regex.is_match(key).unwrap_or(false) {
                        valid &= self.eval(sub, item, &format!("{path}/{key}"), ctx);
                    }
                }
            }
        }
        if let Some(Value::Object(properties)) = schema.get("properties") {
            for (key, sub) in properties {
                if let Some(item) = value.get(key) {
                    valid &= self.eval(sub, item, &format!("{path}/{key}"), ctx);
                }
            }
        }
        if let Some(names) = schema.get("propertyNames") {
            let invalid: Vec<String> = value
                .keys()
                .filter(|key| !self.sub_check(names, &Value::String((*key).clone())))
                .cloned()
                .collect();
            if !invalid.is_empty() {
                valid &= ctx.add(
                    "propertyNames",
                    path,
                    format!("property names {} are invalid", keys_list(&invalid)),
                );
            }
        }
        if let Some(limit) = schema.get("minProperties").and_then(Value::as_f64) {
            if (value.len() as f64) < limit {
                valid &= ctx.add(
                    "minProperties",
                    path,
                    format!(
                        "must not have fewer than {} properties",
                        js_number_to_string(limit)
                    ),
                );
            }
        }
        if let Some(limit) = schema.get("maxProperties").and_then(Value::as_f64) {
            if (value.len() as f64) > limit {
                valid &= ctx.add(
                    "maxProperties",
                    path,
                    format!(
                        "must not have more than {} properties",
                        js_number_to_string(limit)
                    ),
                );
            }
        }
        valid
    }

    fn array_keywords(
        &self,
        schema: &Map<String, Value>,
        value: &[Value],
        path: &str,
        ctx: &mut Context,
    ) -> bool {
        let mut valid = true;
        if let (Some(additional), Some(Value::Array(items))) =
            (schema.get("additionalItems"), schema.get("items"))
        {
            for (index, item) in value.iter().enumerate().skip(items.len()) {
                valid &= self.eval(additional, item, &format!("{path}/{index}"), ctx);
            }
        }
        if let Some(contains) = schema.get("contains") {
            let found = value
                .iter()
                .filter(|item| self.sub_check(contains, item))
                .count() as f64;
            let minimum = schema
                .get("minContains")
                .and_then(Value::as_f64)
                .unwrap_or(1.0);
            if found < minimum {
                valid &= ctx.add(
                    "contains",
                    path,
                    "must contain at least 1 valid item".into(),
                );
            }
            if let Some(maximum) = schema.get("maxContains").and_then(Value::as_f64) {
                if found > maximum {
                    // The English locale has no message of its own for it.
                    valid &= ctx.add(
                        "maxContains",
                        path,
                        "an unknown validation error occurred".into(),
                    );
                }
            }
        }
        match schema.get("items") {
            Some(Value::Array(items)) => {
                for (index, sub) in items.iter().enumerate() {
                    if let Some(item) = value.get(index) {
                        valid &= self.eval(sub, item, &format!("{path}/{index}"), ctx);
                    }
                }
            }
            Some(items) => {
                let offset = schema
                    .get("prefixItems")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                for (index, item) in value.iter().enumerate().skip(offset) {
                    valid &= self.eval(items, item, &format!("{path}/{index}"), ctx);
                }
            }
            None => {}
        }
        if let Some(limit) = schema.get("maxItems").and_then(Value::as_f64) {
            if (value.len() as f64) > limit {
                valid &= ctx.add(
                    "maxItems",
                    path,
                    format!(
                        "must not have more than {} items",
                        js_number_to_string(limit)
                    ),
                );
            }
        }
        if let Some(limit) = schema.get("minItems").and_then(Value::as_f64) {
            if (value.len() as f64) < limit {
                valid &= ctx.add(
                    "minItems",
                    path,
                    format!(
                        "must not have fewer than {} items",
                        js_number_to_string(limit)
                    ),
                );
            }
        }
        if let Some(Value::Array(prefix)) = schema.get("prefixItems") {
            for (index, sub) in prefix.iter().enumerate() {
                if let Some(item) = value.get(index) {
                    valid &= self.eval(sub, item, &format!("{path}/{index}"), ctx);
                }
            }
        }
        if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
            let duplicate = value.iter().enumerate().any(|(index, item)| {
                value[..index]
                    .iter()
                    .any(|earlier| deep_equal(earlier, item))
            });
            if duplicate {
                valid &= ctx.add("uniqueItems", path, "must not have duplicate items".into());
            }
        }
        valid
    }

    fn string_keywords(
        &self,
        schema: &Map<String, Value>,
        value: &str,
        path: &str,
        ctx: &mut Context,
    ) -> bool {
        let mut valid = true;
        if let Some(limit) = schema.get("maxLength").and_then(Value::as_f64) {
            if !has_max_length(value, limit) {
                valid &= ctx.add(
                    "maxLength",
                    path,
                    format!(
                        "must not have more than {} characters",
                        js_number_to_string(limit)
                    ),
                );
            }
        }
        if let Some(limit) = schema.get("minLength").and_then(Value::as_f64) {
            if !has_min_length(value, limit) {
                valid &= ctx.add(
                    "minLength",
                    path,
                    format!(
                        "must not have fewer than {} characters",
                        js_number_to_string(limit)
                    ),
                );
            }
        }
        if let Some(Value::String(format)) = schema.get("format") {
            if !check_format(format, value) {
                valid &= ctx.add("format", path, format!("must match format \"{format}\""));
            }
        }
        if let Some(Value::String(pattern)) = schema.get("pattern") {
            let matched =
                js_regex(pattern).is_some_and(|regex| regex.is_match(value).unwrap_or(false));
            if !matched {
                valid &= ctx.add("pattern", path, format!("must match pattern \"{pattern}\""));
            }
        }
        valid
    }

    fn number_keywords(
        schema: &Map<String, Value>,
        value: f64,
        path: &str,
        ctx: &mut Context,
    ) -> bool {
        let mut valid = true;
        let limits: [Limit; 4] = [
            ("exclusiveMaximum", "<", |value, limit| value < limit),
            ("exclusiveMinimum", ">", |value, limit| value > limit),
            ("maximum", "<=", |value, limit| value <= limit),
            ("minimum", ">=", |value, limit| value >= limit),
        ];
        for (keyword, comparison, holds) in limits {
            if let Some(limit) = schema.get(keyword).filter(|limit| limit.is_number()) {
                if !holds(value, limit.as_f64().unwrap_or(0.0)) {
                    valid &= ctx.add(
                        keyword,
                        path,
                        format!("must be {comparison} {}", number_text(limit)),
                    );
                }
            }
        }
        if let Some(divisor) = schema
            .get("multipleOf")
            .filter(|divisor| divisor.is_number())
        {
            if !is_multiple_of(value, divisor.as_f64().unwrap_or(1.0)) {
                valid &= ctx.add(
                    "multipleOf",
                    path,
                    format!("must be multiple of {}", number_text(divisor)),
                );
            }
        }
        valid
    }

    fn logic_keywords(
        &self,
        schema: &Map<String, Value>,
        value: &Value,
        path: &str,
        ctx: &mut Context,
    ) -> bool {
        let mut valid = true;
        if let Some(Value::String(reference)) = schema.get("$ref") {
            let mut inner = Context {
                collect: ctx.collect,
                errors: Vec::new(),
            };
            let passed = resolve(self.root, reference)
                .is_some_and(|target| self.eval(target, value, path, &mut inner));
            if !passed {
                ctx.adopt(inner);
            }
            valid &= passed;
        }
        if let Some(constant) = schema.get("const") {
            if !deep_equal(value, constant) {
                valid &= ctx.add("const", path, "must be equal to constant".into());
            }
        }
        if let Some(Value::Array(options)) = schema.get("enum") {
            if !options.iter().any(|option| deep_equal(value, option)) {
                valid &= ctx.add(
                    "enum",
                    path,
                    "must be equal to one of the allowed values".into(),
                );
            }
        }
        if let Some(condition) = schema.get("if") {
            let (branch, keyword) = if self.sub_check(condition, value) {
                (schema.get("then"), "then")
            } else {
                (schema.get("else"), "else")
            };
            if let Some(branch) = branch {
                if !self.eval(branch, value, path, ctx) {
                    valid &= ctx.add("if", path, format!("must match \"{keyword}\" schema"));
                }
            }
        }
        if let Some(negated) = schema.get("not") {
            if self.sub_check(negated, value) {
                valid &= ctx.add("not", path, "must not be valid".into());
            }
        }
        if let Some(Value::Array(all)) = schema.get("allOf") {
            let mut failed = Vec::new();
            for sub in all {
                let mut inner = Context {
                    collect: ctx.collect,
                    errors: Vec::new(),
                };
                if !self.eval(sub, value, path, &mut inner) {
                    failed.push(inner);
                }
            }
            if !failed.is_empty() {
                valid = false;
                failed.into_iter().for_each(|inner| ctx.adopt(inner));
            }
        }
        if let Some(Value::Array(any)) = schema.get("anyOf") {
            let mut failed = Vec::new();
            let mut passed = false;
            for sub in any {
                let mut inner = Context {
                    collect: ctx.collect,
                    errors: Vec::new(),
                };
                if self.eval(sub, value, path, &mut inner) {
                    passed = true;
                } else {
                    failed.push(inner);
                }
            }
            if !passed {
                failed.into_iter().for_each(|inner| ctx.adopt(inner));
                valid &= ctx.add("anyOf", path, "must match a schema in anyOf".into());
            }
        }
        if let Some(Value::Array(one)) = schema.get("oneOf") {
            let mut failed = Vec::new();
            let mut passing = 0;
            for sub in one {
                let mut inner = Context {
                    collect: ctx.collect,
                    errors: Vec::new(),
                };
                if self.eval(sub, value, path, &mut inner) {
                    passing += 1;
                } else {
                    failed.push(inner);
                }
            }
            if passing != 1 {
                if passing == 0 {
                    failed.into_iter().for_each(|inner| ctx.adopt(inner));
                }
                valid &= ctx.add(
                    "oneOf",
                    path,
                    "must match exactly one schema in oneOf".into(),
                );
            }
        }
        valid
    }
}
