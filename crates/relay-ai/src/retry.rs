//! The retry policy every adapter wraps its request in (`retryProviderRequest`,
//! `packages/ai/src/utils/provider-retry.ts`), which mirrors the OpenAI and Anthropic SDKs.
//!
//! A failed attempt is retried when the server says so (`x-should-retry: true`), and otherwise for
//! a connection failure, 408, 409, 429 and 5xx, unless the server says not to. The wait is the
//! server's (`retry-after-ms`, then `retry-after` in seconds or as an HTTP date), else 0.5 s
//! doubling to 8 s with up to 25% jitter taken off. A server delay over the limit (60 s by
//! default, none when 0) fails at once. Nothing retries unless `max_retries` allows it, and an
//! abort ends the wait.

use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::abort::AbortSignal;
use crate::text::js_parse_float;

pub const DEFAULT_MAX_RETRY_DELAY_MS: f64 = 60_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RetryOptions {
    pub max_retries: u32,
    /// The longest server-requested delay to wait; `None` is 60 s, 0 is no limit.
    pub max_retry_delay_ms: Option<f64>,
}

/// A request that failed at the HTTP level: a status, or none when no response came.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HttpError {
    pub status: Option<u16>,
    /// Response headers, names in lowercase.
    pub headers: Vec<(String, String)>,
    pub message: String,
    /// The response body, when one was read.
    pub body: Option<String>,
}

