---
name: supply-chain-security
description: "Use to assess, audit, and harden the software supply chain: scan third-party dependencies for known vulnerabilities, verify lockfiles, manage licenses, and prevent dependency confusion."
---

# Skill: supply-chain-security

## When to Use
Apply this skill when adding or updating packages, auditing dependencies in CI pipelines, configuring Software Bill of Materials (SBOM), or investigating newly reported CVEs.

## Supply Chain Security Checklist

1. **Dependency Vulnerability Scanning (SCA)**:
   - Run automated Software Composition Analysis (e.g., `npm audit`, `pip-audit`, Trivy, Snyk) in CI/CD.
   - Block merges on dependencies containing unresolved High or Critical CVEs with known exploit paths.

2. **Lockfile Integrity & Deterministic Builds**:
   - Commit lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`, `Cargo.lock`) to version control.
   - Use clean, immutable install commands in CI (`npm ci`, `pnpm install --frozen-lockfile`).

3. **Dependency Poisoning & Typosquatting Defense**:
   - Verify package names and publisher reputations before adding new dependencies.
   - Use internal package registries or scoped namespaces to prevent dependency confusion attacks.
   - Minimize dependency count: avoid pulling in large packages for trivial functions.

4. **License Compliance**:
   - Audit open-source licenses to ensure compatibility with project distribution models (e.g., avoiding unintended copyleft GPL contamination in proprietary commercial products).
