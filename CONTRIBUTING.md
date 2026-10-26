# Contributing to relay

This guide exists to save both sides time.

## Philosophy

First things first: **relay's core is minimal**.

If your feature does not belong in the core, it should be an extension. PRs that bloat the core will likely be rejected.

Relay's core exists to be minimal and to be extensible so that it can be influenced and manipulated by extensions.  Even hook points for extensions however should be well considered and discussed to avoid adding unmaintainable bloat and complex interactions.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated slop without understanding it is not.

If you use an agent, run it from the `relay` root directory so it picks up `AGENTS.md` automatically. Your agent must follow the rules and guidelines in that file.

## Issues First

Open an issue before a pull request, and wait for a maintainer to agree with the change. Pull requests for changes nobody discussed may be closed without review. Small fixes such as typos are the exception.

## Quality Bar For Issues

If you open an issue, you must use one of the two GitHub issue templates.

If you open an issue, keep it short, concrete, and worth reading.

- Keep it concise. If it does not fit on one screen, it is too long.
- Write in your own voice (do not use an LLM to generate text, if you must, follow up with a clearly AI labeled comment).
- State the bug or request clearly.
- Explain why it matters.
- If you want to implement the change yourself, say so.

Issues that do not meet this bar may be closed without a reply.

## Blocking

If you ignore this document twice, or if you spam the tracker with agent-generated issues, your GitHub account will be permanently blocked.

If you send a large volume of issues through automation, your GitHub account will be permanently blocked.

## Before Submitting a PR

Open pull requests against `develop`, the default branch. `main` only receives `develop` when a release is made; a pull request to `main` from any other branch is closed automatically.

Before every commit and before opening or updating a PR, run the complete CI locally:

```bash
bash ./ci.sh
```

The runner installs dependencies with `npm ci --ignore-scripts`, builds, runs
`npm run check`, validates publication with `node scripts/publish.mjs --dry-run`,
runs the isolated `./test.sh` suite, and checks packed SDK/CLI installation with
`npm run check:package-install`. It stops at the first failure. Fix any failure and
rerun the entire runner before committing, pushing PR updates or submitting a PR.
Source changes after a successful run require another complete run.

Use Node 22.19 or newer, Git, Bash, ripgrep and fd. On Linux, install the native
build prerequisites (`libcairo2-dev`, `libpango1.0-dev`, `libjpeg-dev`, `libgif-dev`,
`librsvg2-dev`) and use fd supporting `--no-require-git` (10.2.0 works). On Windows,
run in Git Bash; from PowerShell use `& 'C:\Program Files\Git\bin\bash.exe' ./ci.sh`
when Git is installed at that location. A Windows run does not validate Linux-only
tests; Linux validation remains a separate requirement when applicable.

GitHub Actions no longer runs CI for PRs or branch pushes. Include the validated
commit, operating system, Node version and local result in the PR description.
The required `local/verify` status may report success only after the full local
runner passes for that commit. Local CI does not approve a Laya model or
distribution.

Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers.

If you are adding a new provider to `packages/ai`, see `AGENTS.md` for required tests.

## Questions?

Ask in an issue using the contribution template.

## FAQ

### Why do some issues get no reply?

A reply is maintenance work too. Low-signal issues, unclear reports, duplicates, and issues that do not follow this guide may be closed without discussion. This keeps time available for reproducible bugs, thoughtful requests, and contributors who have done the work to make their report actionable.

### Why not let AI triage everything?

AI can help group duplicates, summarize reports, and spot missing information. It is not trusted to make final maintainer decisions. Polished AI-generated issues can still be wrong, misleading, or expensive to investigate. Human review remains the final gate.

## Where can I learn about plans?

Larger changes are discussed in issues of this repository before any code is written.
