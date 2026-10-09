---
name: build-cicd-pipeline
description: "Use to design and automate robust CI/CD delivery pipelines: configure linting, security scans, automated testing, container builds, progressive deployments, and automated rollback."
---

# Skill: build-cicd-pipeline

## When to Use
Apply this skill when creating or optimizing delivery pipelines in GitHub Actions, GitLab CI, Jenkins, ArgoCD, or cloud-native CI/CD tools.

## Pipeline Architecture Guidelines

1. **Structured Pipeline Stages**:
   - **Stage 1 - Quality & Static Analysis**: Linting, formatting, type checking.
   - **Stage 2 - Security Gates**: Secret scanning, SAST, SCA dependency checks.
   - **Stage 3 - Automated Test Suite**: Parallelized unit and integration tests.
   - **Stage 4 - Container Build & Artifact Packaging**: Multi-stage Docker builds, image vulnerability scanning, image signing.
   - **Stage 5 - Deployment & Verification**: Deployment to staging/production followed by smoke test verification.

2. **Progressive Delivery & Rollback**:
   - Use Canary or Blue/Green deployment strategies for zero-downtime releases.
   - Automate rollback triggers based on error rate and latency metrics.

3. **Security & Secrets Hygiene**:
   - Inject secrets at runtime using dedicated secret managers or OIDC federation; never hardcode credentials in CI YAML files.
