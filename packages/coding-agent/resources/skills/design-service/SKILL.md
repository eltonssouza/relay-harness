---
name: design-service
description: "Use to design robust backend services and endpoints: model data access patterns, define stable API contracts, implement idempotency, handle partial failures, and configure observability."
---

# Skill: design-service

## When to Use
Apply this skill when designing backend microservices, REST/GraphQL endpoints, event handlers, or background worker services.

## Service Design Procedure

1. **Model Data for Real Access Patterns**:
   - Design database schemas and indexing strategies aligned with actual query predicates, joins, and write frequencies.
   - Choose appropriate transaction isolation levels to prevent concurrency anomalies.

2. **Define Stable API Contracts**:
   - Specify endpoint paths, HTTP methods, headers, status codes, and JSON schemas.
   - Define consistent error shapes with machine-readable error codes.
   - Establish pagination, sorting, and payload size limits up front.

3. **Idempotency & Concurrency Safety**:
   - Identify state-changing operations and require idempotency keys on retryable requests.
   - Prevent duplicate processing and data corruption during network retries.

4. **Production Resilience & Stability**:
   - Configure bounded timeouts on every outbound boundary call.
   - Implement exponential backoff with jitter on retries.
   - Apply circuit breakers and bulkheads to prevent cascading service outages.

5. **Structured Observability**:
   - Instrument health checks (`/health/live`, `/health/ready`).
   - Propagate correlation/trace IDs across service boundaries.
   - Emit structured logs with contextual fields (never logging secrets or PII).
