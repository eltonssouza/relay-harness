//! Retrying a whole assistant call on a transient failure (`retryAssistantCall`,
//! `isRetryableAssistantError` and `retryDelayMs` in `packages/ai/src/utils/retry.ts`), as the
//! agent and the summaries do; `retry` is the HTTP-level policy each request already has.
//!
//! A response that is not an error returns at once, and so does an abort. An error whose message
//! looks transient (overload, rate limits, 5xx, dropped connections, timeouts) and is not a quota
//! or billing limit is retried up to `max_retries` times, after `base_delay_ms * 2^(attempt-1)`
//! capped at `max_agent_delay_ms`. An abort during the wait returns the error as aborted.

use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;

use fancy_regex::Regex;

use crate::abort::AbortSignal;
use crate::message::{AssistantMessage, StopReason};

pub const DEFAULT_MAX_AGENT_RETRY_DELAY_MS: f64 = 60_000.0;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Bounded attempts with exponential backoff (`RetryPolicy`), as `settings.retry` sets them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RetryPolicy {
    pub enabled: bool,
    /// Retries after the first call; 0 is none.
    pub max_retries: u32,
    pub base_delay_ms: f64,
    /// The longest delay; 60 s when unset.
    pub max_agent_delay_ms: Option<f64>,
}

/// The wait before retry `attempt` (`retryDelayMs`): `base * 2^(attempt-1)`, the largest safe
/// integer when that is not one, capped.
pub fn agent_retry_delay_ms(
    base_delay_ms: f64,
    max_agent_delay_ms: Option<f64>,
    attempt: u32,
) -> f64 {
    let exponent = attempt.max(1) - 1;
    let delay = base_delay_ms * 2f64.powi(exponent.min(i32::MAX as u32) as i32);
    let safe = if delay.fract() == 0.0 && delay.abs() <= MAX_SAFE_INTEGER {
        delay
    } else {
        MAX_SAFE_INTEGER
    };
    safe.min(max_agent_delay_ms.unwrap_or(DEFAULT_MAX_AGENT_RETRY_DELAY_MS))
}

fn pattern(cell: &'static OnceLock<Regex>, parts: &[&str]) -> &'static Regex {
    cell.get_or_init(|| Regex::new(&format!("(?i){}", parts.join("|"))).expect("a valid pattern"))
}

/// Quota and billing limits, which waiting does not lift.
fn non_retryable() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    pattern(
        &CELL,
        &[
            "GoUsageLimitError",
            "FreeUsageLimitError",
            "Monthly usage limit reached",
            "available balance",
            "insufficient_quota",
            "out of budget",
            "quota exceeded",
            "billing",
            "subscription_sharing_usage_limit_exceeded",
        ],
    )
}

/// Provider load, server and transport failures.
fn retryable() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    pattern(
        &CELL,
        &[
            "overloaded",
            "currently experiencing high demand",
            "model is at capacity",
            "rate.?limit",
            "too many requests",
            "429",
            "500",
            "502",
            "503",
            "504",
            "520",
            "524",
            "service.?unavailable",
            "server.?error",
            "internal.?error",
            "provider.?returned.?error",
            "exceeded request buffer limit while retrying upstream",
            "network.?error",
            "connection.?error",
            "connection.?refused",
            "connection.?lost",
            "other side closed",
            "fetch failed",
            "getaddrinfo",
            "ENOTFOUND",
            "EAI_AGAIN",
            "upstream.?connect",
            "reset before headers",
            "socket hang up",
            "socket connection was closed",
            "timed? out",
            "timeout",
            "terminated",
            "websocket.?closed",
            "websocket.?error",
            "ended without",
            "stream ended before message_stop",
            "stream ended before a terminal response event",
            "http2 request did not get a response",
            "retry delay",
            "you can retry your request",
            "try your request again",
            "please retry your request",
            "ResourceExhausted",
            "subscription_sharing_usage_unavailable",
            "subscription_sharing_user_unavailable",
        ],
    )
}

/// Whether a failed response looks transient (`isRetryableAssistantError`).
pub fn is_retryable_assistant_error(message: &AssistantMessage) -> bool {
    let Some(error) = message
        .error_message
        .as_deref()
        .filter(|error| !error.is_empty())
    else {
        return false;
    };
    if message.stop_reason != StopReason::Error {
        return false;
    }
    if non_retryable().is_match(error).unwrap_or(false) {
        return false;
    }
    retryable().is_match(error).unwrap_or(false)
}

/// What `retry_assistant_call` reports around each retry (`RetryCallbacks`).
pub trait RetryCallbacks: Send + Sync {
    /// Before the wait of retry `attempt` (from 1).
    fn retry_scheduled(
        &self,
        _attempt: u32,
        _max_attempts: u32,
        _delay_ms: f64,
        _error_message: &str,
    ) {
    }
    /// After the wait, before the retried call.
    fn retry_attempt_start(&self) {}
    /// Once, when a loop that retried ends: `success` if a later call completed.
    fn retry_finished(&self, _success: bool, _attempt: u32, _final_error: Option<&str>) {}
}

/// Reports nothing.
pub struct NoCallbacks;

impl RetryCallbacks for NoCallbacks {}

/// Runs `produce` until it answers without a retryable error, within `policy`
/// (`retryAssistantCall`). Without a policy, or with a disabled one, the first answer returns.
pub async fn retry_assistant_call<Produce, Answer>(
    mut produce: Produce,
    policy: Option<RetryPolicy>,
    signal: &AbortSignal,
    callbacks: &dyn RetryCallbacks,
) -> AssistantMessage
where
    Produce: FnMut() -> Answer,
    Answer: Future<Output = AssistantMessage>,
{
    let max_attempts = policy
        .filter(|policy| policy.enabled)
        .map_or(0, |policy| policy.max_retries);
    let mut attempt = 0;
    let mut last_retry: Option<(u32, String)> = None;
    loop {
        let response = produce().await;
        match response.stop_reason {
            StopReason::Aborted => {
                if let Some((attempt, _)) = &last_retry {
                    callbacks.retry_finished(false, *attempt, None);
                }
                return response;
            }
            StopReason::Error => {}
            _ => {
                if let Some((attempt, _)) = &last_retry {
                    callbacks.retry_finished(true, *attempt, None);
                }
                return response;
            }
        }
        if attempt >= max_attempts || !is_retryable_assistant_error(&response) {
            if let Some((attempt, _)) = &last_retry {
                callbacks.retry_finished(false, *attempt, response.error_message.as_deref());
            }
            return response;
        }
        attempt += 1;
        let error = response
            .error_message
            .clone()
            .filter(|error| !error.is_empty())
            .unwrap_or_else(|| "Unknown error".to_string());
        last_retry = Some((attempt, error.clone()));
        let policy = policy.expect("retries need a policy");
        let delay = agent_retry_delay_ms(policy.base_delay_ms, policy.max_agent_delay_ms, attempt);
        callbacks.retry_scheduled(attempt, max_attempts, delay, &error);
        // An abort during the wait ends the loop with the error as an aborted message.
        let aborted = signal.is_aborted()
            || tokio::select! {
                () = tokio::time::sleep(Duration::from_millis(delay.max(0.0) as u64)) => false,
                () = signal.aborted() => true,
            };
        if aborted {
            callbacks.retry_finished(false, attempt, Some(&error));
            return AssistantMessage {
                error_message: None,
                stop_reason: StopReason::Aborted,
                ..response
            };
        }
        callbacks.retry_attempt_start();
    }
}
