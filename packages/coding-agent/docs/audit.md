# Opt-in universal static audit

The universal-audit protocol is integrated as a **local, opt-in, static analysis workflow**, not as a generic multi-agent shell executor. Read the [Portuguese user manual](auditoria-manual.pt-BR.md) or [Portuguese technical reference](auditoria-tecnica.pt-BR.md). It does not enable experimental delegation or change normal coding-agent tools.

## Use

Set `RELAY_AUDIT_ENABLED=1` **before starting Relay** (PowerShell: `$env:RELAY_AUDIT_ENABLED = '1'`). Select the model you intend to authorize. Create a config outside the target, for example `audit.yaml`:

```yaml
version: '3.0'
project:
  name: example
  repository_path: ../target
snapshot:
  policy: working-tree # explicit consent: includes modified, untracked and ignored files unless excluded
  git_revision: false # optional: true allows bounded HEAD/loose-ref identity reads only, never history/hooks
scope:
  include: ['**/*']
  exclude: ['node_modules/**', 'dist/**', 'vendor/**']
  output_root: ./audit-output # outside target by default; paths resolve relative to this config
  runtime_testing: false
  sandbox_authorized: false
  external_network_access: false # tool network, not the separately authorized model transport
  git_history_analysis: false
  allow_write_to_target: false
  allow_publish_github_issues: false
model:
  authorized: true # required even for a local model; authorizes sending redacted scoped code/context
  provider: YOUR_SELECTED_PROVIDER
  id: YOUR_SELECTED_MODEL_ID
context:
  target_jurisdictions: []
  regulated_industries: []
  personal_data_processing: unknown
execution:
  max_parallel_specialists: 1 # 1..4
  max_retries: 1 # bounded contract correction, 0..2
  max_task_ms: 120000
  max_run_ms: 1800000
  max_task_tokens: 16000
  max_task_cost: 2
  max_task_tool_calls: 40
  max_task_output_bytes: 65536
  max_tokens: 200000
  max_cost: 10
  max_tool_calls: 200
  max_output_bytes: 262144
  max_handoffs: 20
  generate_pdf: false
  generate_issues_drafts: false
```

Commands accept quoted paths with spaces:

```text
/audit "audit.yaml"
/audit-status
/audit-cancel
/audit-status "audit.yaml" audit-<uuid>
/audit-resume "audit.yaml" audit-<uuid>
/audit-resume "audit.yaml" audit-<uuid> --recover-stale-lock
```

Execution runs in the background so status/cancel remain usable. There is one active audit per host and a per-run exclusive filesystem lock. Shutdown cancels active work. A stale-lock recovery request only removes a lock whose recorded PID is demonstrably absent; it never overrides an active/unknown process. No approval prompts or manual review gates are added to ordinary execution.

A config must explicitly authorize the exact provider/model currently selected. No automatic model fallback or external metadata lookup occurs. Egress to that provider is distinct from network tools: `external_network_access: true` is unsupported. Host-registered providers, credentials, transport security and existing host telemetry remain trusted host responsibilities; the audit does not add telemetry exports.

All unsupported capabilities fail in preflight, before source inspection: runtime tests, sandbox execution, Git history, network tools, remote issue publication, arbitrary target writes and PDF generation. Unknown config keys also fail. The upstream example config is a protocol reference, **not** an executable Harness default: it enables unsupported history/PDF flags. Use the example above instead.

### Outputs inside the target

Prefer an external output root. To explicitly authorize just an in-target report directory, add `scope.allow_output_in_target: true` and name that directory in `output_root`. This **never** authorizes source edits or model write tools; `allow_write_to_target: true` still fails. The output subtree is excluded from snapshot content, including on resume. Target root, target ancestors, Git metadata, junctions/symlinks and network/device paths are not valid output destinations.

## Architecture design

### 1. Drivers and quality attributes

Priorities: least authority, grounded evidence, honest coverage, recoverable failures, deterministic contracts and compatibility with source/npm/standalone packaging. This is a modular in-process subsystem, not a new service, database, scheduler deployment or distributed orchestrator.

### 2. C4 views

**Context:** operator -> trusted Harness host -> explicitly selected model provider. The repository is untrusted data; local run artifacts are private operator-owned outputs.

**Containers:** existing Node/Bun CLI process; existing model transport; target filesystem (read only); dedicated artifact directory (coordinator writes only). There is no new HTTP API, datastore or broker.

**Components:**

```text
/audit commands -> preflight -> bounded immutable snapshot
                              -> coordinator / budget ledger / checkpoints
                                 -> discovery and threat-model sessions
                                 -> 20 domain tasks / six routed specialist roles
                                 -> bounded consult tasks (no recursive handoffs)
                                 -> independent evidence-validator sessions
                                 -> report-editorial session
                                 -> deterministic JSON/Markdown renderer + local issue drafts
```

`src/core/audit/` owns policy, contracts, snapshot tools, orchestration, persistence and deterministic rendering. `src/extensions/audit/` is only the opt-in command adapter. `resources/audit/` holds approved protocol snapshots. It does not depend on `core/delegation/` or activate `DELEGATION_VALIDATED`.

