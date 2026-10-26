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

1. **Task intelligence (Laya).** [Laya](https://github.com/NandhaKishorM/laya) is a small local classifier, the fast "System 1". It answers 19 typed questions about the request in one call: task type, complexity, scope, risk, ambiguity, reasoning needed, recommended capability tier and effort, agent role, validation level, the tools needed, whether the task is security-sensitive, and the library category. Relay calls it through the same System One protocol it uses for TypeSafe classifiers.
2. **Policy engine.** Deterministic rules set floors Laya cannot lower. Production database migrations, authentication, security vulnerabilities and payment processing require at least the `strong` tier, an effort of at least `medium`, and review. High risk also requires `strong`. An answer whose confidence is below `laya.minConfidence` raises the tier by one.
3. **Model registry.** Tiers are abstract (`fast`, `balanced`, `strong`, `frontier`), so Laya never learns model names. The registry maps each tier to concrete models; only models whose provider has credentials are candidates.
4. **Selection.** Each candidate gets a utility from the cost profile: `quality × P(success) − cost × quota cost − latency × latency − risk × failure risk`. `P(success)` starts from a prior (0.90 when the model's tier is the required tier, +0.04 per tier above, −0.18 per tier below) and moves toward the observed success rate of that model on that task class. The best candidate whose success estimate reaches the profile minimum wins.
5. **Execution.** The routed model gets a short `[laya:plan]` message next to your request: the role to take, relevant skills, the tools expected, and how to validate. It is sent after your message, not in the system prompt, so the prompt cache stays valid.
6. **Escalation.** After `laya.escalateAfterFailures` failed tool calls (or harness verification requests) in a turn, the task moves to the next tier. A rate-limit or overload error moves it to an equivalent model of another provider. `laya.budget` caps escalation per task: `maxAttempts` counts the first model choice and each escalation, and `maxCostPerTask` is the provider cost already spent on the task. When a limit is reached, Laya stays on the current model and says why; it never stops a running task.
7. **Telemetry.** Each request is recorded with its classification, selected model, outcome, tests and usage. The history feeds `P(success)` in later sessions.

Reasoning effort follows Laya's recommendation up to `xhigh`. Routing never uses `max`. `laya/auto` has no thinking level of its own: a selected level would cap Laya's choice without you noticing. The footer shows the routed model and effort next to the selection, and the status line shows the task type and tier.

When the Laya server is not running (Python is missing, installation is in progress, or the selected Docker runtime is unavailable), keyword rules in English and Portuguese answer instead, and the status line shows `(rules)`. Laya is retried a minute later.

## Technical library routing

`library_category` is a choice among ten stable IDs: `languages`, `algorithms`, `architecture`, `engineering`, `databases`, `web_frontend`, `devops`, `security`, `automation`, and `frameworks`. It accompanies the execution decisions in the same classifier request. The contract now has 19 questions: 18 existing questions plus the library category. Retrain before relying on category predictions from the shipped v3 checkpoint.

Category descriptions are concise enough to fit the native checkpoint's 256-token question budget. Longer descriptions caused Laya to cap every option at 24 tokens, dropping terms such as Git. Verify the complete rendered options with the checkpoint tokenizer when changing these descriptions, and keep training and serving definitions identical.

Point `LAYA_LIBRARY_DIR` at a directory containing `LIBRARY_INDEX.json` and the guide files. Without it, Relay checks `<cwd>/library`. Extension consumers can pass `libraryDir` to `layaExtension`. The index's category directory determines the label: REST API design belongs to `web_frontend`, React to `frameworks`, Git to `devops`, SSH to `security`, and n8n to `automation`. The actual index places *Refactoring and Code Improvement* and *Writing Maintainable Code* in `architecture`; the shipped model follows that ownership rather than a generic engineering rule.

The plan lists up to two guides ranked lexically **inside the predicted category**. Confidence below the calibrated threshold gives suggestions only. Keyword fallbacks abstain from category selection. No matching title means no injection. `LAYA_LIBRARY_MIN_CONFIDENCE` (or extension option `libraryMinConfidence`) enables injection only after validation has established a threshold. With no override, injection stays disabled. Invalid overrides disable injection. References are bounded to 12,000 characters per request; excerpts say when truncated. Paths and symlinks outside the configured root are rejected.

## Cost profiles

| Profile | Weights | Minimum success estimate |
|---|---|---|
| `economy` | cost 50%, quality 30%, latency 20% | 0.75 |
| `balanced` (default) | quality 45%, cost 30%, latency 15%, risk 10% | 0.85 |
| `quality` | quality 70%, risk 20%, cost 10% | 0.90 |
| `critical` | quality 70%, risk 30% | 0.95 |

Select one with `laya.policy`, `relay --laya-policy economy`, or `/laya policy quality` for the session.

## Model registry

Relay keeps no list of model IDs. The default tiers come from the catalog: for each of Anthropic, OpenAI API, OpenAI Codex, GitHub Copilot, Google, and Google Antigravity, Relay takes the permitted models that have credentials and orders them by output price, then input price. A price level maps to a tier by its position among that provider's distinct levels: three levels give `fast`, `balanced`, and `strong`, and a fourth adds `frontier`. Models that share a price, such as the effort variants of one model, share a tier. A provider with a single price level carries no capability signal and gets no default tiers. Every other provider, such as a gateway, a cloud account or a local server, routes only through `laya.models` or `laya.modelGroups`, so Laya never sends a request to a provider nobody named for it.

With Anthropic credentials, for example, Claude Haiku 5.5 is `fast`, Sonnet 5.5 `balanced`, and Opus 5.5 `strong`. Prices move with the catalog, and so do the tiers. Each model is ranked only within its selected provider when `laya.followProvider` is enabled.

The harness permits only Claude Opus, Sonnet, and Haiku 5.5 across providers, including supported gateway IDs and effort variants. Claude Fable and older Claude versions are excluded from manual selection and execution, not just Laya routing. The `openai-codex` provider permits only `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`, and `gpt-5.6-terra`; this GPT restriction does not apply to OpenAI API or GitHub Copilot. Other model families are unchanged.

Explicit configuration, model groups, restored sessions, and routing fallbacks cannot bypass this policy. If no permitted candidate is available, routing fails rather than using an excluded model. Models must still exist in the provider's catalog and have configured credentials; these rules do not create catalog entries.

Sign in with `/login google-antigravity` to make the account's discovered models available to Laya. Separate `low`, `medium`, and `high` effort IDs share a price and therefore a tier. Only IDs present in the account catalog are candidates. These defaults also work with `laya.followProvider`; explicit `laya.models` and `laya.modelGroups` settings still take precedence.

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

Set `laya.localOnly` to `true` to keep `laya/auto` on models served from this machine: only models whose base URL is `localhost`, `127.0.0.1` or `[::1]` are candidates, including the selected-model fallback. A model with a missing or malformed base URL counts as remote. If no local model has credentials, the request fails with an error instead of falling back to a cloud model. Laya's classifier itself is unaffected; it already runs locally by default.

## Local CPU runtime

By default the shipped `relay-laya-v5` model runs inside Relay with ONNX Runtime and needs no Python (see [In-process ONNX runtime](#in-process-onnx-runtime-no-python)). The rest of this section describes the Python runtime, selected with `"laya": { "runtime": "native" }`.

The shipped, already-trained `relay-laya-v5` checkpoint runs locally on CPU in that runtime.  It is a versioned alias for the existing Candidate20 weights; it does not contain newly trained weights. Docker, CUDA and Ollama are not required. Install Python 3.10 through 3.13 first; Relay discovers an existing interpreter and creates its own isolated environment under `~/.relay/agent/laya/local-runtime`. It never changes your global Python packages or installs Python itself.

Interactive startup prepares the environment in the background. `/laya setup` starts it explicitly. Relay installs CPU-only PyTorch and pinned Laya/server dependencies, then downloads the six files from the package's pinned Hugging Face revision. The checkpoint and tokenizer total **678,203,281 bytes (678 MB)**; Python dependencies are additional and vary by platform. Cached files are checked by size and SHA-256 and reused; interrupted or corrupt downloads never replace a validated file. No retraining or weight conversion is involved.

The server exposes the same `/health` and `/v1/systemone` endpoints, bound to loopback only. It stays available across sessions in the same Relay process and stops when that process exits. The checkpoint and environment stay cached for the next launch. Print/SDK sessions do not install it automatically. `autostart: false` disables automatic setup; an existing compatible server can still answer requests.

A Windows x64 / Python 3.13 validation resolved **173,814,022 bytes of dependency wheels**, for **852,017,303 bytes (852 MB)** including the pinned checkpoint. This excludes Python itself, package-index metadata and transport overhead; other platforms or dependency resolutions can differ. CPU smoke requests in Portuguese and English returned all 19 answers in about 11 seconds in isolation and up to 38 seconds during concurrent validation. Native inference therefore defaults to a 60-second request timeout; `laya.timeoutMs` overrides it.

An interpreter outside PATH can be selected by executable path:

```json
{
  "laya": {
    "runtime": "native",
    "python": "C:/Python313/python.exe"
  }
}
```

### In-process ONNX runtime (no Python)

This is the default runtime (`"laya": { "runtime": "onnx" }`). It runs the shipped model inside Relay with ONNX Runtime, so neither Python nor Docker is needed. Set `"runtime": "native"` to use the Python runtime instead:

```json
{
  "laya": {
    "runtime": "native"
  }
}
```

`/laya setup` (or the first interactive start) downloads `onnx/laya.onnx` and the tokenizer files from `eltonssouza/relay-laya` at a pinned commit, about 1.3 GB once, into `~/.relay/agent/laya/onnx-runtime/<commit>`. Every file is checked by size and SHA-256 before use; a mismatched download is deleted and reported. Later starts only verify the local files and work offline. The model takes several GB of memory while loaded and answers in about 6 seconds per request on CPU, like the Python runtime. Its answers match the Python runtime on the 46 reference requests within 0.002.

Requests run one at a time with a 60-second limit. After three consecutive failures the runtime pauses for a minute. While it is unavailable, keyword rules answer as with the other runtimes. A smaller FP16 or INT8 file is not offered because it changed answers in measurement.

An explicit `laya.runtime: "docker"` or `laya.image` selects Docker.

## Laya runs in Docker

Docker remains available with `"laya": { "runtime": "docker" }`, or an explicit `laya.image`. In this mode, Laya and Python run in `ghcr.io/eltonssouza/relay-laya`, built by Relay's release from the same sources as the package:

| Image | Used when | Size |
|---|---|---|
| `relay-laya-v5-cpu-<hash>` | No NVIDIA GPU | about 2 GB |
| `relay-laya-v5-cuda-<hash>` | `nvidia-smi` finds an NVIDIA GPU | about 6 GB |

The image holds Python 3.11, `torch`, `laya[serve]`, the shipped model from the Hugging Face repository [eltonssouza/relay-laya](https://huggingface.co/eltonssouza/relay-laya) (pinned to one commit, every file checked against the sha256 in the package), and the script that serves it. The tag ends in a hash of all of that, so each Relay version runs the image built from its own sources.

When Docker inference is selected, every interactive Relay start makes sure, in the background, that:

1. the image is present, pulling it the first time (the status line shows the layers);
2. a container named `relay-laya` runs it with the shipped model, published on `127.0.0.1:8737` only (the port of `laya.baseUrl`), with `--restart unless-stopped`;
3. the server answers.

The container then keeps running between sessions and comes back with Docker, so requests do not wait for the model to load. On the host, `~/.relay/agent/laya` only holds Relay's own data, such as telemetry. A Python environment or model left there by Relay 1.0.2 is deleted.

Until the server answers, and whenever Docker is missing or stopped, keyword rules route requests; Relay says once why Laya is not running. Install [Docker Desktop](https://docs.docker.com/get-started/get-docker/) (Windows, macOS) or Docker Engine (Linux) and start it; the next Relay start installs Laya. `/laya setup` does it right away.

A server that already answers on the port when there is no `relay-laya` container is used as is, so you can run your own; one that announces other questions than Relay's, such as a laya-trainer server of another project, is reported instead of used. Relay manages a container only for a local `laya.baseUrl`. `"laya": { "autostart": false }` leaves Docker alone, and `laya.image` runs another image, for example one you built with `npm run laya:image -- --variant cpu` in a Relay checkout.

## Rebuild the model

Relay does not train Laya. To change the questions or rebuild the model, train outside Relay with the `laya-trainer` Claude Code plugin. The questions Relay sends are the contract with the trained checkpoint, so train with Relay's own definitions:

1. `/laya-init` prepares the training tools.
2. `/laya decisions` (in Relay) writes the questions to `.laya/decisions.json`.
3. Write the training exercises, then run `/laya-train` and `/laya-eval`.

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
| `/laya` | Profile, runtime and server status, models with credentials, quota, and the last plan with its alternatives and escalations |
| `/laya setup`, `/laya start` | Install and start the selected local CPU or Docker runtime |
| `/laya stop` | Stop this process's local server or the managed Docker container |
| `/laya policy <profile>` | Cost profile for this session |
| `/laya decisions [path]` | Write the questions in laya-trainer format |

Set `"laya": { "toolRouting": "enforce" }` to also deactivate the tools a request does not need, for example `edit` and `write` for a question. The tool set is restored before the next request is planned. Tools the router does not recognize stay active.

Set `"laya": { "toolRetrieval": 3 }` to opt into local lexical retrieval of up to three deferred tools per request. Prompt words are matched against each tool's name, label, and description, with a small Portuguese–English vocabulary for common actions. Unmatched and hidden tools stay unavailable. Retrieved tools are restored before the next request if the active tool set has not been changed elsewhere. `0` (the default) disables retrieval. This is still lexical matching, not semantic search; measure recall on anonymized production prompts before relying on it for tool discovery.

Enable `"toolRetrievalTelemetry": true` alongside `"toolRetrieval"` to record observed retrieval counts in the agent directory's `laya/tool-retrieval.jsonl`. It is off by default and respects `"telemetry": false`. Each completed routed request records a timestamp and counts of candidates, retrieved tools, distinct invoked tools, and invoked tools among those retrieved. It does not record prompts, tool names, or project paths. These counts measure observed usage, not precision or recall; relevance requires independently labeled examples. The existing `telemetry.jsonl` is separate and still records request text when general telemetry is enabled.
