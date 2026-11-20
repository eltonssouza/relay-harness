# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Always run the full local CI before every commit and before opening or updating a PR. Run `bash ./ci.sh` and require every gate to pass: `npm ci --ignore-scripts`, `npm run build`, `npm run check`, the Cargo gates (`cargo fmt`, `cargo clippy`, `cargo test`, including `relay-desktop`), and `./test.sh`. On Windows use Git Bash, not the WSL launcher. This requirement authorizes the build and tests below. Never substitute `npm test` for `./test.sh`. If any gate fails, do not commit, push PR updates or open the PR; fix the cause and rerun the entire local CI. Any subsequent source change requires a new complete run.
- Pull requests to `develop` also run the Linux gate in `.github/workflows/pr-ci.yml` (`bash ./ci.sh`, then a clean-tree check). Branch pushes run no CI, and the workflow does not replace the local run above. Record the validated commit, operating system, Node version and local result in the PR. Publish the required `local/verify` status only for a commit whose complete local CI passed. A Windows pass does not establish Linux validation; preserve that separate gate.
- Outside the required local CI run, never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.
- For local CI parity on Windows, run Linux-only socket/process tests in a Linux container with Node 22 as a non-root user. Use an init/subreaper (`docker run --init` or `tini -s`) so orphaned worker processes are reaped. The `find` tests need `fd` supporting `--no-require-git` (10.2.0 works; Debian Bookworm's 8.6.0 does not). Docker Desktop shares the WSL kernel: platform unit tests must isolate WSL detection instead of inheriting the host's `/proc/version`.

## Native Task and Local Runtime Integration

- Built-in extensions are registered in `packages/coding-agent/src/extensions/index.ts`. Requests execute through the normal agent lifecycle; no mandatory phase workflow is required. Persistent goals use `/goal` and its lifecycle tools; `src/extensions/goal/index.ts` enforces a goal-level token budget. The Harness enforces permissions and verification independently. Request intervention only for critical ambiguity, a missing business decision, scope changes, significant destructive/security/irreversible risk or explicit authorization requirements, after completing safe independent work.
- A constructed provider uses `relay.registerProvider(provider)`; `relay.registerProvider(id, config)` expects raw configuration and does not preserve a provider object's custom classifier implementation. Refresh `modelRuntime` after registration when composing an isolated evaluation. Assert actual handler invocation before treating measurements as evidence (`src/core/extensions/types.ts`, `src/core/model-runtime.ts`).
- Ollama discovery uses only `OLLAMA_HOST` (default `http://127.0.0.1:11434`), `/api/tags` and `/api/show`. It must not scan hosts, install or launch the daemon, or invent model IDs. `/ollama` refreshes the catalog; the `ollama` provider uses that same host's `/v1` API.
- Context7, Playwright and Chrome DevTools are installed stdio MCP servers, registered only on demand through `native_mcp`. Resolve entrypoints through `src/config.ts`; standalone distributions copy the new servers' installed dependency closure with `scripts/copy-native-mcp.mjs`. Keep both binary asset-copy paths updated. Standalone MCP execution requires Node on PATH; browser operations require system Chrome.
- The `subagents` built-in extension (`src/extensions/subagents`) runs Claude Code-format agent definitions in process through the `agent` tool. A brief enters the child with origin `agent` (it authorizes nothing), the parent's constraints are restored into the child's harness, and the child's tool calls reach the parent's evidence through `ctx.recordDelegatedEffects`. Test it with `test/suite/subagents.test.ts` and the faux provider; parent and child responses share one queue, in call order.
- Validate changes with the focused Ollama, task lifecycle and native MCP tests plus `npm run check`. Native MCP handshake tests use an isolated temporary distribution and no provider APIs. On Windows, temporary MCP distribution cleanup uses `rmSync` retries to tolerate observed transient `EPERM` errors after process shutdown.

## Rust Harness Core

- `crates/harness-core` ports the harness core of `packages/agent/src/harness` to Rust. The toolchain is pinned by `rust-toolchain.toml`; direct crate dependencies are pinned to exact versions and `Cargo.lock` is committed and reviewed like `package-lock.json`.
- `bash ./ci.sh` runs `cargo fmt --all --check`, `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --locked`. Run them after changing Rust code.
- `crates/harness-wasm` compiles the engine to WebAssembly. After changing Rust code, run `npm run build:harness-wasm` and commit `packages/agent/src/harness-wasm/module.generated.ts`; `harness-wasm.test.ts` runs the committed module against the reference files below.
- `HarnessCore` runs its pillars through a `HarnessEngine` (`packages/agent/src/harness/engine.ts`): the TypeScript pillars or `createHarnessWasmEngine`. Relay uses the Rust engine; `RELAY_HARNESS_ENGINE=typescript` falls back for one release. `harness.test.ts` runs the HarnessCore scenarios on both engines and checks that they send identical requests.
- `crates/harness-core/src/route.rs` ports general-agents' `scripts/route.py` (the `route_agent` tool). `tests/fixtures/route.json` holds the routing catalog and what `route.py` answered for the orchestrator's routing cases at the pinned commit. After changing the pin in `src/extensions/subagents/catalogs.ts`, run `npm run harness:route-golden -- <general-agents checkout>` (Python 3.12 or later) and make `tests/route.rs` pass.
- `crates/relay-ai` starts the port of the whole agent to Rust: the transcript types, the shared request steps, the Anthropic Messages, OpenAI Responses and OpenAI Chat Completions bodies and stream decoding, the Google Gemini request and stream decoding, and the simple layer that maps provider-neutral options (a thinking level, budgets, an output limit cut to the context window) to each adapter's. `relay_ai::catalog` compiles in the provider files `generate-models.ts` writes to `packages/ai/src/providers/data/`; `tests/catalog.rs` checks that every file is listed and every chat entry reads into `Model` and writes back unchanged, so a new catalog field fails it until `Model` reads it. `relay_ai::auth` resolves each built-in provider's API-key auth, `auth_file` reads and writes `auth.json` under the same `auth.json.lock` directory lock `proper-lockfile` takes, so both agents can share it, and `config_value` resolves the `$VAR` and `!command` values stored keys may be. `relay_ai::http` sends requests on tokio with reqwest (rustls with the ring backend, the operating system's certificate store, proxies from the environment) and retries them with `retry`, the port of `retryProviderRequest`; `tests/http.rs` uses a local server, never a provider. `relay_ai::provider_request` builds each adapter's URL, headers and wire body and words its HTTP errors as its SDK does; the SDKs' telemetry headers (`x-stainless-*`, `x-goog-api-client`) describe the JavaScript runtime and are not sent. `relay_ai::stream` is each adapter's `stream()`: send, decode, and end with the error or abort event the TypeScript adapter emits; `tests/stream.rs` runs it against a local server. `relay_ai::oauth` refreshes each OAuth provider's token and derives its request auth through an `OAuthContext` (HTTP, clock, environment, waits), and `relay_ai::resolve` resolves a provider's auth as `resolveProviderAuth` does, refreshing an expiring token under the `auth.json` lock. `relay_ai::validation` validates tool arguments as `validateToolArguments` does: TypeBox's `Value.Convert` for built-in tools (TypeScript builds their schemas with TypeBox; plain JSON schemas such as MCP tools' skip it), Relay's coercion, then TypeBox 1.3's checks, keyword order, messages and 8-error limit; its format regexes are TypeBox's, and patterns run on `fancy-regex` with JavaScript's ASCII `\d` and `\w`. `crates/fixtures/scenarios/` holds what the TypeScript agent does in each scenario of `packages/coding-agent/test/parity/record.ts` (the messages the provider received, the session events and entries, with times, ids and paths replaced). `packages/ai/test/parity/write.ts` writes the adapter references: `anthropic/` (the bodies `anthropic-messages.ts` builds; `tests/anthropic.rs` must build them byte for byte), `anthropic-stream/` (scripted SSE responses and the events the adapter emits), `openai-responses/` (the bodies `openai-responses.ts` builds, also byte for byte), `openai-responses-stream/` (scripted streams parsed by the OpenAI SDK the adapter loads, `packages/ai/node_modules/openai`), `openai-completions/` (the bodies `openai-completions.ts` builds for each detected provider and thinking format, byte for byte), `openai-completions-stream/`, `google/` (the parameters `google-generative-ai.ts` builds, byte for byte, and the HTTP request the `@google/genai` SDK makes from them, captured with a stand-in `fetch`), `google-stream/` (scripted streams the SDK parses through that `fetch`), `simple/` (the requests each adapter's `streamSimple` builds, for `tests/simple.rs` to build from the same options), `auth/` (every branch of each provider's real `auth.apiKey.resolve` against a scripted environment: what it looked up and returned), `retry.json` (`retryProviderRequest` answering scripted failures with fixed timers, jitter and clock), `http/` (the request each adapter's SDK hands to `fetch`, and the message it reports for scripted HTTP errors), `stream-failures/` (each adapter's events when the request fails, is aborted before or during the body, or loses its connection), `oauth/` (each OAuth provider's refresh requests against scripted answers, the refreshed credential or error, and `toAuth`) and `json/` (the JSON repair and partial parsing helpers). `relay-ai` uses `serde_json` with `preserve_order` (JavaScript objects keep insertion order) and `float_roundtrip` (recorded numbers read back exactly). `packages/coding-agent/test/parity/config-value-record.ts` writes `config-values.json` (the agent's config value templates), and `validation-record.ts` writes `validation.json` (the built-in tools' and plain schemas' argument validation, each built-in case also on a plain copy of its schema). After changing agent or adapter behavior, run `npm run parity:record` and make the Rust tests pass; the `test/parity` tests fail while the files are behind the TypeScript code.
- `crates/relay-agent` ports the agent loop of `packages/agent` (`runAgentLoop`, `runAgentLoopContinue`). Tools (`AgentTool`), callbacks (`AgentHooks`) and the stream function (`StreamFn`) are traits that return boxed futures and streams. The loop awaits each event (`EventSink`), as the TypeScript loop awaits its listeners, and pulls each provider event from the stream function; the calls of a parallel batch run together with `join_all`. `packages/agent/test/parity/loop-record.ts` runs the TypeScript loop on scripted cases and writes `crates/fixtures/loop/`: the events, requests, hook calls, tool executions and returned messages. `tests/loop_parity.rs` replays each case with the same scripted tools, hooks and responses; `loop.test.ts` fails while the files are behind the TypeScript code. `ProviderStream` answers through the adapters with `relay_ai::simple::stream_simple`, the port of each adapter's `streamSimple`; the key comes from the request, since resolving it is the model runtime's job. `tests/provider.rs` replays the recorded adapter streams through the loop from a local server. `relay_agent::Agent` ports the `Agent` class: `agent-record.ts` drives the TypeScript agent through scripted steps, with tools and listeners that steer, queue, abort or prompt mid-run, and writes `crates/fixtures/agent/` (the events with the state at each, every operation's outcome, the requests and the state after each step); `tests/agent_parity.rs` replays them and `agent-class.test.ts` fails while they are behind. `relay_agent::harness::HarnessCore` installs the pillars of `crates/harness-core` on an `Agent` as `HarnessCore.install` does (wrapping its hooks, listening to its events, steering verification requests); `harness-record.ts` writes `crates/fixtures/harness/` from the TypeScript pillars on the agent-level scenarios of `harness.test.ts`, and `tests/harness_parity.rs` replays them. The slice signals, which need a workspace probe, are not ported yet.
- `crates/relay-tools` ports the built-in tools of `packages/coding-agent/src/core/tools`, whose outputs the model reads byte for byte: so far `read` (text files; images wait for an image codec), `ls`, `write`, `edit`, `grep` and `find` (ripgrep and fd from Relay's bin directory or the path, read through a thread so an abort or a full result stops them; the download of a missing tool is not ported yet), `bash` and `powershell` (the shell in its own session on Unix, killed with its descendants on abort or timeout, waited for until its pipes close or stay quiet 100 ms after it exits; the output accumulator decodes as a streaming `TextDecoder` and keeps all output in a temporary file once it is over a limit), with jsdiff's line diff and unified patch ported step by step (Myers with jsdiff's choices among equally short edits), the fuzzy match that keeps unchanged lines' bytes, a per-file mutation lock, and the truncation, path, MIME and JavaScript helpers they use (`localeCompare` order, `slice` indices, number formatting, Node's file error wording). `test/parity/tools-record.ts` writes `crates/fixtures/tools/` from the TypeScript tools on a fixture tree in a temporary directory, its path replaced by `<root>` so the files are the same on every platform; `tests/tools.rs` builds the same tree and replays them, and `tools.test.ts` fails while they are behind. `test/parity/shell-record.ts` adds `output.json` (the accumulator on chunked bytes) and `bash.json` (bash calls with their first and last updates; output file paths become `<output>` and strings over 2000 characters their length, hash and ends), which `tests/shell.rs` replays; the recorded commands must print the same on Git Bash and Linux.
- `relay_harness_core::json` writes tool effects, decisions, reports and constraints as the TypeScript harness does; `harness-wasm` and the Rust runtime share it, so a change there needs `npm run build:harness-wasm`.
- `crates/harness-core/tests/fixtures/classification.json` holds the TypeScript classification of every corpus command and edge case, and `pillars.json` the alignment decisions, text readings and completion reports. After changing a rule in `packages/agent/src/harness`, run `npm run harness:golden` and make the Rust tests pass; `golden.test.ts` fails while the files are behind the TypeScript code.

## Desktop App

- `packages/desktop` is a client of `relay --mode rpc`: the screen (`src/`, TypeScript without a framework or npm runtime dependencies) and the Tauri 2 shell (`src-tauri/`, crate `relay-desktop`). Keep agent logic in relay; a feature the screen needs and RPC lacks becomes an RPC command first.
- Set model, tool and session text with `textContent` only; `test/app.test.ts` fails when model text becomes markup. Keep the Tauri capability limited to the event listener and `rpc_send`.
- `relay-desktop` is not a default Cargo member: `cargo clippy -p relay-desktop` needs `packages/desktop/dist` (`npm run build` in the package) and, on Linux, the WebKitGTK packages `pr-ci.yml` installs. `npm test` in the package drives the built screen in the system Chrome with Playwright, and `test/bundle.test.ts` checks the installer configuration that the release's `desktop-installers` job builds from. Regenerate icons with `node packages/desktop/scripts/make-icons.mjs`.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/install-lock/` needs regen, run `node scripts/generate-coding-agent-install-lock.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `RELAY_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple relay sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contribution rules (issues first, quality bar). Pull requests go to `develop`; `main` only receives `develop` for a release.

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing relay Interactive Mode with tmux

For testing relay's interactive mode, load and follow [.relay/skills/interactive-testing.md](.relay/skills/interactive-testing.md).

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/eltonssouza/relay-harness/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/eltonssouza/relay-harness/pull/456) by [@username](https://github.com/username))`

## Releasing

For release preparation, publishing, verification, or recovery, load and follow [.relay/skills/release.md](.relay/skills/release.md).

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
