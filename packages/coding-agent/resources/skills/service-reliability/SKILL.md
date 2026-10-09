---
name: service-reliability
description: "Use to engineer and maintain service reliability: define user-centric SLIs/SLOs, manage error budgets, implement full-stack observability (Golden Signals), and configure actionable alerting."
---

# Skill: service-reliability

## When to Use
Apply this skill when defining reliability standards, establishing service level objectives, instrumenting telemetry, or setting production alerting policies.

## Reliability Engineering Guidelines

1. **SLI / SLO Framework & Error Budget**:
   - Define user-centric Service Level Indicators (SLIs) measuring availability and latency.
   - Establish realistic Service Level Objectives (SLOs) (e.g., 99.9% successful requests over 30 days).
   - Establish an Error Budget policy that guides release pacing when budgets are threatened.

2. **Full-Stack Observability (Four Golden Signals)**:
   - Instrument the Four Golden Signals: **Latency** (response times), **Traffic** (demand), **Errors** (failure rate), and **Saturation** (resource utilization).
   - Use distributed tracing (OpenTelemetry) to map end-to-end transaction latency across microservices.

3. **Actionable Alerting & Incident Readiness**:
   - Alert on symptoms and SLO burn rates, not individual server causes.
   - Every production alert must link to an actionable, step-by-step triage runbook.
