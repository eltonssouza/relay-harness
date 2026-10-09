# SLOs that mean something, and alerts that are worth waking for

Load this when defining the SLI/SLO set or the alerting policy.

## Choosing the SLI before the SLO

An SLO on the wrong indicator is precise and useless. Pick the indicator from
the user's experience, not from what is easy to collect:

| Service shape | Indicator that reflects the user | Indicator that does not |
|---|---|---|
| Request/response | Proportion of requests served correctly under N ms | CPU, memory, instance count |
| Pipeline / batch | Proportion of records processed within the window | Job exit code |
| Storage | Proportion of reads returning fresh, correct data | Disk usage |
| Long-lived connection | Proportion of session-minutes without a drop | Connection count |

Two rules: measure as close to the user as you can, and measure a proportion
rather than an average. An average hides exactly the tail the user notices.

## Setting the target from what already happens

An SLO is a decision about how much unreliability is acceptable, not an
aspiration. Start from the measured current level and ask whether anyone has
complained. If nobody has, the current level is probably fine and the SLO
should sit just under it. A target set above what anyone needs converts every
ordinary week into an incident.

100% is not a target. It removes the error budget, and with it the ability to
release anything.

## The error budget is the point

The budget is what the SLO buys you: permission to change things. Decide, in
advance and in writing, what happens when it is spent - that is the decision
nobody can make calmly during the incident that spends it.

Three anti-patterns worth naming, because each one wastes the mechanism:

- **Ignoring the budget and shipping anyway.** The SLO becomes a dashboard.
- **Treating any budget spend as failure.** The budget exists to be spent;
  unspent budget means you were too conservative to have learned anything.
- **Negotiating the response during the crisis.** Whatever gets agreed under
  pressure will be the most expensive available option.

## Alert on symptoms, not on causes

An alert should fire because a user is affected, not because a machine is
unusual. High CPU is not an alert; requests failing is.

Every alert needs four things before it is allowed to page anyone:

1. **A user-visible symptom** it corresponds to.
2. **An owner** who can act on it.
3. **A runbook** that says what to do first.
4. **An action** that is not "watch it." An alert with no action is a
   notification, and it belongs somewhere that does not wake people.

An alert that fires and is routinely ignored is worse than no alert: it trains
the team to ignore the class, and the real one arrives in that class.
