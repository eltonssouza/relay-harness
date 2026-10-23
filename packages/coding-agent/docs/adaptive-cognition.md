# Adaptive Cognitive Intelligence (observe mode)

Adaptive Cognitive Intelligence (ACI) is the planned evolution of [Laya](laya.md) routing. Laya can already choose a model tier, a reasoning effort and a validation level for each request; ACI first measures those decisions before anything new is allowed to act on them.

Only **observe mode** exists today. It is disabled by default and never changes the model, reasoning effort, active tools, prompts or responses.

## Enable observe mode

Add this to `settings.json` (global or project):

```json
{
  "adaptiveCognition": {
    "enabled": true,
    "mode": "observe"
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `adaptiveCognition.enabled` | `false` | Records decisions when `true`. |
| `adaptiveCognition.mode` | `observe` | The only supported mode. |

## What gets recorded

Before each request, Relay appends an `aci.observe` custom entry to the session. The entry is stored in the session file and is never sent to the model:

- `source`: `laya`, `memory` or `heuristic`. When `laya/auto` is not the selected model, the decision comes from the local heuristic, so observe mode adds no network call.
- `taskType` and `confidence`: the task classification.
- `requiredTier`, `minTier`, `effort`, `thinkingLevel`, `validation`: what the policy would choose.
- `rules` and `escalations`: why it would choose it.

When `laya/auto` is the selected model, the entry repeats the decision Laya actually applied.

To turn it off, remove the setting or set `enabled` to `false`.
