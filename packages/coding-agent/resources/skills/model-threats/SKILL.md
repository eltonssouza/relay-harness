---
name: model-threats
description: "Use to conduct architectural threat modeling using STRIDE, map trust boundaries and data flows, assess security risks, and design defense-in-depth mitigations."
---

# Skill: model-threats

## When to Use
Apply this skill early in design or when modifying architectural components, data storage, authentication flows, or external integrations.

## Threat Modeling Workflow (STRIDE)

1. **Deconstruct the Architecture (DFD & Trust Boundaries)**:
   - Map external entities, processes, data stores, and data flows.
   - Explicitly draw and label all **Trust Boundaries** (e.g., Browser $\leftrightarrow$ API Gateway, API $\leftrightarrow$ Database, Service $\leftrightarrow$ Third-Party Webhook).

2. **Enumerate Threats using STRIDE**:
   - **S**poofing: Can an attacker impersonate a user or service? (Mitigation: Strong auth, mTLS, signed tokens).
   - **T**ampering: Can data in transit or at rest be altered? (Mitigation: TLS, HMAC, integrity signatures).
   - **R**epudiation: Can a user deny performing an action? (Mitigation: Secure, append-only audit logs).
   - **I**nformation Disclosure: Can sensitive data or secrets leak? (Mitigation: Encryption, least-privilege access, error masking).
   - **D**enial of Service: Can resources be exhausted? (Mitigation: Rate limiting, payload caps, timeouts, autoscaling).
   - **E**levation of Privilege: Can an unprivileged user execute admin actions? (Mitigation: Role-based access control, server-side authorization).

3. **Risk Scoring & Mitigation Ordering**:
   - Score threats using Likelihood $	imes$ Impact (High / Medium / Low).
   - Prioritize mitigations based on risk severity: eliminate critical and high risks before release.
