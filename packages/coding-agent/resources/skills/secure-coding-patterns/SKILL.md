---
name: secure-coding-patterns
description: "Use to implement proven secure coding patterns across applications: parameterization against injection, secure password hashing, context-aware output encoding, CSRF defense, and boundary validation."
---

# Skill: secure-coding-patterns

## When to Use
Apply this skill during feature implementation and code refactoring to ensure code is secure by default against OWASP Top 10 vulnerabilities.

## Core Secure Coding Patterns

1. **Separate Code from Data (Injection Prevention)**:
   - **SQL/NoSQL**: Use parameterized queries and prepared statements. Never concatenate untrusted strings into queries.
   - **OS Commands**: Use exec functions that accept argument arrays (`spawn(cmd, [args])`) rather than shell string execution.
   - **Filesystem**: Resolve target paths and compare against allowed base directories (`path.resolve`, `path.relative`) to eliminate path traversal (`../`).

2. **Validate Inbound, Encode Outbound**:
   - **Inbound Validation**: Validate inputs at boundary entrypoints against allow-lists (type, length, format regex, range, and caller ownership).
   - **Outbound Encoding**: Apply context-aware encoding at the point of rendering (HTML entity, JavaScript string, URL component, CSS) to eliminate XSS.

3. **Authentication & Session Security**:
   - Hash passwords with modern, adaptive, salted algorithms: **Argon2id** (recommended) or **bcrypt**; never use MD5, SHA-1, or plain SHA-256.
   - Rotate session IDs immediately upon login.
   - Store session cookies with `HttpOnly`, `Secure`, and `SameSite=Lax` or `Strict` attributes.

4. **Authorization & IDOR / BOLA Prevention**:
   - Enforce server-side authorization on every endpoint.
   - Never assume that possessing an ID grants access: always verify that the authenticated caller owns or has permissions for the requested object.

5. **Security Headers & CORS**:
   - Configure security headers: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `X-Frame-Options: DENY`.
   - Configure CORS with explicit allowed origins; never allow wildcard `*` on routes that accept authentication credentials.
