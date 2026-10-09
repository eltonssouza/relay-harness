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

When the Laya server is not running (Docker is missing or stopped, or the image is still downloading), keyword rules in English and Portuguese answer instead, and the status line shows `(rules)`. Laya is retried a minute later.

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

### Follow the selected provider

Set `laya.followProvider` to `true` to route the physical model you select through Laya. Selecting a Claude model restricts subsequent choices to its provider; selecting Codex, a local endpoint, GLM, Kimi or Qwen changes that boundary. Laya still classifies task capability independently of the provider. Direct calls, retries and tool-failure escalations keep the boundary; rate limits do not authorize a switch to another provider.

```json
{
  "laya": {
    "followProvider": true,
    "modelGroups": {
      "local-qwen": {
        "fast": ["lmstudio/qwen2.5-coder-7b-instruct"],
        "balanced": ["lmstudio/qwen2.5-coder-7b-instruct"],
        "strong": ["lmstudio/qwen3-coder-30b-a3b-instruct"]
      }
    }
  }
}
```

The latest explicit physical model selection on the session branch identifies the provider, including after resume. Default tier maps remain available for their providers alongside `laya.models`. Add a `modelGroups` entry to map the actual model IDs and capabilities of a provider or family. A group is selected by membership of the model you selected; its candidates must also use that model's provider. This keeps Qwen and Kimi separate when both are served by the same gateway. A model must belong to at most one group.

A provider need not offer four distinct models. Missing tiers stay missing: a `frontier` request does not make a smaller local model frontier-capable. If no mapped models are available, Relay keeps the selected model and reports its capability as unclassified. If only a weaker mapped model is available, Relay reports the limitation. Declare capabilities explicitly instead of inferring quality from a model name or price. Set `followProvider` to `false` for fixed physical selections and the normal cross-provider `laya/auto` registry.

## Laya runs in Docker

Relay itself runs on your machine; Laya and its Python run only in Docker. The npm package contains neither the trained model (650 MB) nor Python with torch. Both come in a Docker image, `ghcr.io/eltonssouza/relay-laya`, built by Relay's release from the same sources as the package:

| Image | Used when | Size |
|---|---|---|
| `v3-cpu-<hash>` | No NVIDIA GPU | about 2 GB |
| `v3-cuda-<hash>` | `nvidia-smi` finds an NVIDIA GPU; training uses it | about 6 GB |

