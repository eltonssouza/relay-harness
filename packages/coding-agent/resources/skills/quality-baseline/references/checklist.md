# quality-baseline — The 6 Verification Categories in Detail

Use this reference checklist when conducting a quality baseline audit. Every category must be evaluated and verified against the criteria below.

---

## 1 — Input Validation
- **Requirement**: Every external input (query parameters, body payloads, headers, cookies, file uploads, webhooks) must be validated at the boundary against a strict allow-list schema.
- **Verification Criteria**:
  - Type, length, format regex, range, and object ownership validated.
  - Sinks protected: raw user input never reaches database queries, system commands, templates, or filesystem paths unparameterized.
  - File uploads validated by file signature (magic bytes), stored outside web root with randomized names.
- **Red Flags**:
  - Client-side validation only.
  - Raw string concatenation in SQL, NoSQL, or shell calls.
  - Direct object reference without verifying caller ownership (IDOR/BOLA).

---

## 2 — Explicit Error Handling
- **Requirement**: Every external operation (database, API, SMTP, filesystem) must have explicit error handling, timeouts, and fallbacks.
- **Verification Criteria**:
  - Explicit timeouts configured on all network/database boundaries.
  - Idempotent retries with exponential backoff and jitter for transient failures.
  - Circuit breakers or graceful degradation paths for non-critical dependencies.
  - Errors logged internally with full context and stack trace; sanitized generic error returned to callers.
- **Red Flags**:
  - Swallowed exceptions (empty `catch` blocks or `e.printStackTrace()` without propagation).
  - Infinite or unconfigured timeouts.
  - Leaking internal stack traces, database schema, or server version banners in HTTP error responses.

---

## 3 — Test Coverage
- **Requirement**: Every acceptance criterion and business rule must have automated tests; happy paths and error paths must be verified.
- **Verification Criteria**:
  - Unit tests for core domain logic and calculations.
  - Integration tests for database queries and external service contracts.
  - Security test cases: malformed inputs, unauthorized access attempts, boundary condition payloads.
  - Tests are deterministic with isolated state and fixtures.
- **Red Flags**:
  - Happy-path only test suites.
  - Flaky tests or tests containing arbitrary `sleep` timeouts.
  - Assertions that test implementation details rather than observable behavior.

---

## 4 — No Hardcoded Assumptions
- **Requirement**: All environment-dependent values and operational parameters must be externalized.
- **Verification Criteria**:
  - URLs, ports, database connection strings, timeouts, and secrets originate from configuration files or environment variables.
  - UTC timestamps used for all date/time calculations and database storage.
  - Explicit encoding (UTF-8) specified for all text and file operations.
- **Red Flags**:
  - `localhost` or hardcoded IP addresses in production code.
  - Hardcoded API keys, tokens, or private credentials in version control.
  - Relying on server system timezone.

---

## 5 — Security Fundamentals
- **Requirement**: Authentication, authorization, and data protection must follow modern standards.
- **Verification Criteria**:
  - Authentication enforced on all protected endpoints.
  - Server-side authorization confirms the caller owns or has permissions to access the requested resource.
  - Passwords hashed with salted Argon2id or bcrypt.
  - Tokens and sessions are single-use or short-lived, with cryptographically secure generation.
- **Red Flags**:
  - User enumeration vectors (different error messages for "user not found" vs "invalid password").
  - Unauthenticated admin or internal endpoints.
  - Secrets, passwords, or tokens printed in logs.

---

## 6 — Structured Observability
- **Requirement**: Production systems must emit sufficient telemetry to diagnose failures from outside.
- **Verification Criteria**:
  - Structured JSON logging with timestamp, level, correlation/trace ID, and contextual parameters.
  - Health check endpoints (`/health/live`, `/health/ready`) with dependency status.
  - Key business events and error rates instrumented for alerting.
- **Red Flags**:
  - Logging PII (names, emails, payment cards) or secrets.
  - Unstructured string logs that cannot be parsed by log aggregators.
  - Silent failures where errors occur without any log emission.
