# Threat Modeling: Procedures and STRIDE Standards

Use this procedure when conducting a structured threat model.

## 1. Data Flow Diagram (DFD) & Trust Boundaries
- Construct a visual or textual Data Flow Diagram:
  - **External Entities**: Users, third-party APIs, webhooks.
  - **Processes**: Web servers, background workers, microservices.
  - **Data Stores**: Databases, object storage, caches.
  - **Data Flows**: HTTP requests, database queries, message queues.
- **Trust Boundaries**: Draw boundaries wherever data transitions between different privilege levels (e.g., untrusted internet $\rightarrow$ DMZ, API gateway $\rightarrow$ internal service mesh, application $\rightarrow$ database).

## 2. STRIDE Threat Analysis Matrix
Evaluate each element crossing a trust boundary against the 6 STRIDE categories:

| Threat ID | STRIDE Category | Component / Boundary | Threat Description | Likelihood | Impact | Mitigation Control |
|---|---|---|---|---|---|---|
| T-01 | Spoofing | Client $\rightarrow$ API Gateway | Attacker forges authentication token | Medium | Critical | Validate JWT signature on server with short expiry |
| T-02 | Tampering | API $\rightarrow$ Database | Attacker injects malicious SQL payload | Low | Critical | Use parameterized queries with ORM allow-list |
| T-03 | Repudiation | Admin Panel | Admin deletes record with no trace | Low | High | Implement immutable, append-only audit logging |
| T-04 | Information Disclosure | Error Handler | Stack trace reveals internal server paths | High | Medium | Generic error handler with internal logging |
| T-05 | Denial of Service | Login Endpoint | Attacker floods login with requests | High | High | Rate limiting by IP and username |
| T-06 | Elevation of Privilege | User Profile | User alters role parameter in body | Medium | Critical | Enforce server-side role authorization |

## 3. Mitigation Verification
- Every mitigation must be verified by an automated test or architectural guardrail.
- Mitigations with High or Critical risk must be resolved before production deployment.
