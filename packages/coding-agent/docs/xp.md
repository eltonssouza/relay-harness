# XP task workflow

XP is the built-in workflow for every task, not an opt-in command. Before answering or
using tools, the model calls `xp_intent` to identify a task or a read-only question.
Questions do not start XP. Tasks automatically pass through Planning, Design, Testing,
Coding and Listening in order, including documentation and other non-code tasks.
Tasks run without user-controlled XP commands or a Laya server. All native tasks run the five phases
autonomously, with or without `/goal`. Design advances directly to Testing; validated
Listening completes the task without requiring user acceptance.

Each native task creates one project-local specification at `.relay/specs/<workflow-id>.md`.
Planning records the problem, requirements, constraints, risks and acceptance criteria;
Design records decisions and alternatives. Both sections exist before Testing and Coding.
Testing records cases and a validation strategy derived from the criteria, Coding records implementation and
verification, and Listening records the result and feedback. Each `xp_checkpoint` updates
its phase's section and the session state; phase gates require all previous sections to
have been recorded. The file is a working SDD owned by the XP workflow: manual edits
may be replaced at the next checkpoint. Checkpoint presence is enforced, but the harness cannot prove that the reports cover every requirement or independently verify which skills the executor applied.

### Autonomous execution

The harness records each phase report internally. It does not display XP progress or request approval.

External edits, deletion or replacement of the SDD invalidate downstream reports and
test evidence when checked before a tool call or settlement. XP returns to Design
(or Planning if it was not recorded yet), preserving the changed artifact until a
revised checkpoint. Inspect and reconcile its contents with the authorized scope,
record the revised decisions, and repeat the downstream phases automatically. A stale
checkpoint that encounters the change is blocked before it can overwrite the artifact.
External content does not authorize scope expansion. Replanning clears old reports
and the validation plan so they cannot satisfy a later cycle. During native Coding or
Listening, use `xp_checkpoint` with `replan=true` and a concrete reason in `summary`
to return to Planning for corrections within the authorized scope. Fresh test evidence
is required in the new cycle.

XP never requests user input or pauses for an intervention. If authorization or a business decision is missing, record the limitation, skip actions that require it, and continue safe work.

The goal can be completed only after Listening is reported. Decision and continuation
limits can still result in a handoff rather than an infinite loop.
The artifact is data, never executable configuration. Reports may contain project
information; keep credentials out of them and review what you commit.

Native checkpoints use deterministic gates. For executable changes, Testing requires
an observed behavioral test failure or a concrete `testPlan` describing cases and
validation to execute during Coding. This permits strategy before implementation,
as defined in `development/arquitetura_5_etapas.md`; TDD remains appropriate for
reproducible defects. Coding and Listening require successful tests after the latest
mutation. Arbitrary successful shell commands do not qualify as test evidence.
Tasks without executable behavior still report concrete review in all five phases.
Writes and edits are allowed during Testing and Coding. The harness prevents settlement
or goal completion before the Listening report. A task cannot be reclassified as a
question to bypass the workflow. A mutation after the Listening checkpoint in the same
request reopens validation and invalidates completion. User acceptance is not part of automated completion.

XP state and decision records follow the session branch and restore on session reload. XP controls phase transitions, but it is not a filesystem or shell sandbox and does not authorize deployment, messages, destructive changes or other external operations. Repository instructions and user permissions still govern tool execution.

## Engineering resources

The `engineering` built-in extension discovers the nineteen shipped skills. Profiles
live under `resources/agents`; Laya injects the chosen profile into the execution plan.
XP supplies a phase-specific role: `product-owner` for Planning and Listening,
`software-architect` for Design, `quality-assurance` for Testing and `software-engineer`
for Coding. These are profiles applied by the executor, not separate agents spawned
for every phase. `xp_intent` accepts an optional `agents` map by phase to select an
existing specialist when the task warrants it, for example
`agents: { coding: "backend-engineer", listening: "code-reviewer" }`.
`/agent <name>` loads a role explicitly.

Select skills only when they serve the actual task. Planning may use `refine-backlog`;
Design may use `decide-architecture`, `design-service`, `design-ux-flow` or threat modeling;
Testing and Coding may use `implement-feature-tdd`, `automate-tests` and `quality-baseline`.
Listening uses relevant review, feedback, reliability or incident skills when needed.
Read selected skill instructions and report only those actually applied via the
checkpoint's optional `skills` list. The harness stores these reported selections and
the assigned profile in the SDD, state, decision trace and internal phase report. Scale
profile deliverables to the task; no skill or extra collaborator is required solely
to satisfy a phase.
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
