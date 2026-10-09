# XP development with Laya

Relay uses Laya to choose among finite workflow actions. A coding model writes reports,
tests and code. Laya evaluates the observed state and selects `continue_phase`, `advance`,
`replan`, `finish` or `escalate`. No Jev provider or Python harness is introduced.

```text
/laya setup
/xp start Implement the order discount with boundary tests
```

The workflow starts in Planning and advances through Design, Testing, Coding and Listening.
The executor calls `xp_checkpoint` with its phase report and observed tool call IDs.
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

Each checkpoint makes one classifier request with a five-second timeout and no retry.
The thresholds are 0.5 for continuing a phase, 0.7 for transitions and 0.8 for finishing.
Three confidence refusals, classifier failure or fifty decisions trigger a handoff.
Repeated decisions on unchanged observations also trigger a handoff. Reports and tool
excerpts sent to Laya are bounded; the workflow goal and observed evidence remain in session state.
There is no heuristic fallback for XP transitions. An unavailable Laya cannot silently
approve work. The standard Laya model router retains its existing fallback behavior.

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
