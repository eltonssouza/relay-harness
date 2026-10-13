# XP task workflow

XP is the built-in workflow for every task, not an opt-in command. Before answering or
using tools, the model calls `xp_intent` to identify a task or a read-only question.
Questions do not start XP. Tasks automatically pass through Planning, Design, Testing,
Coding and Listening in order, including documentation and other non-code tasks.
Tasks start without `/xp start` or a Laya server. Tasks started through an active `/goal` run all five phases autonomously. Other tasks pause after Design for human approval.

Each native task creates one project-local specification at `.relay/specs/<workflow-id>.md`.
Planning records the problem, requirements, constraints, risks and acceptance criteria;
Design records decisions and alternatives. Both sections exist before Testing and Coding.
Testing records cases derived from the criteria, Coding records implementation and
verification, and Listening records the result and feedback. Each `xp_checkpoint` updates
its phase's section and the session state; phase gates require all previous sections to
have been recorded. The file is a working SDD owned by the XP workflow: manual edits
may be replaced at the next checkpoint. Checkpoint presence is enforced, but the
harness cannot prove that the reports cover every requirement. Manual `/xp` workflows
continue using session checkpoints only.

### Approving the specification

Outside `/goal`, after the Design report, XP pauses without advancing to Testing. Review
`.relay/specs/<workflow-id>.md`, then run `/xp approve-spec`. This user command records
approval in `xp.state` and a Design transition in `xp.decision`, advances to Testing,
and resumes the same task. It is not a model tool: a model claim of approval cannot
unlock Testing. Before approval, only inspection tools and Design checkpoints are
allowed; the goal cannot be completed.

Approval requires both Planning and Design reports and an unchanged, readable artifact.
Replanning or updating Planning/Design invalidates approval. External edits, deletion
or replacement of the artifact also invalidate approval when checked before a tool call
or settlement. XP returns to Design without overwriting the edited file; record the
updated Design checkpoint and approve again before continuing. Normal Testing, Coding
and Listening checkpoints update their own sections without requiring another approval.

With `/goal`, XP records Planning and Design in the same SDD and proceeds directly to
Testing, Coding and Listening. `/xp approve-spec` is not needed; the SDD is not marked
as human-approved. The goal can be completed only after Listening is reported. Decision
and continuation limits can still result in a handoff rather than an infinite loop.
The artifact is data, never executable configuration. Reports may contain project
information; keep credentials out of them and review what you commit.

Native checkpoints use deterministic gates. Behavior changes require observed failing
assertions in Testing and successful tests after the latest mutation in Coding and
Listening. Tasks without executable behavior still report validation in all five phases.
Writes and edits are allowed during Testing and Coding. The harness prevents settlement
or goal completion before the Listening report. A task cannot be reclassified as a
question to bypass the workflow. User acceptance is separate from delivering the result.

## Optional manual control with Laya

`/xp` remains available for explicit control and Laya-reviewed workflows. A coding model
writes reports, tests and code. Laya evaluates the observed state and selects
`continue_phase`, `advance`, `replan`, `finish` or `escalate`.

```text
/laya setup
/xp start Implement the order discount with boundary tests
```

The workflow starts in Planning and advances through Design, Testing, Coding and Listening.
The executor calls `xp_checkpoint` with its phase report and observed tool call IDs.
If the executor ends its response while a phase is still active, Relay starts another
model request with the current phase instructions. It pauses in Listening for user
feedback. Cancelled or failed responses are not automatically restarted. Three
completed runs without a checkpoint trigger a handoff; `/xp resume` resets that limit.
Testing requires an observed behavioral test failure; Coding requires a successful test
execution after the latest potentially mutating tool call. Arbitrary successful shell
commands do not qualify. Test recognition covers common command-line runners; a custom
runner needs an adapter before it can supply evidence. A report still needs review:
the harness cannot prove that a test covers every acceptance criterion.

Listening presents the result to the user. `/xp accept` records acceptance; Laya may then
select `finish` if fresh test evidence also exists. Feedback can lead to `replan` and a
new cycle. `/xp status` shows the current phase, `/xp stop` stops the workflow, and
`/xp resume` continues a handoff with a fresh decision budget. For documentation-only
work, explicitly use `/xp start --no-tests <goal>`.

In manual Laya workflows, each checkpoint makes one classifier request with a five-second timeout and no retry.
The thresholds are 0.5 for continuing a phase, 0.7 for transitions and 0.8 for finishing.
When Laya supplies `answer_confidence`, the client uses that answer probability for
the gate. Laya's separate `confidence` value measures distribution entropy and is
not on the probability scale used by these thresholds.
Three confidence refusals, classifier failure or fifty decisions trigger a handoff.
Repeated decisions on unchanged observations also trigger a handoff. Reports and tool
excerpts sent to Laya are bounded; the workflow goal and observed evidence remain in session state.
Manual Laya workflows do not fall back when the classifier is unavailable or fails.
An unavailable Laya cannot silently approve work. Native task transitions do not call Laya. The standard Laya model router retains its existing fallback behavior.

`xp.state` session entries restore the workflow on resume and branch navigation.
`xp.decision` entries retain the observation, compiled questions, answers, gate verdict
and classifier errors. These records contain task reports and excerpts of tool output;
keep secrets out of reports and follow the repository's logging policy.

XP controls phase transitions. It is not a filesystem or shell sandbox and does not
authorize deployment, messages, destructive changes or other external operations.
Repository instructions and user permissions still govern every tool execution.

## Engineering resources

The `engineering` built-in extension discovers the nineteen shipped skills. Profiles
live under `resources/agents`; Laya injects the chosen profile into the execution plan.
XP supplies a phase-specific role. `/agent <name>` loads a role explicitly.
Trusted project `.relay/agents/<name>.md` overrides the global profile, which overrides
the distributed profile. Existing specialist roles without a distributed profile continue
using their routing description. The expanded role choices change the training question
contract: export `/laya decisions` when preparing new training data. Existing checkpoints
are not automatically retrained, and their accuracy on the additional choices must be evaluated.

## Native browser

```text
/browser start
/mcp
```

`/browser start` registers the pinned `chrome-devtools-mcp@1.10.1` server with isolated,
headless Chrome. `/browser visible` uses a visible isolated browser. Browser tools are
discovered through `tool_search`; Chrome starts when a browser tool first needs it.
Usage statistics, CrUX requests, update checks and automatic config discovery are disabled.
An existing `chrome-devtools` entry in `mcp.json` takes precedence over native registration.
`/browser stop` removes the extension's registration; configured servers remain managed by `/mcp`.
Registration does not imply the connection succeeded: inspect `/mcp` for the actual state.

Node.js and a supported Chrome installation are required. Standalone Relay binaries
ship the server files and invoke `node` from PATH. Npm installations use their Node
runtime and installed dependency; no `npx` download is performed at activation.
The published package is used rather than building the sibling source checkout:
the local snapshot identifies itself as 1.10.1 but contains different development dependency
versions. Its unpublished changes are not included in the pinned integration.

The decision-loop design follows the observe, compile, gate, execute and trace structure
of [SystemOneHarness](https://github.com/HarnessRouter/SystemOneHarness).
The browser server remains the upstream [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
implementation, licensed under Apache-2.0.
