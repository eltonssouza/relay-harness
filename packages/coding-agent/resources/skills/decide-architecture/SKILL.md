---
name: decide-architecture
description: "Use to design software and solution architectures: evaluate architecture styles, balance quality attribute trade-offs, define integration patterns, author ADRs, and create C4 models."
---

# Skill: decide-architecture

## When to Use
Apply this skill when designing new systems, choosing architectural styles, integrating heterogeneous services, evaluating vendor platforms, or resolving high-impact technical dilemmas.

## Architecture Decision Process

1. **Elicit Architectural Drivers & Quality Attributes**:
   - Clarify business drivers, scalability requirements, availability targets, latency budgets, and compliance constraints.
   - Frame non-functional requirements as quantifiable scenarios (e.g., "Handle 10,000 req/sec with p99 latency < 50ms").

2. **Evaluate Architecture Styles & Trade-Offs**:
   - Compare viable architectural styles (Modular Monolith, Event-Driven Architecture, Microservices, Clean/Hexagonal Architecture).
   - Remember: every architecture is a trade-off. Evaluate Total Cost of Ownership (TCO), organizational complexity, operational overhead, and data consistency models.

3. **Design System Boundaries & Integration Patterns**:
   - Establish clean domain boundaries and bounded contexts.
   - Select integration patterns: synchronous APIs (REST, gRPC) vs. asynchronous event streaming (Kafka, RabbitMQ, SQS).
   - Use distributed transaction patterns (Sagas, Outbox pattern) when eventual consistency is required.

4. **Document Architectural Decisions (ADRs) & Views**:
   - Author structured Architecture Decision Records (ADRs) capturing Context, Decision, Options Considered with Trade-Offs, and Consequences.
   - Visualize system structure using C4 model views (Context, Container, Component, Code).
