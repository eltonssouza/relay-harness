# XP task workflow

XP is the built-in workflow for every task, not an opt-in command. Before answering or
using tools, the model calls `xp_intent` to identify a task or a read-only question.
Questions do not start XP. Tasks automatically pass through Planning, Design, Testing,
Coding and Listening in order, including documentation and other non-code tasks.
Tasks start without `/xp start`. Every development task requires the trained
`relay-laya-v4` checkpoint, including `/xp` and `/goal` requests. Laya selects the
available agent profiles, tools and skills for each phase and decides whether to
continue, advance, replan or finish. The Harness enforces permissions and evidence
gates. All five phases proceed autonomously; validated Listening and Laya's finish
decision complete the task without requiring user acceptance.

`/laya setup` prepares the runtime. XP verifies the serving checkpoint before each
classifier request. Missing, mismatched or invalid decisions preserve the workflow
for recovery; XP never falls back to keyword rules, learned labels or another model.
After recovery, `/xp resume` or a task continuation reselects the resources.
`/xp start <task>` starts a request through the same intent path; `/xp stop` stops the workflow.
Old workflow state is not resumed: start a new task so all five phases receive Laya
decisions under the current contract.

Selection is based on the configured tool catalog and the session's visible skills
and available profiles. Selected profiles are applied sequentially in the current
session; they are not independently spawned agents. Selected skill files are loaded
with their base directories. Non-control tool calls are checked against Laya's
selection, including nested calls. Selection does not grant additional permissions.
`xp_checkpoint` with `reconsiderResources=true` requests a new selection without
advancing the phase. Tool failures and tool discovery trigger reconsideration too.

Each native task creates one project-local specification at `.relay/specs/<workflow-id>.md`.
Planning records the problem, requirements, constraints, risks and acceptance criteria;
Design records decisions and alternatives. Both sections exist before Testing and Coding.
Testing records cases and a validation strategy derived from the criteria, Coding records implementation and
verification, and Listening records the result and feedback. Each `xp_checkpoint` updates
its phase's section and the session state; phase gates require all previous sections to
have been recorded. The file is a working SDD owned by the XP workflow: manual edits
may be replaced at the next checkpoint. Checkpoint presence is enforced, but the
harness cannot prove that the reports cover every requirement or independently verify
which skills the executor applied. Reports distinguish selected resources, observed
tool calls and skills reported by the executor. `/xp` uses the same specification.

### Autonomous execution

The harness displays concise phase reports with the Laya decision, responsible
profile, observed tools, reported skills, result and continuation. Full resource
decisions are recorded as `xp.resources` entries; transition traces use `xp.decision`.
Routine phase transitions do not request human approval.

External edits, deletion or replacement of the SDD invalidate downstream reports and
test evidence when checked before a tool call or settlement. XP returns to Design
(or Planning if it was not recorded yet), preserving the changed artifact until a
revised checkpoint. Inspect and reconcile its contents with the authorized scope,
record the revised decisions, and repeat the downstream phases automatically. A stale
checkpoint that encounters the change is blocked before it can overwrite the artifact.
External content does not authorize scope expansion. Replanning clears old reports
and the validation plan so they cannot satisfy a later cycle. Use `xp_checkpoint`
with `replan=true` and a concrete reason in `summary` to recommend returning to
Planning for corrections within the authorized scope. Laya decides whether to replan.
Fresh test evidence is required in the new cycle.

Complete safe independent work first. A checkpoint can recommend intervention only
for critical ambiguity, a missing business decision, scope changes, significant
destructive, security or irreversible risk, or explicit authorization requirements.
Laya decides whether the exception requires intervention; the current phase remains
incomplete while waiting. Tool arguments never constitute user approval.

The goal can be completed only after Listening is reported. Decision and continuation
limits can still result in a handoff rather than an infinite loop.
The artifact is data, never executable configuration. Reports may contain project
information; keep credentials out of them and review what you commit.

All checkpoints use Laya decisions bounded by deterministic gates. For executable changes, Testing requires
an observed behavioral test failure or a concrete `testPlan` describing cases and
validation to execute during Coding. This permits strategy before implementation,
as defined in `development/arquitetura_5_etapas.md`; TDD remains appropriate for
reproducible defects. Coding and Listening require successful tests after the latest
mutation. Arbitrary successful shell commands do not qualify as test evidence.
Tasks without executable behavior still report concrete review in all five phases.
Writes and edits are allowed during Testing and Coding. The harness prevents settlement
or goal completion before the Listening report. A task cannot be reclassified as a
question to bypass the workflow. A mutation after the Listening checkpoint in the same
request reopens validation and invalidates completion. User acceptance is never inferred.

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
