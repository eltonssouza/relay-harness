# Core Engineering Skills Catalog

This directory contains the standardized, self-contained **Skills Catalog** designed for modern agentic AI workflows and LLM execution.

All skills are decoupled from hardcoded models (model selection and routing are managed externally by **Laya**) and operate independently of legacy library lookups, terminal CLI commands, or arbitrary gate protocols.

## Skills Matrix (19 Orthogonal Capabilities)

| # | Skill | Primary Responsibility |
|---|---|---|
| 1 | [`quality-baseline`](quality-baseline/SKILL.md) | Enforces the 6-point software quality baseline before marking code complete |
| 2 | [`implement-feature-tdd`](implement-feature-tdd/SKILL.md) | TDD Red-Green-Refactor loop, test lists, and behavior preservation |
| 3 | [`automate-tests`](automate-tests/SKILL.md) | Automated browser (Playwright) & API testing, POM, console/network error monitors |
| 4 | [`secure-coding-patterns`](secure-coding-patterns/SKILL.md) | 15 web security patterns, parameterization, modern crypto, sink protection |
| 5 | [`model-threats`](model-threats/SKILL.md) | Architectural STRIDE threat modeling, trust boundaries, defense-in-depth |
| 6 | [`review-app-security`](review-app-security/SKILL.md) | Source-to-sink taint analysis, finding verification, PoCs, and remediation |
| 7 | [`supply-chain-security`](supply-chain-security/SKILL.md) | Software composition analysis (SCA), lockfile integrity, license compliance |
| 8 | [`incident-response`](incident-response/SKILL.md) | Incident containment, triage, root-cause forensics, blameless post-mortems |
| 9 | [`decide-architecture`](decide-architecture/SKILL.md) | System & solution architecture, quality attribute trade-offs, C4 views, ADRs |
| 10 | [`define-technical-direction`](define-technical-direction/SKILL.md) | Strategic technical leadership, RFC authoring, cross-team engineering guardrails |
| 11 | [`design-service`](design-service/SKILL.md) | Backend service design, API contracts, idempotency, failure handling |
| 12 | [`optimize-database`](optimize-database/SKILL.md) | Query performance tuning, index strategies, EXPLAIN analysis, zero-downtime migrations |
| 13 | [`deliver-vertical-feature`](deliver-vertical-feature/SKILL.md) | End-to-end vertical slice delivery (DB $\rightarrow$ API $\rightarrow$ UI $\rightarrow$ Tests) |
| 14 | [`design-visual-interface`](design-visual-interface/SKILL.md) | UI design system, design tokens, component states, WCAG visual accessibility |
| 15 | [`design-ux-flow`](design-ux-flow/SKILL.md) | User journeys, cognitive friction reduction, usability heuristics |
| 16 | [`build-cicd-pipeline`](build-cicd-pipeline/SKILL.md) | CI/CD automation, progressive delivery (canary/blue-green), container security |
| 17 | [`build-platform-capability`](build-platform-capability/SKILL.md) | Internal developer platform (IDP), self-service golden paths, DevEx metrics |
| 18 | [`service-reliability`](service-reliability/SKILL.md) | SLIs/SLOs, error budgets, Golden Signals telemetry, actionable alerting |
| 19 | [`refine-backlog`](refine-backlog/SKILL.md) | Backlog refinement, DDD ubiquitous language, INVEST stories, BDD acceptance criteria |

## Standards & Design Principles
- **Self-Contained Procedures**: Every skill provides actionable, step-by-step guidance without relying on external unavailable tools.
- **Model Agnostic**: No pinned model slugs or tier mappings; runtime models are allocated dynamically.
- **Positive Imperatives**: Emphasizes explicit, verifiable engineering actions.
