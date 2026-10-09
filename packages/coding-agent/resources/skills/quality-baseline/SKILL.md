---
name: quality-baseline
description: "Use as a mandatory verification checkpoint before marking any software implementation complete. Enforces a 6-point quality baseline: input validation, error handling, test coverage, configuration hygiene, security fundamentals, and observability."
---

# Skill: quality-baseline

## When to Use
Apply this skill whenever validating code changes, refactors, or new feature implementations before declaring the work complete or opening a pull request. This baseline prevents silent defects that work in local demos but fail in production.

## The 6-Point Quality Baseline

1. **Input Validation**:
   - Validate every external input (HTTP parameters, body payloads, headers, cookies, file uploads, message queues).
   - Enforce strict allow-list schema validation: type, length, format, range, and object ownership.
   - Reject malformed data with structured 4xx client errors; never let unvalidated data reach business logic, database queries, or system commands.

2. **Explicit Error Handling**:
   - Guard every external call (database, network API, file I/O, cache): configure explicit timeouts, retries with backoff, circuit breakers, or graceful fallbacks.
   - Never swallow exceptions; avoid empty `catch` blocks or bare logging without error propagation.
   - Return clean, sanitized error messages to callers; preserve full diagnostic details in internal logs.

3. **Automated Test Coverage**:
   - Ensure every acceptance criterion and business rule has corresponding automated tests.
   - Test both happy paths and negative/boundary error paths.
   - Verify that all tests execute deterministically with zero flakiness.

4. **No Hardcoded Assumptions**:
   - Externalize all environment-specific values: URLs, ports, timeouts, feature flags, limits, and secrets.
   - Use UTC timestamps everywhere.
   - Zero hardcoded secrets, API keys, or credentials in source code.

5. **Security Fundamentals**:
   - Enforce server-side authentication and authorization on all protected resources.
   - Eliminate BOLA/IDOR by verifying tenant and user ownership of target objects.
   - Use parameterized queries, context-aware output encoding, and modern password hashing (Argon2id/bcrypt).

6. **Structured Observability**:
   - Log errors and critical events with contextual metadata (timestamp, correlation/trace ID, endpoint, user ID).
   - Never log secrets, passwords, tokens, or Personally Identifiable Information (PII).
   - Provide health check endpoints (`/health/live`, `/health/ready`).

## Execution Procedure
1. Review the proposed code diff against each of the 6 baseline points.
2. If any check fails, flag the exact file and line, explain the risk, and provide the remediation.
3. Certify completion only when all 6 categories are verified.
