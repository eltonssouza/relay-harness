# Harness Core

The harness core is four rules that apply to every model Pi runs: Claude, GPT, Gemini, Grok, or a local model. They act on the agent loop's hooks and events, not on a provider API, and need no extra model call. Each one addresses a measured failure of coding agents.

| Pillar | Failure it addresses | What the harness does |
|---|---|---|
| Alignment | Agents violate explicit developer constraints (38% of misalignment), treat questions as permission to edit, and run destructive commands. | Keeps constraints as state and restates them on every request. Asks before destructive or external commands. Stops the first edit in a turn where you only asked a question. Works as a pair: records your corrections and offers constraints and corrections as candidates for AGENTS.md. |
| Evidence | Agents report "done" when the work failed. LLM judges miss most of these cases. | Records what tool calls actually changed and checked. A completion claim without a passing check after the last change gets one verification request. Counts only checks whose exit code is not masked, optionally only the project's declared commands, and flags oversized changes and files. |
| Context | Old tool results describe states that no longer exist and grow the context. | Sends recent tool results verbatim, replaces old large ones with one-line stubs, and restates a compact progress digest. |
| Skills | A skill's organization changes how the agent uses it, and nobody measures it. | Tells the model to treat `SKILL.md` as a router, measures which skill resources lead to actions, and audits skill structure. |

