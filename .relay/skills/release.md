---
name: release
description: Prepare, build, verify, and recover relay releases. Use for release preparation, local release smoke tests, the release workflow, and failed release CI or announcements.
---

# Releasing relay

Run repository commands from the repo root (two directories above this skill), unless instructed otherwise.

## Required local CI

Always run the complete local CI before every commit and before opening or updating a pull request:

```bash
bash ./ci.sh
```

On Windows, run it from Git Bash, not the WSL launcher. Require all gates to pass: `npm ci --ignore-scripts`, `npm run build`, `npm run check`, the Cargo gates (`cargo fmt`, `cargo clippy`, `cargo test`, including `relay-desktop`), and `./test.sh`. If any gate fails, do not commit or open/update the pull request; fix the cause and rerun the entire CI. Any later source change requires a new complete run. Never substitute `npm test` for `./test.sh`.

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

3. **Run the release script** from an up-to-date `main` (it refuses any other branch, and a `main` that differs from `origin/main`). Work lands on `develop`, the default branch; bring it to `main` first with a pull request from `develop` to `main`, the only pull request to `main` the `PR base` workflow leaves open. The release pushes its commits and tag to `main` directly, which the branch and tag rulesets allow only for repository admins:
   ```bash
   RELAY_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   RELAY_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command; the repo's npm age gate can otherwise block the release lockfile refresh. Review any lockfile or install lock diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed. Then bring those two commits back to `develop`, which `main` is now ahead of: `git push origin main:develop` (a fast-forward; admins may push to `develop` directly).

4. **CI builds the release**: pushing the `vX.Y.Z` tag triggers `.github/workflows/release.yml`. Relay is not published to npm. The `binaries` job checks that the tag matches the package version, builds the standalone binaries for the six platforms with `scripts/build-binaries.sh` (Bun cross-compiles them on Linux) and keeps them as the `relay-binaries-vX.Y.Z` artifact. The `desktop-installers` job then builds the `.msi`, `.dmg` and AppImage on their platforms, each carrying its platform's binary (`windows-x64`, `darwin-arm64`, `linux-x64`) in `resources/relay/`, and keeps them as `relay-desktop-vX.Y.Z-<bundle>` artifacts. Nothing is code-signed and no GitHub release is made. Relay's update notice reads the version in `main`'s `packages/coding-agent/package.json` and links to the workflow's runs, so users are told about `vX.Y.Z` as soon as the release script pushes `main`, before the artifacts exist; check that the run finished before telling anyone a release is out.

5. **If the release workflow fails**: inspect the failed job, fix the cause, and rerun the failed jobs, or run the workflow by hand with the tag. `desktop-installers` downloads the `binaries` artifact of the same run, so it cannot succeed in a run whose `binaries` job failed. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.
