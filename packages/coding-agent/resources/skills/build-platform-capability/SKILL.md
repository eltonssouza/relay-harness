---
name: build-platform-capability
description: "Use to build internal developer platform (IDP) capabilities: design self-service tooling, establish golden paths, create reusable infrastructure templates, and track DevEx metrics."
---

# Skill: build-platform-capability

## When to Use
Apply this skill when creating developer tooling, building shared platform infrastructure, standardizing service templates, or improving engineering velocity.

## Platform Engineering Guidelines

1. **Golden Paths & Self-Service Interfaces**:
   - Provide opinionated, standardized templates for creating, testing, and deploying services.
   - Abstract underlying cloud complexity without creating rigid black-box barriers.

2. **Policy as Code & Guardrails**:
   - Embed compliance and security baselines directly into platform automation using policy-as-code (OPA, Kyverno).
   - Ensure the secure, compliant path is the default path.

3. **Developer Velocity & DORA Metrics**:
   - Optimize local development environments and CI build caching to shorten feedback loops.
   - Track and improve DORA metrics: Deployment Frequency, Lead Time for Changes, Change Failure Rate, and Mean Time to Recovery.
