---
name: review-app-security
description: "Use to conduct application security code reviews, perform source-to-sink taint analysis, verify vulnerability exploitability with Proof-of-Concept, and provide secure remediations."
---

# Skill: review-app-security

## When to Use
Apply this skill when auditing source code for security vulnerabilities, conducting pre-merge security reviews, or evaluating penetration test findings.

## Security Review Procedure

1. **Map Attack Surfaces & Entrypoints**:
   - Identify all untrusted data sources: HTTP request parameters, body payloads, headers, cookies, file uploads, webhooks, and third-party API responses.

2. **Source-to-Sink Taint Analysis**:
   - Follow untrusted input data from the source to execution sinks:
     - SQL/NoSQL sinks $ightarrow$ injection vulnerabilities.
     - DOM/HTML rendering sinks $ightarrow$ Cross-Site Scripting (XSS).
     - Command execution sinks $ightarrow$ Remote Code Execution (RCE).
     - File system sinks $ightarrow$ arbitrary file read/write, path traversal.
     - Object access sinks $ightarrow$ BOLA / IDOR.
   - Verify whether data is adequately sanitized, validated, or parameterized before reaching the sink.

3. **Develop Proof of Concept (PoC)**:
   - For every suspected vulnerability, determine the realistic exploit payload and condition.
   - Formulate a reproducible PoC demonstrating exploitability without causing unnecessary harm.

4. **Provide Production-Ready Remediation**:
   - Provide concrete replacement code that fixes the root cause at the sink or boundary.
   - Apply defense-in-depth: combine boundary validation with safe sink APIs.
