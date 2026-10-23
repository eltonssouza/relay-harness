# Native memory

Relay can keep durable memory across sessions: facts and decisions, a temporal knowledge graph and an evolving user profile. It is opt-in. Start Relay with `--native-memory` or set `RELAY_NATIVE_MEMORY=1`. When it is off, Relay registers only the flag and leaves the existing memory paths ([graph memory](project-memory.md), [logbook](logbook.md)) unchanged. To roll back, turn the flag off. The database stays on disk.

## Storage

Memory lives in one local SQLite database at `~/.relay/agent/memory/memory.db`, or under `RELAY_CODING_AGENT_DIR` when that is set. It uses Node's built-in `node:sqlite`, so no new dependency is needed. The file is created with owner-only permissions where the platform supports them. Schema changes are versioned migrations, and Relay refuses to open a database written by a newer version.

Every memory, relation and profile attribute records its source: a session and tool call, a logbook note or a user statement. Records are partitioned by tenant and owner (`local` and the OS user), and memories are scoped:

| Scope | Visible to |
| --- | --- |
| `user` | The owner, in any project |
| `project` | The owner, in the same repository |
| `agent` | The owner, for the same agent |
| `shared` | Everyone in the tenant (only the owner can delete) |

## How the agent uses it

Before each request, Relay adds a `native_memory` section to the system prompt. It contains three parts:

- The relevant profile.
- Memories found by hybrid search: SQLite FTS5 plus optional vectors, fused with reciprocal-rank fusion and weighted by confidence, importance, status and age.
- Current relations of the entities the request mentions.

The section is capped at about 1,200 tokens. Every item is quoted and labelled with its scope, status, date and source. The section tells the model that memory is evidence, not instructions. Unconfirmed items are marked, and text that looks like instructions is labelled as data.

Tools:

- `memory_remember`: stores a memory. Statements the user made become `active`. Things the agent infers become `candidate` until the user states them. Identical content is deduplicated, and the new source is attached to the existing record. `supersedes` replaces a memory but keeps the old one as history.
- `memory_search`: hybrid search with sources. `includeHistory` also returns superseded memories.
- `memory_forget` (deferred): deletes a memory and its search index, vectors, graph relations and profile evidence.
- `memory_relate` (deferred): records relations such as `Relay USES PostgreSQL`, aliases (`Postgres` for `PostgreSQL`) and replacements over time (`previous: MySQL`). Relations that are no longer current stay as history. `DEPENDS_ON` and `REPLACED_BY` reject cycles.
- `memory_graph_query` (deferred): lists the current relations of an entity. `includeHistory` adds ended relations. With `to`, it finds the shortest path of up to three hops between two entities.
- `memory_profile` (deferred): records preferences as `declared` (the user said it) or `observed` (the agent noticed it). An observation never overrides a declared or confirmed value. A preference can be limited to a situation such as `code-review`; within that situation, the specific value wins.

## Commands

`/memory` manages the engine:

| Command | Effect |
| --- | --- |
| `/memory status` | Counts, pending and failed jobs, embedding model |
| `/memory search <query>` | Search memories |
| `/memory forget <id>` | Delete a memory; an id prefix is accepted |
| `/memory profile` | Show the current profile |
| `/memory revoke <key>` | Revoke a profile attribute |
| `/memory boundary <topic>` | Never store or infer the topic; revokes matching attributes |
| `/memory import-logbook` | Import `/logbook note` entries as project memories (trusted projects; idempotent; the logbook is not changed) |
| `/memory reindex` | Rebuild the lexical index and queue missing embeddings |
| `/memory gc` | Expire temporary attributes and purge deletions older than 30 days |
| `/memory jobs` | List pending and dead-letter jobs |
| `/memory export <file>` | Write all of your memories, relations and profile with sources as JSON |
| `/memory backup <file>` | Write a consistent copy of the database |

## Semantic search

Without configuration, search is lexical only, which works fully offline. To add semantic search, configure an embedding model:

| Variable | Purpose |
| --- | --- |
| `RELAY_MEMORY_EMBEDDING_MODEL` | Embedding model name, e.g. `nomic-embed-text`. Enables vectors. |
| `RELAY_MEMORY_EMBEDDING_API` | `ollama` (default, `POST /api/embed`) or `openai` (`POST /embeddings`) |
| `RELAY_MEMORY_EMBEDDING_URL` | Base URL; defaults to `http://127.0.0.1:11434` or `https://api.openai.com/v1` |
| `RELAY_MEMORY_EMBEDDING_API_KEY` | Bearer key for OpenAI-compatible endpoints |

Embeddings are computed after a write, through a persistent job queue. Jobs are idempotent, retry with exponential backoff and move to a dead-letter state after five failures. Jobs left running by a crashed process are re-queued when the next session starts. Each vector stores its model, and vectors from another model are never compared. Run `/memory reindex` after you change models. If the embedding service is down, search falls back to lexical results.

When you configure a remote endpoint, the content of each memory and each request is sent to that service to compute vectors.

## Safety and limits

- Common secret formats (bearer tokens, `sk-` keys, GitHub and AWS keys, private keys, `password=` assignments) are masked before storage. Review what you ask Relay to remember.
- Deleted memories lose their content immediately. Their tombstones are purged by `/memory gc`.
- Vector ranking is an exact cosine scan in the scoped partition. It suits personal-scale memory, from thousands to tens of thousands of records. The repository interfaces in `src/core/memory/types.ts` keep SQLite behind an adapter, so a server database could replace it.
- The database is not encrypted at rest. It relies on file permissions and the OS account. Use disk encryption if you need more.
- To restore a backup, use `restoreMemoryStore(backup, target)` while Relay is stopped. It checks the schema version and integrity first.