The image holds Python 3.11, `torch`, `laya[serve]`, the shipped model from the Hugging Face repository [eltonssouza/relay-laya](https://huggingface.co/eltonssouza/relay-laya) (pinned to one commit, every file checked against the sha256 in the package), and the scripts that serve and train it. The tag ends in a hash of all of that, so each Relay version runs the image built from its own sources.

Install is automatic. Every time Relay starts in interactive mode it makes sure, in the background, that:

1. the image is present, pulling it the first time (the status line shows the layers);
2. a container named `relay-laya` runs it with the active model, published on `127.0.0.1:8737` only (the port of `laya.baseUrl`), with `--restart unless-stopped`;
3. the server answers.

The container then keeps running between sessions and comes back with Docker, so requests do not wait for the model to load. It serves on the CPU, which keeps the GPU free for training. Models trained from your sessions live in the Docker volume `relay-laya-models`. On the host, `~/.relay/agent/laya` only holds Relay's own data: the training exercises, the list of trained models, and telemetry. A Python environment or model left there by Relay 1.0.2 is deleted.

Until the server answers, and whenever Docker is missing or stopped, keyword rules route requests; Relay says once why Laya is not running. Install [Docker Desktop](https://docs.docker.com/get-started/get-docker/) (Windows, macOS) or Docker Engine (Linux) and start it; the next Relay start installs Laya. `/laya setup` does it right away.

A server that already answers on the port when there is no `relay-laya` container is used as is, so you can run your own; one that announces other questions than Relay's, such as a laya-trainer server of another project, is reported instead of used. Relay manages a container only for a local `laya.baseUrl`. `"laya": { "autostart": false }` leaves Docker alone, and `laya.image` runs another image, for example one you built with `npm run laya:image -- --variant cpu` in a Relay checkout.

## Teach Laya from your sessions

The shipped model learned from synthetic requests, so it routes your kind of work by rules of thumb. Teach it the tasks you actually do:

```
/laya learn
```

1. **Collect.** Relay lists every request of the current session with the evidence of how it went: the model and effort that ran it, the tools called, the files changed, the commands, the errors of failed tool calls, whether tests and builds passed, what laya/auto planned, and your next message (a correction there means the task was not done right). `/laya learn <session file>` reads another session instead.
2. **Label.** The agent answers Laya's 18 questions for each task from that evidence, for example "this fix needed the `balanced` tier, not `fast`: it took two failed edits and a correction". When the task taught something, it also writes a lesson: "The label comes from `locales/pt-BR/orders.json`, not the component; run `npm run i18n:check`." It saves them with the `laya_learn` tool and replies with a table of what it labeled. The labels are exercises in `~/.relay/agent/laya/training/data/dataset.jsonl`; a request learned again replaces its old labels.
3. **Remember.** From the next request on, without waiting for training and even without Docker:
   - A request close to a learned task is routed with that task's labels instead of Laya's or the keyword rules' answers. The status line shows `(memory)`. "Corrija o texto do botão Salvar na tela de pedidos, está cortado" goes to the tier and effort the learned "Corrija o texto do botão Salvar na tela de pedidos" needed, not to the cheapest tier the words "corrija o texto" suggest.
   - The model that runs a request gets the lessons of similar learned tasks: in the laya/auto plan, or in a hidden `[laya:lessons]` message when you selected a model yourself.

   Closeness is the cosine of the requests' word vectors, with words common to every coding request weighted down: routing needs 0.6, a lesson 0.45. Requests in another language than the learned one rarely match; training covers those. Turn the memory off with `"laya": { "memory": false }`.
4. **Train.** Training runs in a Docker container, `relay-laya-train`, from the model that routes today. It mixes the session tasks with a replay sample of the earlier exercises, so Laya learns the new tasks without forgetting the rest. With an 8 GB NVIDIA GPU it takes about 7 minutes; the container gets the GPU when the CUDA image runs and Docker supports GPUs (Docker Desktop with WSL 2 on Windows, the NVIDIA Container Toolkit on Linux). Without one Relay asks first, because it can take an hour or more. The current model keeps routing while it runs, and the status line shows its progress.
5. **Test and activate.** The new model and the current one answer the same held-out test, exercises neither was trained on. The new model routes requests from then on unless it answers more than 1% fewer test questions: Relay replaces the server container with one serving it, and reports how many answers on the session tasks it now gets right, before and after.

You can also ask in your own words ("learn from this conversation"): with [`tool_search`](cli.md#tools) active, the agent finds `laya_learn` itself.

| Command | Effect |
|---|---|
| `/laya learn [session file]` | Label the tasks of this session (or of a session file) and train on them |
| `/laya train` | Train again on every session task collected so far |
| `/laya models` | The shipped and trained models, their test scores, the exercises, and training progress |
| `/laya use <model>` | Route with another model, for example `/laya use v1` to go back to the shipped one |

Trained models live in the Docker volume `relay-laya-models` (about 680 MB each). Relay keeps the active one and the two newest others, and deletes older ones. Training needs Docker and the Laya image (`/laya setup`), and stops when Relay quits; it continues across `/new` and `/resume`.

## Retrain from scratch

To change the questions or rebuild the model, train with the `laya-trainer` Claude Code plugin. The questions Relay sends are the contract with the trained checkpoint, so train with Relay's own definitions:

1. `/laya-init` prepares the training tools.
2. `/laya decisions` (in Relay) writes the questions to `.laya/decisions.json`.
3. `/laya seed 1100` writes synthetic bootstrap exercises to `.laya/data/relay-seed.jsonl`; add them with `/laya-data`. Their labels follow one rule from the task profile, so they teach Laya the policy, not evidence. The session tasks in `~/.relay/agent/laya/training/data/dataset.jsonl` (source `session`) can be added the same way.
4. `/laya-train`, then `/laya-eval`.

`/laya export` writes one exercise per successful routed request, labeled only with the tier that finished it, to `.laya/data/relay-telemetry.jsonl`. Telemetry stays local and contains your requests; turn it off with `"laya": { "telemetry": false }`.

### Ship a new model

A retrained model reaches users through a new revision of the Hugging Face repository, a new manifest in the package, and the images the release builds from it:

```bash
hf upload eltonssouza/relay-laya .laya/models/v2 . --commit-message "Laya model v2"
node scripts/package-laya-model.mjs --model .laya/models/v2 --version v2 --out /tmp/laya-v2 --revision <commit from the upload>
cp /tmp/laya-v2/model-manifest.ts packages/coding-agent/src/extensions/laya/model-manifest.ts
```

`hf upload` needs `hf auth login` with a token that can write to the repository. Upload before the release that embeds the new manifest: the release workflow builds the images, which download the model files and fail on a missing or altered one, so an unknown model never ships. Users get the new image, and a container serving it, on their next Relay start.

## Commands

| Command | Effect |
|---|---|
| `/laya` | Profile, container and server status, the routing model and training progress, models with credentials, quota, and the last plan with its alternatives and escalations |
| `/laya setup`, `/laya start` | Pull the image if needed and start or update the `relay-laya` container now |
| `/laya stop` | Stop the container; the next Relay start runs it again |
| `/laya learn [session file]` | Teach Laya the tasks of this session ([details](#teach-laya-from-your-sessions)) |
| `/laya train` | Train again on the session tasks collected so far |
| `/laya models`, `/laya use <model>` | List the shipped and trained models, or route with another one |
| `/laya policy <profile>` | Cost profile for this session |
| `/laya decisions [path]` | Write the questions in laya-trainer format |
| `/laya seed [count] [path]` | Write synthetic training exercises |
| `/laya export [path]` | Write evidence-labeled exercises from telemetry |

Set `"laya": { "toolRouting": "enforce" }` to also deactivate the tools a request does not need, for example `edit` and `write` for a question. The tool set is restored before the next request is planned. Tools the router does not recognize stay active.
