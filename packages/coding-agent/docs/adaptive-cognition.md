# Adaptive Cognitive Intelligence (modes)

Adaptive Cognitive Intelligence (ACI) controls how much [Laya](laya.md) intervenes in a request. Laya picks a model tier, a reasoning effort, a validation level and an agent for each request; the ACI mode decides whether that decision is only recorded, shown, or applied.

ACI is disabled by default. Disabled, Laya behaves exactly as before: `laya/auto` applies its decision and other models are left alone.

## Enable a mode

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
| `adaptiveCognition.enabled` | `false` | Turns ACI on. |
| `adaptiveCognition.mode` | `observe` | `observe`, `assist`, `adaptive` or `strict`. |
| `laya.heuristicFirst` | `false` | In `adaptive` mode only, skips ONNX for a clear, small, low-risk request. Security-sensitive, ambiguous, broad or tool-heavy requests still run Laya. Other modes retain the existing assessment path, including learned-memory lookup. |

The experimental shortcut requires the boolean `true` (not a string). It accepts only keyword assessments with complexity at most 0.25, zero detected risk and ambiguity, and single-line or single-file scope. Long requests and explicit module/repository scope signals are excluded even when another keyword suggests a small change. Learned task memory keeps precedence. These are conservative routing hints, not a security authorization mechanism: permissions, model restrictions and host budget guards remain authoritative.

Telemetry marks intentional skips with `classification.heuristic_fast_path: true`. A missing flag is not evidence that inference ran: learned memory and classifier failures remain separate assessment paths. Measure quality, cost, classifier calls and end-to-end latency together before enabling the shortcut broadly.

| Mode | With another model selected | With `laya/auto` selected |
| --- | --- | --- |
| `observe` | Records the decision. Nothing changes. | Applies the decision, as without ACI, and records it. |
| `assist` | Records the decision and shows it as a notice, for example `Laya suggests strong • medium • software-engineer`. Nothing is applied until you select `laya/auto`. | Applies the decision and records it. |
| `adaptive` | Records the decision. | Applies the decision and records it. This is plain `laya/auto` behavior. |
| `strict` | Records the decision. | Applies the decision only when Laya answered with at least `laya.minConfidence`. If Laya did not answer, or answered with lower confidence, the request fails with an error instead of being routed by keyword rules. |

## What a mode never does

- No mode grants a tool or permission. Laya's `requires_*` answers can only remove unneeded tools when `laya.toolRouting` is `enforce`.
- `laya.localOnly`, sensitive-area rules and your own model and tool selections always win over Laya's recommendation.
- The agent Laya picks sets the role and skills for the request. A mode does not widen what that agent can do.

## What gets recorded

Before each request, Relay appends an `aci.observe` custom entry to the session. It is stored in the session file and is never sent to the model:

- `mode` and `source` (`laya`, `memory` or `heuristic`). When `laya/auto` is not the selected model, the decision comes from the local keyword rules, so recording adds no inference call.
- `taskType` and `confidence`: the task classification. Confidence is Laya's certainty about its labels, not a guarantee of the result's quality.
- `requiredTier`, `minTier`, `effort`, `thinkingLevel`, `validation`: what the policy chose.
- `rules` and `escalations`: why.
- `decision`: what Laya suggested next to what the policy applied (`suggestedTier`, `effectiveTier`, `suggestedEffort`, `effectiveEffort`, `decisionReasonCodes`).

To turn ACI off, remove the setting or set `enabled` to `false`.
