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

1. **Task intelligence (Laya).** [Laya](https://github.com/NandhaKishorM/laya) is a small local classifier, the fast "System 1". It answers 18 typed questions about the request in one call: task type, complexity, scope, risk, ambiguity, reasoning needed, recommended capability tier and effort, agent role, validation level, the tools needed, and whether the task is security-sensitive. Relay calls it through the same System One protocol it uses for TypeSafe classifiers.
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

## Train and serve Laya

Laya is trained with the `laya-trainer` Claude Code plugin. The questions Relay sends are the contract with the trained checkpoint, so train with Relay's own definitions:

1. `/laya-init` prepares the training tools.
2. `/laya decisions` (in Relay) writes the questions to `.laya/decisions.json`.
3. `/laya seed 1100` writes synthetic bootstrap exercises to `.laya/data/relay-seed.jsonl`; add them with `/laya-data`. Their labels follow one rule from the task profile, so they teach Laya the policy, not evidence.
4. `/laya-train`, `/laya-eval`, then `/laya-serve` starts the server on `http://127.0.0.1:8000`.

Over time, replace opinion with evidence: `/laya export` writes one exercise per successful routed request, labeled with the tier that finished it, to `.laya/data/relay-telemetry.jsonl`. Review it, add it with `/laya-data`, and train again. Telemetry stays local and contains your requests; turn it off with `"laya": { "telemetry": false }`.

## Commands

| Command | Effect |
|---|---|
| `/laya` | Profile, Laya server status, models with credentials, quota, and the last plan with its alternatives and escalations |
| `/laya policy <profile>` | Cost profile for this session |
| `/laya decisions [path]` | Write the questions in laya-trainer format |
| `/laya seed [count] [path]` | Write synthetic training exercises |
| `/laya export [path]` | Write evidence-labeled exercises from telemetry |

Set `"laya": { "toolRouting": "enforce" }` to also deactivate the tools a request does not need, for example `edit` and `write` for a question. The tool set is restored before the next request is planned. Tools the router does not recognize stay active.