### 3. Flow and consistency

1. Validate all consent, unsupported options, budgets, paths and context. Unknown jurisdiction/industry/data-processing facts remain unknown.
2. Inventory and freeze a content-addressed, redacted working-tree snapshot. Source reads, literal searches and evidence rereads use only that snapshot, never the live filesystem.
3. Discover applicability for all domains `01`..`20` and build an evidence-grounded threat model. Exclusions are not proof of non-applicability. Deterministic profiles come from scoped file/manifest names.
4. Execute routed tasks with a configurable bounded pool. Handoffs reference existing primary tasks/roles, are checked against routing and cycle/quantity limits, and produce separate scoped consultation tasks. Consultations cannot request more handoffs.
5. Accept only schema-valid, identity/revision/scope-matching candidates. Resolve every asset, range, content hash, evidence reference, strength and handoff. `EXAMINADO` requires observed reads covering the asset; partial/unavailable files remain `NAO_VERIFICADO`.
6. A fresh validator session must reopen the evidence ranges and consider surrounding controls. Specialists cannot self-confirm or discard. Unsupported current-advisory, quantitative CVSS and legal certification claims cannot become verified conclusions.
7. Recheck target snapshot/revision before consolidation. A changed/unverifiable target invalidates current consolidation, downgrades conclusions, retains original results/review artifacts and requires a new stable run.
8. Render canonical totals from accepted verdicts only. Duplicates preserve original IDs/roles/evidence and reference a canonical finding. Potential/unvalidated/discarded/duplicate records never inflate confirmed totals. Free-form report-model prose is retained separately as `editorial-draft.json`, explicitly non-authoritative.

There is no project-wide numeric security grade. Reports do not certify security, legal compliance, absence of vulnerabilities, current CVE status or runtime behavior. Even a completed static run is not assurance.

### 4. ADRs

| Decision | Alternatives / negative trade-off | Reversal cost |
| --- | --- | --- |
| Fixed local coordinator + isolated SDK workers | Generic delegation is not sufficiently validated for this workflow; duplication of a small scheduler is accepted to avoid inheriting authority and failure semantics. | Replace the worker adapter only after equivalent capability, resume and cancellation tests pass. |
| Explicit resource loader and exact tool-name allowlist | Prompt-only read-only rules are insufficient. No agents files, skills, plugins, MCP, prompt discovery, shell or general file tools are inherited. Less convenience and intentionally incomplete dynamic coverage. | Add narrowly scoped adapters and authorization gates; never broaden the existing snapshot tools. |
| Unmodified upstream schemas + AJV 2020-12 | More runtime dependencies than a handcrafted partial schema interpreter, but supports local `$ref`, conditionals and the actual draft correctly. | A replacement must pass upstream examples plus semantic and conditional negative tests. |
| Atomic local checkpoints, not a new database | Simple deployment and no service dependency; private artifact storage/retention are operator responsibilities. Digests detect accidental corruption, not a malicious same-user actor rewriting files and hashes. | Migrate a versioned checkpoint envelope through an explicit adapter. |
| Approved resource copies with SHA-256 manifest | Some duplication, but no runtime sibling checkout, absolute development path or network download. Updates require explicit provenance review. | Replace the manifest/resources together and start new runs; incompatible resumes fail closed. |
| Static-only initial release | No runtime exploitability confirmation, external-advisory freshness, PDF renderer or remote publication. Honest partial results instead of fabricated assurance. | Future independent adapters need explicit config, boundary tests and corresponding evidence contracts. |

### 5. Rollout and evolution

The initial release stays disabled by default. Start with small controlled repositories, inspect evidence/coverage/usage, and tune explicit budgets. No automatic global enablement or promotion of experimental delegation occurs. Runtime testing, publication and additional renderers are future adapters, not silently accepted config switches.

## Snapshot and scope details

The immutable snapshot contains only bounded regular UTF-8 files. Binary/oversized/inaccessible files, symlinks/junctions, hard-linked files, nested repositories/submodules, credential locations and Git metadata are inventoried as omissions, not silently dropped or treated as irrelevant. Include/exclude patterns are relative POSIX globs. Snapshot traversal yields periodically and obeys cancellation/time/file/byte limits. File reads are bounded even if a file grows while being read.

Secret masking preserves line positions and raw-file hashes identify original evidence, not redacted strings. Masking is **heuristic**, not a guarantee. Do not authorize a model if your code/data cannot leave the host. Repository text, `AGENTS.md`, comments, manifests, tool output and specialist candidates are untrusted data, never authority to add tools, read credentials, execute code or change scope.

This is capability isolation inside a trusted Harness process, **not** an OS sandbox against malicious host extensions/providers or another process with the same filesystem privileges. Choose a private output root with appropriate OS ACLs; POSIX modes `0700`/`0600` are requested where supported. Do not mutate the target during an audit.

## Persistence, failures and retention

Each `audit-<uuid>` directory contains:

