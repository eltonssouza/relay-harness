---
name: delegate
description: Decide whether to hand work to subagents, which agent and model to use, how to brief them, and how to merge their results. Use when a task has independent workstreams, needs exploration alongside implementation, or needs an independent review.
---

# Delegating to subagents

You stay responsible for decomposition, talking to the user, approvals, synthesis, and the final claim. Delegate outcomes, not vague help.

## Decide

Delegate only when at least one holds:

- Two or more workstreams can proceed independently.
- A slow command or test run would otherwise block you.
- A bounded investigation can gather evidence while you work on the main path.
- An independent review or verification would reduce real risk.

Stay single-agent when the task is small, the next step needs the previous result, agents would edit the same files, or briefing costs about as much as doing the work.

## Pick the agent and model

Choose by ambiguity, coupling, and consequence, not task size:

- **Leaf** (scout, worker on a scoped change, reviewer, verifier): bounded work; a fast model is usually enough. Leaves do not delegate further.
- **Senior critic** (architecture, security, competing hypotheses): the strongest model available. It returns a recommendation; you decide.

Raise effort on a leaf before switching to a stronger model. Parallel scouts on different, cheaper models are fine.

## Brief each agent

The agent has not seen this conversation. Give it:

1. The objective and why it matters.
2. The exact scope: paths, systems, commands.
3. Which files it may change, or that it is read-only.
4. The constraints the user stated.
5. How to validate the result, and the return format.

Never give two agents overlapping files in one checkout.

## Integrate

- Treat results as evidence, not conclusions. Re-check before you claim something is fixed, merged, or released; use the `verifier` agent for completion claims.
- When agents disagree, say which evidence wins and why; prefer the agent that read the primary source over one reasoning from a summary.
- Stop or redirect an agent that expands its scope.
- Keep destructive, publishing, and merge decisions with the user.
- Answer with one integrated result, not a stack of agent reports.