impl HttpError {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum RequestError {
    Http(HttpError),
    /// The signal aborted (`AbortError: Request aborted`).
    Aborted,
    /// Anything else, such as a server delay over the limit.
    Other(String),
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RequestError::Http(error) => formatter.write_str(&error.message),
            RequestError::Aborted => formatter.write_str("Request aborted"),
            RequestError::Other(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for RequestError {}

/// Whether the SDKs would retry this failure.
pub fn is_retryable(error: &HttpError) -> bool {
    match error.header("x-should-retry") {
        Some("true") => return true,
        Some("false") => return false,
        _ => {}
    }
    match error.status {
        None => true,
        Some(status) => matches!(status, 408 | 409 | 429) || status >= 500,
    }
}

fn check_server_delay(
    delay_ms: f64,
    max_retry_delay_ms: Option<f64>,
    message: &str,
) -> Result<f64, String> {
    let max = max_retry_delay_ms.unwrap_or(DEFAULT_MAX_RETRY_DELAY_MS);
    if max > 0.0 && delay_ms > max {
        return Err(format!(
            "Server requested {}s retry delay (max: {}s). {message}",
            (delay_ms / 1000.0).ceil(),
            (max / 1000.0).ceil()
        ));
    }
    Ok(delay_ms)
}

/// How long to wait before retry `retry_index` (0 for the first), in milliseconds; `now_ms` is
/// the current Unix time and `random` a number in [0, 1).
pub fn retry_delay_ms(
    error: &HttpError,
    retry_index: u32,
    max_retry_delay_ms: Option<f64>,
    now_ms: f64,
    random: f64,
) -> Result<f64, String> {
    if let Some(value) = error
        .header("retry-after-ms")
        .filter(|value| !value.is_empty())
    {
        let value = js_parse_float(value);
        if value.is_finite() {
            return check_server_delay(value, max_retry_delay_ms, &error.message);
        }
    }
    if let Some(value) = error
        .header("retry-after")
        .filter(|value| !value.is_empty())
    {
        let seconds = js_parse_float(value);
        let delay_ms = if seconds.is_nan() {
            parse_http_date(value).map_or(f64::NAN, |date| date - now_ms)
        } else {
            seconds * 1000.0
        };
        if delay_ms.is_finite() {
            return check_server_delay(delay_ms, max_retry_delay_ms, &error.message);
        }
    }
    let exponential = (0.5 * 2f64.powi(retry_index.min(30) as i32)).min(8.0) * 1000.0;
    Ok(exponential * (1.0 - random * 0.25))
}

/// Run `request`, retrying failures the policy retries. `sleep` waits the given time; `now`
/// and `random` feed the delay. The signal is checked after each failure and ends a wait.
pub async fn retry_with<T, Request, Attempt, Sleep, Wait>(
    options: RetryOptions,
    signal: &AbortSignal,
    mut request: Request,
    mut sleep: Sleep,
    now: impl Fn() -> f64,
    mut random: impl FnMut() -> f64,
) -> Result<T, RequestError>
where
    Request: FnMut() -> Attempt,
    Attempt: Future<Output = Result<T, RequestError>>,
    Sleep: FnMut(Duration) -> Wait,
    Wait: Future<Output = ()>,
{
    let mut remaining = options.max_retries;
    loop {
        let error = match request().await {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };
        if signal.is_aborted() {
            return Err(RequestError::Aborted);
        }
        let RequestError::Http(http) = &error else {
            return Err(error);
        };
        if remaining == 0 || !is_retryable(http) {
            return Err(error);
        }
        let retry_index = options.max_retries - remaining;
        remaining -= 1;
        let delay = retry_delay_ms(
            http,
            retry_index,
            options.max_retry_delay_ms,
            now(),
            random(),
        )
        .map_err(RequestError::Other)?;
        let wait = Duration::from_secs_f64(delay.max(0.0) / 1000.0);
        tokio::select! {
            _ = sleep(wait) => {}
            _ = signal.aborted() => return Err(RequestError::Aborted),
        }
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

/// A number in [0, 1) for the jitter; it needs no quality beyond spreading retries out.
fn jitter() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.subsec_nanos());
    // A multiplicative hash spreads close clock readings across the range.
    let mixed = (u64::from(nanos)).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 11;
    mixed as f64 / (1u64 << 53) as f64
}

/// `retry_with` on the real clock.
pub async fn retry<T, Request, Attempt>(
    options: RetryOptions,
    signal: &AbortSignal,
    request: Request,
) -> Result<T, RequestError>
where
    Request: FnMut() -> Attempt,
    Attempt: Future<Output = Result<T, RequestError>>,
{
    retry_with(options, signal, request, tokio::time::sleep, now_ms, jitter).await
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// The Unix time in milliseconds of an HTTP date: `Tue, 14 Nov 2023 22:13:30 GMT`, the RFC 850
/// form `Tuesday, 14-Nov-23 22:13:30 GMT` (a two-digit year below 50 is 20xx), in any case. HTTP
/// dates are GMT; a `+hhmm` offset is applied.
pub fn parse_http_date(text: &str) -> Option<f64> {
    let tokens: Vec<&str> = text
        .split(|character: char| character.is_whitespace() || character == ',' || character == '-')
        .filter(|token| !token.is_empty())
        .collect();
    let mut day = None;
    let mut month = None;
    let mut year = None;
    let mut time = None;
    let mut offset_minutes = 0i64;
    for token in tokens {
        let lower = token.to_ascii_lowercase();
        if let Some(index) = MONTHS.iter().position(|name| lower.starts_with(name)) {
            month = Some(index as i64);
        } else if token.contains(':') {
            let parts: Vec<i64> = token
                .split(':')
                .map(|part| part.parse().ok())
                .collect::<Option<_>>()?;
            match parts.as_slice() {
                [hours, minutes] => time = Some((*hours, *minutes, 0)),
                [hours, minutes, seconds] => time = Some((*hours, *minutes, *seconds)),
                _ => return None,
            }
        } else if let Some(digits) = token.strip_prefix('+') {
            let value: i64 = digits.parse().ok()?;
            offset_minutes = (value / 100) * 60 + value % 100;
        } else if token.chars().all(|character| character.is_ascii_digit()) {
            let value: i64 = token.parse().ok()?;
            if day.is_none() && token.len() <= 2 {
                day = Some(value);
            } else if year.is_none() {
                year = Some(match (token.len(), value) {
                    (2, 0..=49) => 2000 + value,
                    (2, _) => 1900 + value,
                    _ => value,
                });
            } else {
                return None;
            }
        } else if matches!(lower.as_str(), "gmt" | "utc" | "ut" | "z") || lower.len() >= 3 {
            // A zone name or a day name.
        } else {
            return None;
        }
    }
    let (hours, minutes, seconds) = time.unwrap_or((0, 0, 0));
    let (day, month, year) = (day?, month?, year?);
    if !(1..=31).contains(&day) || hours > 24 || minutes > 59 || seconds > 59 {
        return None;
    }
    let days = days_from_civil(year, month + 1, day);
    let total_seconds = days * 86_400 + hours * 3600 + minutes * 60 + seconds - offset_minutes * 60;
    Some(total_seconds as f64 * 1000.0)
}

/// Days from 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_http_dates() {
        assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0.0));
        assert_eq!(
            parse_http_date("Tue, 14 Nov 2023 22:13:20 GMT"),
            Some(1_700_000_000_000.0)
        );
        assert_eq!(
            parse_http_date("Tue, 14 Nov 2023 23:13:20 +0100"),
            Some(1_700_000_000_000.0)
        );
        assert_eq!(
            parse_http_date("Wed, 29 Feb 2024 00:00:00 GMT"),
            Some(1_709_164_800_000.0)
        );
        assert_eq!(parse_http_date("later"), None);
        assert_eq!(
            parse_http_date("Tue, 14 Nov 2023 22:13 GMT"),
            Some(1_699_999_980_000.0)
        );
    }
}
