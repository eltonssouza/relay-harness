# Adaptive Execution with Laya

Relay normally runs every request on the model you selected. A typo fix then costs as much quota as a distributed-systems design. The `laya/auto` model instead picks the model, reasoning effort, role, skills, tools and validation for each request: the cheapest combination likely to succeed.

```
/model laya/auto
```

```
"Corrija o texto deste botão"        -> fast tier,   claude-haiku-4-5  • minimal
"Fix the race condition in workers"  -> strong tier, claude-opus-5-5   • high
"Fix the login token expiry"         -> strong tier (rule: authentication) • medium, review required
```

## How a request is routed

1. **Task intelligence (Laya).** [Laya](https://github.com/NandhaKishorM/laya) is a small local classifier, the fast "System 1". It answers 18 typed questions about the request in one call: task type, complexity, scope, risk, ambiguity, reasoning needed, recommended capability tier and effort, agent role, validation level, the tools needed, and whether the task is security-sensitive. Relay calls it through the same System One protocol it uses for TypeSafe classifiers. A request close to a task learned with `/laya learn` takes that task's answers instead ([memory](#teach-laya-from-your-sessions)).
2. **Policy engine.** Deterministic rules set floors Laya cannot lower. Production database migrations, authentication, security vulnerabilities and payment processing require at least the `strong` tier, an effort of at least `medium`, and review. High risk also requires `strong`. An answer whose confidence is below `laya.minConfidence` raises the tier by one.
3. **Model registry.** Tiers are abstract (`fast`, `balanced`, `strong`, `frontier`), so Laya never learns model names. The registry maps each tier to concrete models; only models whose provider has credentials are candidates.
4. **Selection.** Each candidate gets a utility from the cost profile: `quality × P(success) − cost × quota cost − latency × latency − risk × failure risk`. `P(success)` starts from a prior (0.90 when the model's tier is the required tier, +0.04 per tier above, −0.18 per tier below) and moves toward the observed success rate of that model on that task class. The best candidate whose success estimate reaches the profile minimum wins.
5. **Execution.** The routed model gets a short `[laya:plan]` message next to your request: the role to take, relevant skills, the tools expected, and how to validate. It is sent after your message, not in the system prompt, so the prompt cache stays valid.
6. **Escalation.** After `laya.escalateAfterFailures` failed tool calls (or harness verification requests) in a turn, the task moves to the next tier. A rate-limit or overload error moves it to an equivalent model of another provider.
7. **Telemetry.** Each request is recorded with its classification, selected model, outcome, tests and usage. The history feeds `P(success)` in later sessions.

Reasoning effort follows Laya's recommendation up to `xhigh`. Routing never uses `max`. `laya/auto` has no thinking level of its own: a selected level would cap Laya's choice without you noticing. The footer shows the routed model and effort next to the selection, and the status line shows the task type and tier.

When the Laya server is not running, keyword rules in English and Portuguese answer instead, and the status line shows `(rules)`. Laya is retried a minute later.

## Cost profiles

| Profile | Weights | Minimum success estimate |
|---|---|---|
| `economy` | cost 50%, quality 30%, latency 20% | 0.75 |
| `balanced` (default) | quality 45%, cost 30%, latency 15%, risk 10% | 0.85 |
| `quality` | quality 70%, risk 20%, cost 10% | 0.90 |
| `critical` | quality 70%, risk 30% | 0.95 |

Select one with `laya.policy`, `relay --laya-policy economy`, or `/laya policy quality` for the session.

## Model registry

| Tier | Default models, in preference order |
|---|---|
| `fast` | `anthropic/claude-haiku-4-5`, `openai-codex/gpt-6-luna`, `google/gemini-3.5-flash` |
| `balanced` | `anthropic/claude-sonnet-5-5`, `openai-codex/gpt-5.6-terra`, `google/gemini-3.8-flash` |
| `strong` | `anthropic/claude-opus-5-5`, `openai-codex/gpt-6-sol`, `google/gemini-3.1-pro-preview` |
| `frontier` | `anthropic/claude-fable-5-1`, `openai-codex/gpt-6.1-sol` |

Replace a tier with `laya.models`:

```json
{
  "laya": {
    "models": { "fast": ["openai-codex/gpt-6-luna"] },
    "quota": { "anthropic": 0.8, "openai-codex": 0.25 }
  }
}
```

`laya.quota` states how much of each subscription is left. Scarce quota makes a provider's models more expensive in the utility, so an equivalent model of another provider wins.

## Install the trained Laya

The npm package does not contain the trained model (650 MB) or the Python environment it runs in (a few GB with torch). Relay fetches both once, into `~/.relay/agent/laya`:

| Piece | Where it comes from | Size |
|---|---|---|
| Trained model | The public Hugging Face repository [eltonssouza/relay-laya](https://huggingface.co/eltonssouza/relay-laya), pinned to one commit, every file checked against the sha256 in the package | about 680 MB |
| Python environment | A venv created from Python 3.10 to 3.13, with `torch` (a CUDA build only when `nvidia-smi` finds a GPU, the CPU build otherwise), `laya[serve]`, `fastapi` and `uvicorn` | a few GB |

The first time you send a request with `laya/auto` selected, Relay asks whether to install them. You can also run `/laya setup` at any time. After that, `laya/auto` starts the server on `127.0.0.1:8000` by itself when a request needs it and stops it when the session ends. A server that already answers on that port is used as is, so you can run your own. Until the install finishes, or when it is declined, keyword rules route requests.

Relay only starts a server for a local `laya.baseUrl`. Set `"laya": { "autostart": false }` to never start or offer one.

Requirements: Python 3.10 to 3.13 (set `laya.python` if it is not on the PATH under `python3`, `python` or `py`), and on Windows a home directory path short enough for torch's DLLs (the default is).

## Teach Laya from your sessions

The shipped model learned from synthetic requests, so it routes your kind of work by rules of thumb. Teach it the tasks you actually do:

```
/laya learn
```

1. **Collect.** Relay lists every request of the current session with the evidence of how it went: the model and effort that ran it, the tools called, the files changed, the commands, the errors of failed tool calls, whether tests and builds passed, what laya/auto planned, and your next message (a correction there means the task was not done right). `/laya learn <session file>` reads another session instead.
2. **Label.** The agent answers Laya's 18 questions for each task from that evidence, for example "this fix needed the `balanced` tier, not `fast`: it took two failed edits and a correction". When the task taught something, it also writes a lesson: "The label comes from `locales/pt-BR/orders.json`, not the component; run `npm run i18n:check`." It saves them with the `laya_learn` tool and replies with a table of what it labeled. The labels are exercises in `~/.relay/agent/laya/training/data/dataset.jsonl`; a request learned again replaces its old labels.
3. **Remember.** From the next request on, without waiting for training and without the Laya environment:
   - A request close to a learned task is routed with that task's labels instead of Laya's or the keyword rules' answers. The status line shows `(memory)`. "Corrija o texto do botão Salvar na tela de pedidos, está cortado" goes to the tier and effort the learned "Corrija o texto do botão Salvar na tela de pedidos" needed, not to the cheapest tier the words "corrija o texto" suggest.
   - The model that runs a request gets the lessons of similar learned tasks: in the laya/auto plan, or in a hidden `[laya:lessons]` message when you selected a model yourself.

   Closeness is the cosine of the requests' word vectors, with words common to every coding request weighted down: routing needs 0.6, a lesson 0.45. Requests in another language than the learned one rarely match; training covers those. Turn the memory off with `"laya": { "memory": false }`.
4. **Train.** Training starts in the background, from the model that routes today. It mixes the session tasks with a replay sample of the earlier exercises, so Laya learns the new tasks without forgetting the rest. With an 8 GB GPU it takes about 7 minutes; without a GPU Relay asks first, because it can take an hour or more. The memory and keyword rules route requests while it runs, and the status line shows its progress.
5. **Test and activate.** The new model and the current one answer the same held-out test, exercises neither was trained on. The new model routes requests from then on unless it answers more than 1% fewer test questions; Relay then reports how many answers on the session tasks it now gets right, before and after.

You can also ask in your own words ("learn from this conversation"): with [`tool_search`](cli.md#tools) active, the agent finds `laya_learn` itself.

| Command | Effect |
|---|---|
| `/laya learn [session file]` | Label the tasks of this session (or of a session file) and train on them |
| `/laya train` | Train again on every session task collected so far |
| `/laya models` | The shipped and trained models, their test scores, the exercises, and training progress |
| `/laya use <model>` | Route with another model, for example `/laya use v1` to go back to the shipped one |

Trained models live in `~/.relay/agent/laya/training/models` (about 680 MB each). Relay keeps the active one and the two newest others, and deletes older ones. Training needs the Laya environment (`/laya setup`), and stops when Relay quits; it continues across `/new` and `/resume`.

## Retrain from scratch

To change the questions or rebuild the model, train with the `laya-trainer` Claude Code plugin. The questions Relay sends are the contract with the trained checkpoint, so train with Relay's own definitions:

1. `/laya-init` prepares the training tools.
2. `/laya decisions` (in Relay) writes the questions to `.laya/decisions.json`.
3. `/laya seed 1100` writes synthetic bootstrap exercises to `.laya/data/relay-seed.jsonl`; add them with `/laya-data`. Their labels follow one rule from the task profile, so they teach Laya the policy, not evidence. The session tasks in `~/.relay/agent/laya/training/data/dataset.jsonl` (source `session`) can be added the same way.
4. `/laya-train`, then `/laya-eval`.

`/laya export` writes one exercise per successful routed request, labeled only with the tier that finished it, to `.laya/data/relay-telemetry.jsonl`. Telemetry stays local and contains your requests; turn it off with `"laya": { "telemetry": false }`.

### Ship a new model

A retrained model reaches users through a new revision of the Hugging Face repository and a new manifest in the package:

```bash
hf upload eltonssouza/relay-laya .laya/models/v2 . --commit-message "Laya model v2"
node scripts/package-laya-model.mjs --model .laya/models/v2 --version v2 --out /tmp/laya-v2 --revision <commit from the upload>
cp /tmp/laya-v2/model-manifest.ts packages/coding-agent/src/extensions/laya/model-manifest.ts
```

`hf upload` needs `hf auth login` with a token that can write to the repository. Upload before the npm release that embeds the new manifest. The manifest pins the commit, file sizes and hashes, so a missing or altered file makes the install fail instead of running an unknown model. Installed users get the new version in a new directory on their next `/laya setup`.

## Commands

| Command | Effect |
|---|---|
| `/laya` | Profile, runtime and server status, the routing model and training progress, models with credentials, quota, and the last plan with its alternatives and escalations |
| `/laya setup` | Install the Python environment and download the trained model |
| `/laya start`, `/laya stop` | Start the local server, or stop the one this session started |
| `/laya learn [session file]` | Teach Laya the tasks of this session ([details](#teach-laya-from-your-sessions)) |
| `/laya train` | Train again on the session tasks collected so far |
| `/laya models`, `/laya use <model>` | List the shipped and trained models, or route with another one |
| `/laya policy <profile>` | Cost profile for this session |
| `/laya decisions [path]` | Write the questions in laya-trainer format |
| `/laya seed [count] [path]` | Write synthetic training exercises |
| `/laya export [path]` | Write evidence-labeled exercises from telemetry |

Set `"laya": { "toolRouting": "enforce" }` to also deactivate the tools a request does not need, for example `edit` and `write` for a question. The tool set is restored before the next request is planned. Tools the router does not recognize stay active.
