# Harness Core

The harness core is three rules that apply to every model Relay runs: Claude, GPT, Gemini, Grok, or a local model. They act on the agent loop's hooks and events, not on a provider API, and need no extra model call. Each one addresses a measured failure of coding agents.

| Pillar | Failure it addresses | What the harness does |
|---|---|---|
| Alignment | Agents violate explicit developer constraints (38% of misalignment), treat questions as permission to edit, and run destructive commands. | Keeps constraints as state and restates them on every request. Asks before destructive or external commands. Stops the first edit in a turn where you only asked a question. Works as a pair: records your corrections and offers constraints and corrections as candidates for AGENTS.md. |
| Evidence | Agents report "done" when the work failed. LLM judges miss most of these cases. | Records what tool calls actually changed and checked. A completion claim without a passing check after the last change gets one verification request. Counts only checks whose exit code is not masked, optionally only the project's declared commands, and flags oversized changes and files. |
| Context | Old tool results describe states that no longer exist and grow the context. | Sends recent tool results verbatim, replaces old large ones with one-line stubs, and restates a compact progress digest. |

All three are enabled by default. Inspect them with `/harness`; configure them with [`harnessCore` settings](settings.md#harness-core).

## Alignment

**Constraints.** Sentences in your messages that state a standing rule ("Never use `any`", "Não altere os testes", "Use pnpm instead of npm") are recorded as constraints. "Always" and "only" ("sempre", "apenas") state a rule only before an action verb ("Always run the tests", not "Always seems to break"), and "Keep going" or "Não consegui rodar os testes" state none. Each request restates them next to your latest message, where the model weighs them most. Constraints are saved in the session file, so they survive compaction and resume. Code blocks and expanded skills or files are ignored. Only your own messages count: a prompt an extension sends for you (`/init`, `/goal`, `/agent`) and the harness's own requests carry an origin and state no constraints, grant no approvals and correct nothing.

**Authorization.** Commands that are hard to reverse or that change state outside the workspace need your approval:

- destructive: `git reset --hard`, `git push --force`, `git clean -f`, `git checkout` of paths or with `--force` (`git checkout -- src`, `git checkout HEAD -- .`, `git checkout -f main`; a plain branch switch does not ask), `git restore` unless it only unstages (`--staged`), `git rebase`, `git branch -D`, `rm -r`, `rm -f`, `rm`, `del` or `Remove-Item` with a wildcard, `mv` of workspace files out of the workspace, `find -delete` or `-exec rm`, `xargs rm`, `chmod -R`, `Remove-Item -Recurse`, `docker system|volume|image prune`, `docker volume rm`, `docker compose down -v`, `rsync --delete`, `DROP TABLE`, `DELETE` without `WHERE`, `eval` of a command built at runtime, and inline code (`python -c`, `node -e`, `perl -e`) that deletes files
- external: `git push` (also `git -C dir push`), `npm publish`, `gh pr create|merge`, `kubectl apply`, `terraform apply`, `docker push`, `scp` and `rsync` that send files to another host, deploy commands and scripts named like a deployment, `curl` or `wget` that sends data (`-d`, `-F`, `-T`, `--request POST|PUT|PATCH|DELETE`), downloaded code piped to a shell, redirects into `~/.ssh`, shell profiles or `/etc`
- file writes by the `write` and `edit` tools outside the workspace (the system temp directory is allowed), or to files that run code or hold credentials: `.git/hooks`, `.husky`, `.relay/settings.json`, `.relay/mcp.json`, `.relay/extensions`, `.ssh`, shell profiles
- tools that declare themselves destructive (MCP `destructiveHint`) or as changing an external system (`readOnlyHint: false` with `openWorldHint`). A tool that declares `readOnlyHint` is a read.

Commands are matched as text, so a command that only mentions an operation (`echo "git push"`) also asks: that costs one prompt, while a miss could cost unrecoverable work. The harness is a safeguard against mistakes, not a sandbox. Variable indirection, aliases and scripts it cannot read still get through; run Relay in an isolated environment when that matters ([Run Relay safely](security.md)).

A command runs without asking when your latest message names, in an affirmative clause, every risky operation the command performs: "push the branch" allows `git push`, but not `git push && git reset --hard`, and "Push it, but not with force" does not allow `git push --force`. A deletion also needs each target named as the command writes it: "apague o diretório dist" allows `rm -r dist`, while "remove the unused import in src/index.ts" does not allow `rm -rf src`. A target that is a glob, `~`, `..` or a variable, and a deletion through `find` or `xargs`, always ask. Some operations need a specific phrase: `git reset --hard` needs "git reset", "hard reset" or "reset the branch" (not "reset the counter"), `gh pr merge` needs "merge the PR", an infrastructure command needs its tool and subcommand ("terraform apply"), and `docker push` needs "docker push" or "push the image". Others always ask, whatever the message says: discarding uncommitted work, deleting a branch, rewriting history, recursive permission changes, low-level disk writes, destructive SQL, commands built at run time, downloaded code piped to a shell, docker deletions, `curl` or `wget` that send data, remote copies, writes to shell or credential files, and inline interpreter code. A file write is allowed when your message names the file: "edit .relay/settings.json" or "edit settings.json", not "edit src/settings.json".

Otherwise, in the interactive TUI and RPC modes, Relay asks with a confirmation dialog. In print and JSON modes the call is blocked, the agent asks you in chat, and a short "yes" (or "sim", "ok", "go ahead", "pode rodar") as your next message allows that exact command once. A reply that asks something ("Isso vai apagar o quê?"), states a reservation ("sim, mas antes..."), or runs past a few words approves nothing.

**Pair programming.** The agent works as a pair, not a code generator: you bring the what and the why, the agent brings the how. The system prompt carries three rules: ask when the goal or its reason is unclear; propose the simplest design that meets the stated requirements, and a more complex one only by naming the requirement that needs it; treat your context about the environment, services, or domain as authoritative over the model's assumptions. Interrupt a run to redirect it ([Change direction](usage.md#change-direction)).

**Corrections.** A message that pushes back on the agent's approach after it has worked ("Não, simplifica…", "Para, isso tá complicado demais", "That's too complex", "Actually, use…") is recorded as a correction. The next request reminds the model to adopt it, prefer the simplest design that satisfies it, and not reintroduce what you rejected. Ordinary openings such as "Para o módulo X…" or "Não sei por que…" are not corrections.

**Learnings and the living AGENTS.md.** Constraints and corrections are kept in the session file, so they survive compaction and resume, but a new session starts without them. `/harness` lists them under "Learnings (candidates for AGENTS.md)". `/harness forget <id>` removes one constraint by the id `/harness` shows (`c3`), and `/harness clear` removes every recorded constraint and correction of the current branch. Recording the lasting ones in AGENTS.md, as a "Common hurdles" entry with the symptom, cause, solution, and how to verify it, means the next session, with any model, starts with them. Relay never edits AGENTS.md on its own; ask the agent to record the entry, or use a prompt template such as this repository's [`.relay/prompts/hurdle.md`](../../../.relay/prompts/hurdle.md).

**Question turns.** When your message only asks a question ("Why does the build fail on Windows?"), the first file edit in that turn is blocked with a request to answer first and propose the change. An edit made through the shell (`sed -i`, `>`, `git apply`) counts like one made with the `edit` and `write` tools. "Why does it fail? Please fix it." and "Why is this slow? Make it faster." are requests: a later sentence that starts with an action verb makes the message one. Relay judges intent in English and Portuguese only; a message in any other language is never treated as a question, so it is never blocked.

**Branches.** After `/tree` moves to another branch, constraints and corrections follow that branch, and the context digest and any pending approvals of the branch you left are dropped.

## Evidence

During each request Relay records which files changed and which checks ran (tests, type checks, builds, linters) and whether they passed. A failing exit code is a failed check. When the agent's final message claims completion, Relay compares the claim with that record:

| Status | Meaning |
|---|---|
| `verified` | Changes were made and a check that covers them passed after them, or only documentation changed. |
| `unverified` | The turn ends with changes no passing check covers. An explicit claim is not needed: "I updated the function" ends the turn the same way. |
| `question` | The message asks you something while changes no passing check covers are pending ("I updated it. Want me to run the tests?"). It is not a completion report, so Relay does not ask the agent to verify, but it shows a warning so you know before you answer. |
| `contradicted` | The message says checks pass, but the last check failed or none ran; or it says all tests pass, but the last check selected tests by name (`-t`, `--grep`, `-k`). |
| `no-effect` | You requested a change and the message reports it done, but the tool calls only read state. |
| `acknowledged` | The message states what was not verified or that tests still fail. A failure in the past tense ("the tests failed") counts only when the last check of the request did fail, so "the tests failed before, now it is fixed" with no check run is a claim. |

For `unverified`, `contradicted`, and `no-effect`, Relay sends the agent one `[harness:evidence]` verification request instead of ending the run. That message appears in the transcript. If the next answer is still flagged, the run ends and Relay shows a warning.

**What counts as a check.** The program a command runs decides, not the words in it: `npm run check`, `vitest`, `pytest`, `cargo test`, `go test`, `mvn test`, `ng test`, `make test`, `./test.sh`, `tsc`, `eslint`, `biome check` count; `ls build`, `echo test`, `cat tests/a.test.ts`, `mkdir build` and `npm run test:watch` do not. A run that exits 0 but whose output says no test ran ("No test files found", "collected 0 items") is not evidence either.

**Edits made through the shell.** The `edit` and `write` tools are not the only way to change a file, and models often use `sed -i`. Relay also counts as changes the files a shell command edits in place (`sed -i`, `perl -i`), writes (`>`, `>>`, `tee`, `cat > file <<EOF`), moves or copies (`mv`, `cp`), or patches (`patch`, `git apply`, which name no file). Writes to `/dev`, the system temp directory and files outside the workspace do not count, nor does a check's own log (`npm test > out.log`, `npm test | tee out.log`). When one command line edits a file and then runs a check, the check can cover the edit; an edit after the check is not covered by it.

**Coverage.** A check covers the files it ran on. `cd packages/b && npm test` after an edit in `packages/a` leaves that edit unverified, and `cd src && npm test` covers the workspace's own `src`, not `packages/a/src`. Each change needs a passing check after it, not only the last change, and a check that started before an edit finished (tools run in parallel) does not cover it. A check that names source or test files (`vitest run test/a.test.ts`, `eslint src/a.ts`) covers only changes to files of the same name, so `a.ts` is covered by `a.test.ts` but not by `other.test.ts`. A check that names no file, or only a directory (`pytest tests/`), covers its whole scope, and one with no directory in its command covers the whole workspace.

**Declared verification commands.** By default, common test, type-check, build, and lint commands count as checks. A project can declare its own with `harnessCore.verifyCommands`, for example `["npm run check", "./test.sh"]`. Then only commands that begin with the declared words count, past wrappers such as `env` and `npx`: `npm run check -- --max-warnings 0` counts, while `npm run check:browser-smoke`, `echo npm run check` and `grep "npm run check" AGENTS.md` do not, `npx tsc` on one package does not stand in for the project's full check, and the verification request names the declared commands.

**Masked exit codes.** A check counts only if its exit code reaches the tool. What follows the check can replace it: a pipe (`npm run check | tail`, unless `pipefail` is set), `||` (`npm test || true`), a later command (`npm test; echo done`), or `&`, which sends the check to the background so the command exits before it finishes (`npm test &`). Each of these exits 0 when the check fails, so such a run is not evidence. `&&` keeps the failure: `npm test && echo ok` counts.

**Small slices.** Two signals, shown next to your latest message when they fire:

- **Change size**: lines changed in the git working tree since your request began, against the last commit (added plus deleted lines; all lines of new untracked files). Above `harnessCore.maxChangedLines` (default 500), the agent is asked to verify and report this slice before starting more, and to propose how to split the rest.
- **File growth**: when an edit takes a file past `harnessCore.maxFileLines` (default 1000), or grows a file already past it by 200 lines or more, the agent is asked to extract a cohesive part before adding more. A small edit to an already large file is not flagged.

Relay measures after edits, shell commands that write files, checks and risky operations; a plain command such as `ls` or `git status` costs no measurement. A failed measurement is retried in the next request; after three requests in a row fail (outside a git repository), the change-size signal is off. File growth still works. `/harness` shows the current numbers.

## Context

At each request, before the provider call:

- The newest `harnessCore.contextKeepRecent` tool results (default 6) are sent verbatim.
- Older results of at least 1,500 characters are replaced by a stub that names the call, its size and outcome, and whether the file changed later.
- A digest of the replaced calls is restated next to your latest message, so the agent keeps track of progress.

The session file is never changed; only the request is. Replacing an old message invalidates the provider's prompt cache after it, so replacement happens in batches of `harnessCore.contextBatchSize` results (default 6). Between batches the request prefix stays identical and the cache keeps hitting. Compaction still applies when the context approaches the model's limit; the context pillar makes that happen later.

The harness state (constraints, a correction, pending changes, the digest) is restated on the newest message of each request and is gone from the next one. Relay marks it as volatile, and providers with explicit cache breakpoints (the Anthropic API) place the breakpoint before it and send it after the tool results, so restating it rewrites nothing the provider cached. On a recorded session with one constraint recorded, `npm run bench:harness` counts 6 requests that rewrote cached messages, all from elision batches; with the state inside the cached prefix it would be 460 of 461.

## Skill audit

Skills are not a pillar: the harness does not change what the agent does with them. The skills section of the system prompt tells the model to treat a skill file as a router and to load the references and scripts it points to when a step needs them. `/skills-audit` checks each `SKILL.md` skill against that structure and lists:

- an entry file over 300 lines with no resources (consider splitting into references; keep strict formats and numeric contracts in the entry), or over 300 lines although it has resources
- a `description` over 300 characters (it is all the model reads before deciding to load the skill, and it is paid for in every request)
- references to files that do not exist
- references without a reason or condition to load them
- files in the skill directory that the entry never references

## For SDK and extension authors

The pillars live in `@relay-harness/agent-core` as `HarnessCore` and can be installed on any `Agent`:

```typescript
import { Agent, HarnessCore } from "@relay-harness/agent-core";

const agent = new Agent({ streamFn });
const uninstall = new HarnessCore({
	alignment: { authorize: async (request) => confirm(request.effect.command) },
	onEvent: (event) => console.log(event),
}).install(agent);
```

In Relay, `session.harnessCore.core` exposes the constraint ledger, evidence ledger, and context policy.

## Sources

- Tang et al., *How Coding Agents Fail Their Users*, arXiv:2605.29442, 2026.
- Advani, *From Confident Closing to Silent Failure: Characterizing False Success in LLM Agents*, arXiv:2606.09863, 2026.
- Lodha et al., *Less Context, Better Agents*, arXiv:2606.10209, 2026.

## Measuring the rules

`npm run bench:harness` replays labelled cases and one recorded session offline, with no model: risky and safe commands, developer requests and answers that should or should not authorize a call, checks and look-alikes (also with declared verification commands), completion scenarios, question turns, recorded constraints, and the context pillar on a real transcript. It reports how often the harness stops fine work, how often it lets unverified work through, how much context it saves and how often it rewrites cached messages. The same cases run as tests with floors, so a rule change that trades one error for another fails. The cases live in `packages/coding-agent/test/harness-bench/corpus.json`, so any implementation of the harness can be measured against them. `crates/harness-core` is a Rust port of the classification (the shell lexer, risky operations, deletion targets and check detection); `crates/harness-core/tests/fixtures/classification.json` holds the TypeScript result for every corpus command and edge case, and the Rust tests must match it (`npm run harness:golden` regenerates the file after a rule change). Known gaps are listed in the report instead of hidden. A case marked `open` reproduces a known defect: it stays out of the floors, a test checks that it still reproduces, and the fix removes the marker. Formatters that rewrite files (`prettier --write`, `eslint --fix`), build tools that generate sources, and edits made by a script the harness cannot read are not counted as changes. Task pass rate with a model in the loop is not measured there; that needs real runs.
