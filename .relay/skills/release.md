---
name: release
description: Prepare, publish, verify, and recover relay releases. Use for release preparation, local release smoke tests, publishing, and failed release CI or announcements.
---

# Releasing relay

Run repository commands from the repo root (two directories above this skill), unless instructed otherwise.

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/relay-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/relay-local-release/node/relay --help
   /tmp/relay-local-release/node/relay --version
   /tmp/relay-local-release/node/relay --list-models
   /tmp/relay-local-release/node/relay -p "Say exactly: ok"
   /tmp/relay-local-release/node/relay

   # Bun binary smoke tests
   /tmp/relay-local-release/bun/relay --help
   /tmp/relay-local-release/bun/relay --version
   /tmp/relay-local-release/bun/relay --list-models
   /tmp/relay-local-release/bun/relay -p "Say exactly: ok"
   /tmp/relay-local-release/bun/relay
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/relay-local-release/node/relay` and `/tmp/relay-local-release/bun/relay` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

   Load and follow [interactive-testing.md](interactive-testing.md) for the tmux workflow. Start each release binary from `/tmp`, not the repo root.

3. **Run the release script** from an up-to-date `main` (it refuses any other branch, and a `main` that differs from `origin/main`):
   ```bash
   RELAY_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   RELAY_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or install lock diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes the npm release**: pushing the `vX.Y.Z` tag triggers `.github/workflows/release.yml`. The `publish-npm` job checks that the tag matches the package version, builds, runs `npm run check`, `./test.sh` and the packed-consumer smoke test, then runs `scripts/publish.mjs` in environment `npm-publish`, authenticated by its `NPM_TOKEN` secret (a granular token with read and write on the `@relay-harness` scope and 2FA bypass); no local `npm publish`, OTP, or WebAuthn flow is required. The token expires: when the job fails at `npm whoami` or `npm publish` with 401 or 403, create a new token and replace the secret. Provenance is off because npm only issues it for public repositories; once the repository is public, switch to trusted publishing (see the comment at the top of `release.yml`). Relay's update notice reads the `latest` version of `@relay-harness/coding-agent` from the npm registry, so users are told about `vX.Y.Z` as soon as that package resolves at it. `coding-agent` is published last (it depends on the others), so every dependency is already on npm by then. The registry shows a new version a few minutes after `npm publish` accepts it, and a new package first appears as a `0.0.0-stage` placeholder; check the registry rather than the job status before telling anyone a release is out. No GitHub release is needed.

5. **Laya model**: only when the model changed. Upload the model to the Hugging Face repository `eltonssouza/relay-laya` first, then release the npm version that embeds its manifest. See "Ship a new model" in `packages/coding-agent/docs/laya.md`.

6. **If CI publish fails**: inspect the failed job. The publish helper is idempotent and skips package versions already on npm. Rerun the failed job, or run the workflow by hand with the tag, after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.
