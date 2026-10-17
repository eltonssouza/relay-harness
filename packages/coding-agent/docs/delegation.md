# Subordinate workers

Worker coordination is implemented independently of mandatory task phases. Ordinary
requests, direct tools and `/goal` do not require a delegation decision or a task
specification file.

Production activation remains disabled while real Laya evaluation is failing. The
built-in extension registers its worker tools as hidden until that gate is satisfied.
`createDelegationExtension({ enabled: true })` is available for explicit offline tests
and local candidate evaluation. It does not establish that a checkpoint is suitable
for automatic production delegation.

## Coordination contract

The principal proposes bounded tasks with objectives, acceptance criteria, dependencies,
inputs, resource scopes and budgets. Laya chooses direct execution, proposal revision,
or selected workers and their profiles, tools, skills and concurrency. The Harness
rejects invalid structures, unavailable resources and unsafe scheduling regardless
of the model's answer.

| Operation | Behavior |
|---|---|
| `propose_work` | Validate and persist a proposal, then request a Laya decision. Starts no workers. |
| `execute_work` | Run only selected task IDs from the current approved plan. |
| `review_work` | Review observed results against criteria, or reconcile interrupted effects after principal inspection. |
| `complete_work` | Require accepted results and final successful test evidence for selected validation or mutation tasks. |
| `/work` | Inspect the current delegated task. |
| `/work resume` | Continue after a handoff; obsolete approvals require a new proposal. |
| `/work stop` | Cancel workers, await their termination and stop the delegated task. |

These operations record coordinator decisions, never user approval. A small task can
execute directly through normal tools without creating a delegated plan.

## Execution and permissions

Workers have separate SDK histories and inherit the principal request's physical
chat model. A virtual principal cannot cause workers to select a substitute model.
Every worker tool call uses the principal's validation, hooks and permissions, plus
the selected resources, profile restrictions and task file scope. Workers cannot
delegate, discover tools, operate goals or complete the principal plan.

Investigations use read-only file tools and may overlap. Validation and mutations
hold exclusive workspace access, including against principal calls. A dependency
must have an accepted current result before its dependent task starts. File scopes
resolve directory links, and file writes reject the principal session history and
its aliases. Shell calls require explicit workspace-wide scope; tool controls do
not provide operating-system isolation.

The plan binds the checkpoint version, weights and complete artifact hash, plus the
selected profile instructions, skill files, tool descriptions, schemas and effective
budgets. Changes invalidate authorization and require a new proposal. Missing or
uncertain classifier answers preserve the proposal without starting workers; the
decision path has no keyword or alternative-model fallback. Confidence remains 0.7,
with at most one focused reassessment.

## Evidence and recovery

`relay.work.state`, `relay.work.event`, `relay.work.resources`, `relay.work.decision`
and `relay.work.content` custom entries retain the task, decisions, attempts, resource
versions, observations and full output references. These are internal versioned data.
Historical `xp.*` entries are not restored as current worker authorization.

Runtime observations carry worker and call IDs plus the workspace revision. A report
claiming that tests passed is insufficient. `complete_work` requires a recognized,
successful runner invocation after the latest mutation. Printed command names, help,
collection-only modes, pipelines and masked failures are rejected. A later source
change invalidates earlier tests. External workspace edits invalidate the plan.

Session shutdown and navigation cancel active workers. Restoration marks unfinished
attempts interrupted and requires review of recovered results. A failed attempt can
retry only after principal file-tool inspection and explicit reconciliation; completed
side effects are not automatically repeated. Worker model usage is charged once;
the principal's nested-call recorder accounts for tool usage separately.

See [Settings](settings.md#delegation-budgets) for budgets. Real acceptance uses
`test/delegation-model-eval.test.ts` and `test/delegation-native-eval.test.ts`, enabled
only by `RELAY_EVALUATE_DELEGATION=1`. Chat remains simulated in those evaluations;
classification uses an explicitly selected local completed checkpoint and validation
executes actual Node behavioral tests.
