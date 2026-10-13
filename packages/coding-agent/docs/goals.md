# Persistent goals

`/goal` keeps an objective attached to the current conversation. After a normal answer, Relay continues automatically while the goal is active. The agent must record verified completion or a blocker through `update_goal` to stop the goal loop.

```text
/goal Fix the checkout failure, verify the checkout test, and preserve the public API.
/goal --tokens 100000 Reduce p95 below 120 ms, verified by the checkout benchmark.
/goal
/goal pause
/goal resume
/goal clear
```

Include the desired result, verification criteria, constraints, allowed scope, and required information if blocked in the objective. `/goal` without arguments shows status, tokens, turns, and the latest progress or evidence report. An unfinished goal must be cleared before creating another.

Pause interrupts the current execution. Resume starts another turn toward the same objective, keeping accumulated usage. Clear removes the current goal and interrupts its execution. A completed goal can be replaced directly. A blocked goal requires `/goal resume` after providing the missing information. A terminal provider error or interrupted response pauses the goal; it does not trigger another goal attempt.

The optional token budget counts reported assistant, tool, and compaction tokens while the goal is active, including cached tokens. Relay checks it at response boundaries. The last request can exceed the budget; this is not a provider-side output limit or a monetary cap. Exhaustion stops the run without claiming completion. Clear the exhausted goal before creating one with a new budget. No budget is imposed when omitted.

The built-in extension supplies `create_goal`, `get_goal`, and `update_goal`. These tools are available through tool discovery; starting or restoring an active goal activates the read and update tools. `create_goal` requires an explicit user request. `update_goal` accepts `active`, `complete`, or `blocked` plus a non-empty report. Completion evidence is supplied and evaluated by the agent, not independently proven by the state manager. The model cannot pause, resume, clear, or raise the budget through this tool.

State is saved as `relay.goal` custom session entries. It follows the current session branch, survives compaction and reload, and does not affect other conversations. Loading a session restores its goal but does not start background work: send a prompt to continue an active goal, or use `/goal resume` for a paused or blocked one. In-memory sessions retain goals only for their lifetime. Clearing appends a null entry; older history remains available in the session tree.
