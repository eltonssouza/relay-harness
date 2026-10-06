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

3. **Run the release script**:
   ```bash
   RELAY_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   RELAY_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or install lock diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes the npm release**: pushing the `vX.Y.Z` tag triggers `.github/workflows/release.yml`. The `publish-npm` job checks that the tag matches the package version, builds, runs `npm run check`, `./test.sh` and the packed-consumer smoke test, then runs `scripts/publish.mjs` with npm trusted publishing through GitHub Actions OIDC and environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required. Trusted publishing needs a one-time setup on npmjs.com: each `@relay-harness/*` package must list repository `eltonssouza/relay-harness`, workflow `release.yml` and environment `npm-publish` as a trusted publisher (a package that does not exist yet must be created first, for example by the first manual publish). Relay's update notice reads the latest GitHub release of `eltonssouza/relay-harness` (`tag_name`, leading `v` stripped), so publish the GitHub release for `vX.Y.Z` only after every public workspace package resolves on npm at that version.

5. **Laya model**: only when the model changed. Upload the model to the Hugging Face repository `eltonssouza/relay-laya` first, then release the npm version that embeds its manifest. See "Ship a new model" in `packages/coding-agent/docs/laya.md`.

6. **If CI publish fails**: inspect the failed job. The publish helper is idempotent and skips package versions already on npm. Rerun the failed job, or run the workflow by hand with the tag, after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.