All four are enabled by default. Inspect them with `/harness`; configure them with [`harnessCore` settings](settings.md#harness-core).

## Alignment

**Constraints.** Sentences in your messages that state a standing rule ("Never use `any`", "Não altere os testes", "Use pnpm instead of npm") are recorded as constraints. Each request restates them next to your latest message, where the model weighs them most. Constraints are saved in the session file, so they survive compaction and resume. Code blocks and expanded skills or files are ignored.

**Authorization.** Commands that are hard to reverse or that change state outside the workspace need your approval:

- destructive: `git reset --hard`, `git push --force`, `git clean -f`, `git checkout .`, `git rebase`, `git branch -D`, `rm -r`, `Remove-Item -Recurse`, `DROP TABLE`, `DELETE` without `WHERE`
- external: `git push`, `npm publish`, `gh pr create|merge`, `kubectl apply`, `terraform apply`, `docker push`, deploy commands, `curl -X POST|PUT|PATCH|DELETE`

A command runs without asking when your latest message names the operation in an affirmative clause: "push the branch" allows `git push`, "apague o diretório dist" allows `rm -r dist`. A deletion also needs its target named, so "remove the unused import" allows no `rm`. "Push it, but not with force" does not allow `git push --force`. Otherwise, in the interactive TUI and RPC modes, Pi asks with a confirmation dialog. In print and JSON modes the call is blocked, the agent asks you in chat, and a "yes" (or "sim", "ok", "go ahead") as your next message allows that exact command once.

**Pair programming.** The agent works as a pair, not a code generator: you bring the what and the why, the agent brings the how. The system prompt carries three rules: ask when the goal or its reason is unclear; propose the simplest design that meets the stated requirements, and a more complex one only by naming the requirement that needs it; treat your context about the environment, services, or domain as authoritative over the model's assumptions. Interrupt a run to redirect it ([Change direction](usage.md#change-direction)).

**Corrections.** A message that pushes back on the agent's approach after it has worked ("Não, simplifica…", "Para, isso tá complicado demais", "That's too complex", "Actually, use…") is recorded as a correction. The next request reminds the model to adopt it, prefer the simplest design that satisfies it, and not reintroduce what you rejected. Ordinary openings such as "Para o módulo X…" or "Não sei por que…" are not corrections.

**Learnings and the living AGENTS.md.** Constraints and corrections are kept in the session file, so they survive compaction and resume, but a new session starts without them. `/harness` lists them under "Learnings (candidates for AGENTS.md)". Recording the lasting ones in AGENTS.md, as a "Common hurdles" entry with the symptom, cause, solution, and how to verify it, means the next session, with any model, starts with them. Pi never edits AGENTS.md on its own; ask the agent to record the entry, or use a prompt template such as this repository's [`.pi/prompts/hurdle.md`](../../../.pi/prompts/hurdle.md).

**Question turns.** When your message only asks a question ("Why does the build fail on Windows?"), the first file edit in that turn is blocked with a request to answer first and propose the change. "Why does it fail? Please fix it." is a request, not a question.

## Evidence

During each request Pi records which files changed and which checks ran (tests, type checks, builds, linters) and whether they passed. A failing exit code is a failed check. When the agent's final message claims completion, Pi compares the claim with that record:

| Status | Meaning |
|---|---|
| `verified` | Changes were made and a check passed after the last change, or only documentation changed. |
| `unverified` | The message claims completion, but no check passed after the last change. |
| `contradicted` | The message says checks pass, but the last check failed or none ran; or it says all tests pass, but the last check selected tests by name (`-t`, `--grep`, `-k`). |
| `no-effect` | You requested a change and the message reports it done, but the tool calls only read state. |
| `acknowledged` | The message states what was not verified or what failed. |

For `unverified`, `contradicted`, and `no-effect`, Pi sends the agent one `[harness:evidence]` verification request instead of ending the run. That message appears in the transcript. If the next answer is still flagged, the run ends and Pi shows a warning.

**Declared verification commands.** By default, common test, type-check, build, and lint commands count as checks. A project can declare its own with `harnessCore.verifyCommands`, for example `["npm run check", "./test.sh"]`. Then only commands that run one of them count, so `npx tsc` on one package does not stand in for the project's full check, and the verification request names the declared commands.

**Masked exit codes.** A check counts only if its exit code reaches the tool. What follows the check can replace it: a pipe (`npm run check | tail`, unless `pipefail` is set), `||` (`npm test || true`), or a later command (`npm test; echo done`). Each of these exits 0 when the check fails, so such a run is not evidence. `&&` keeps the failure: `npm test && echo ok` counts.

**Small slices.** Two signals, shown next to your latest message when they fire:

- **Change size**: lines changed in the git working tree since your request began, against the last commit (added plus deleted lines; all lines of new untracked files). Above `harnessCore.maxChangedLines` (default 500), the agent is asked to verify and report this slice before starting more, and to propose how to split the rest.
- **File growth**: when an edit takes a file past `harnessCore.maxFileLines` (default 1000), or grows a file already past it by 200 lines or more, the agent is asked to extract a cohesive part before adding more. A small edit to an already large file is not flagged.

Outside a git repository the change-size signal is off; file growth still works. `/harness` shows the current numbers.

## Context

At each request, before the provider call:

- The newest `harnessCore.contextKeepRecent` tool results (default 6) are sent verbatim.
- Older results of at least 1,500 characters are replaced by a stub that names the call, its size and outcome, and whether the file changed later.
- A digest of the replaced calls is restated next to your latest message, so the agent keeps track of progress.

The session file is never changed; only the request is. Replacing an old message invalidates the provider's prompt cache after it, so replacement happens in batches of `harnessCore.contextBatchSize` results (default 6). Between batches the request prefix stays identical and the cache keeps hitting. Compaction still applies when the context approaches the model's limit; the context pillar makes that happen later.

## Skills

The skills section of the system prompt tells the model to treat a skill file as a router and to load the references and scripts it points to when a step needs them. During each run Pi records, per skill, how many resources were loaded (fanout), whether each load was followed by an action within three tool calls (effective uptake), when in the run loads happened, and revisits. `/harness` shows the last run's numbers and audits each `SKILL.md` skill for:

- an entry file over 300 lines with no resources (consider splitting into references; keep strict formats and numeric contracts in the entry), or over 300 lines although it has resources
- a `description` over 300 characters (it is all the model reads before deciding to load the skill, and it is paid for in every request)
- references to files that do not exist
- references without a reason or condition to load them
- files in the skill directory that the entry never references

## For SDK and extension authors

The pillars live in `@earendil-works/pi-agent-core` as `HarnessCore` and can be installed on any `Agent`:

```typescript
import { Agent, HarnessCore } from "@earendil-works/pi-agent-core";

const agent = new Agent({ streamFn });
const uninstall = new HarnessCore({
	alignment: { authorize: async (request) => confirm(request.effect.command) },
	onEvent: (event) => console.log(event),
}).install(agent);
```

In Pi, `session.harnessCore.core` exposes the constraint ledger, evidence ledger, context policy, and skill tracker.

## Sources

- Tang et al., *How Coding Agents Fail Their Users*, arXiv:2605.29442, 2026.
- Advani, *From Confident Closing to Silent Failure: Characterizing False Success in LLM Agents*, arXiv:2606.09863, 2026.
- Lodha et al., *Less Context, Better Agents*, arXiv:2606.10209, 2026.
- *SkillJuror: Measuring How Agent Skill Organization Changes Runtime Behavior*, arXiv:2606.11543, 2026.
