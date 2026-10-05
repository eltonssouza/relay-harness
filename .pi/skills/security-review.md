---
name: security-review
description: Security review of pi code that runs commands, resolves paths, loads extensions, skills, prompts, MCP servers or settings from a project, stores credentials, or authorizes tool calls. Use when changing those surfaces or reviewing a PR that touches them.
---

# Security review for pi

pi runs commands the model chooses and loads executable resources from project directories. Its attack surface is not a web app's; review these surfaces.

## The surfaces

| Surface | Where | What goes wrong |
|---|---|---|
| Command execution | `core/tools/bash.ts`, `core/tools/powershell.ts`, `core/exec.ts`, `!command` config values in `core/resolve-config-value.ts` | A value from the model, a repo file, or settings is parsed as shell syntax |
| Path boundaries | `core/package-manager.ts`, `core/resource-loader.ts`, `core/tools/path-utils.ts` | A path escapes its root |
| Writing that becomes executing | extensions, skills, prompt templates, `.pi/settings.json`, MCP server config, package `scripts` | A file written or cloned now runs code later |
| Trust and authorization | `core/project-trust.ts`, `core/trust-manager.ts`, the harness authorization gate (`packages/agent/src/harness/alignment.ts`) | An untrusted project's resource runs, or a destructive command passes |
| Credentials | `core/auth-storage.ts`, `packages/ai/src/auth/` | A token reaches a log, an error message, a session file, or another provider |

## Patterns for the sinks

| Sink | Wrong shape | Pattern |
|---|---|---|
| Shell | A command built by string concatenation, or `shell: true` with interpolated values | `spawn(file, argv, { shell: false })`, which neutralizes `;`, `&&`, backticks, and pipes. Tools whose purpose is running a shell string (`bash`) are gated by authorization, not escaping. |
| Path | `path.startsWith(root)` | Resolve, then compare with the separator: `resolved === root \|\| resolved.startsWith(root + sep)`, or check `path.relative(root, resolved)` does not start with `..`. A bare prefix lets `/root-evil` pass a check for `/root`. |
| Config and manifests | Spreading parsed JSON into options | Parse with a schema and an explicit field list. |
| Logs and errors | Interpolating raw tool output or tokens | Structured fields; redact credentials before anything is persisted or displayed. |

- **Fail closed.** On error, timeout, or uncertainty, deny. An authorization check that treats a timeout as allow turns an outage into a bypass.
- **Move important rules up this list**, ordered by how well they survive a deadline: a type or API that makes the mistake unrepresentable; a safe default; a check in `npm run check` or a test that fails; a review checklist; a written policy.

## Assert the refusal

A security property is a negative, and a suite of successful paths cannot express one. Each claim needs a test where the system says no:

- an untrusted project's extension, skill, or settings command does not load or run
- a destructive command without authorization is blocked (`packages/agent/test/harness.test.ts`)
- a path outside the root is rejected, including the sibling-prefix case (`/root-evil` against `/root`)
- a credential does not appear in the session file, logs, or an error message

## Writing a finding

Each finding has five parts:

1. **Location**: `file:line`.
2. **Mechanism**: how the input reaches the sink.
3. **Reproduction**: the input, file, or command that triggers it.
4. **Impact for pi**: what an attacker gets, such as code execution on the developer's machine or a leaked provider token.
5. **Fix at the right layer**: one call site, or the boundary that fixes the class. Say which.

Rate exploitability and impact separately, and state the assumptions the rating depends on ("assumes the project was trusted"). Do not report unread scanner output, a theoretical class with no path, or a style preference with a severity.

## Close honestly

Report each surface above as **covered** (cite the file and test), **partial** (say what was not examined), or **gap**. Marking a surface you did not examine as covered is a false success, worse than a gap.