- `effective-config.json`, `resource-version.json`, `inventory.json`, discovery and threat-model artifacts;
- immutable accepted specialist/consultation results and independent review artifacts;
- versioned `checkpoint.json`, previous checkpoint, phase events, receipts and per-task/global budgets;
- `audit-run.json` using the upstream status vocabulary, plus internal cancellation/staleness metadata in checkpoints;
- `findings.json`, `strengths.json`, `coverage.json`, observed redacted evidence excerpts, `metrics.json`;
- authoritative `report.json` / `report.md`, non-authoritative editorial draft, optional local issue drafts;
- `artifact-manifest.json` with hashes of final local artifacts (excluding its own digest).

No raw model transcript or credential body is retained. Original accepted candidates are never silently rewritten by the validator; final decisions are separate records. Atomic same-directory writes, file fsync, exclusive locks and a previous valid checkpoint support process-crash recovery. Filesystem/power-loss durability still depends on the OS/filesystem.

Resume verifies config/resource/snapshot/revision identity, schema validity, source results, observed evidence references and budgets. Interrupted tasks become eligible again; completed compatible tasks are reused. Changing code, consent, model, routing, schemas or budget configuration requires a new run. Changed-during-run snapshots cannot be resumed. Interrupted/cancelled/malformed/failed tasks retain valid siblings and yield `PARTIAL`/`FAILED`, never false completion. Individual rendering failures retain successful formats and produce partial status. Final completion is determined by the terminal run/checkpoint and verified artifact manifest, not an intermediate draft file.

Token/cost accounting uses provider-reported usage; missing usable accounting fails the worker. Model output, tool calls, total output bytes, retries, handoffs, time and parallelism are bounded. Provider billing estimates and transport cancellation are **not transactional billing guarantees**; a single in-flight provider operation may finish before cancellation takes effect. Metrics are operational observations, not measured vulnerability precision.

Artifacts remain until the operator deletes the run directory. There is no automatic publication, retention job or cleanup of someone else's files. Review retained excerpts and set your own retention policy.

## Resource provenance and maintenance

The author explicitly authorized incorporating and redistributing `agents-skills/universal-audit-multiagent` resources under the Harness MIT license. The copied protocol is version `3.0`; `manifest.json` pins every approved file. Local `.gitattributes` preserves exact resource bytes across checkouts. Runtime paths use `getAuditResourcesPath()` -> existing engineering-resource lookup for source, npm and standalone bundles. No source-sibling path is used at runtime.

Check drift without changing anything:

```sh
node scripts/update-audit-resources.mjs --check
```

Explicitly update from an authorized source checkout, review changes and rerun contracts/tests:

```sh
node scripts/update-audit-resources.mjs /path/to/authorized/universal-audit-multiagent --authorized
```

The maintenance script is not part of runtime execution. Upstream docs may describe optional external tools; none are automatically loaded or executed by this integration.

## Verification and quality baseline

Offline test modules: `test/audit-boundaries.test.ts`, `audit-contracts.test.ts`, `audit-coordinator.test.ts`, `audit-runtime.test.ts`. Run with the repository's allowlisted environment and isolated home/config/cache/temp policy (as in `test.sh`), never a developer credential-inheriting model evaluation. Coverage includes all 20 routing entries/six roles, upstream schemas/examples, malicious paths/instructions, scope/identity/hash/range/coverage poisoning, independent confirmation and protected-route false positives, malformed output, cancellation, budgets, immutable candidates, consultations, resume and partial rendering. Real SDK sessions use the faux provider, not network API keys.

Packaging gates (from the Harness repository root):

```sh
npm run build:offline
npm run check
npm run check:package-install
node --test scripts/audit-standalone.test.mjs
```

The consumer gate verifies installed npm resources/schemas/prompts. The standalone test compiles and executes a real Bun binary beside copied resources, with a private home and no provider credentials; it skips only when Bun is unavailable.

Synthetic fixtures measure confirmed true positives/false positives, coverage denominators, observed usage and completed-task reuse. They verify harness controls, **not** real-model security accuracy. No remote-model precision claim is made; a future opt-in live evaluation needs explicitly authorized credentials, fixed ground truth and separate results.

| Baseline | Control / evidence |
| --- | --- |
| Input validation | Strict preflight; upstream JSON Schema 2020-12 plus semantic/ref/coverage gates. |
| Error handling | Bounded correction, partial siblings, crash-safe checkpoints, per-format failure handling. |
| Tests | Boundary/contract/coordinator/native-SDK offline regression modules. |
| Configuration | Disabled default, explicit model and working-tree consent, no hardcoded provider IDs or source paths. |
| Security | Snapshot-only tools, no general execution/write/network/delegation tools, no inherited discovery. |
| Observability | Local phase events, accepted/rejected task artifacts, budgets, metrics and integrity manifest; no raw transcript logs. |

Primary attack regression: an untrusted repository asks the worker to execute `bash`, read `../../credentials`, or use auto-loaded `AGENTS.md`. The exact tool allowlist, non-discovering loader and snapshot path resolver reject those attempts; see `audit-runtime.test.ts`. Other trust boundaries (provider transport/auth and host extensions) remain owned by the existing host; this feature adds no web service, cookies, sessions, SQL endpoints, CORS or CSRF surface.
