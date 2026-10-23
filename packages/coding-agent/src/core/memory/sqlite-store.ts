import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { defaultMemoryPolicy, normalizeText } from "./policy.ts";
import type {
	EmbeddingProvider,
	GraphEdge,
	GraphNode,
	GraphRepository,
	MemoryKind,
	MemoryPolicy,
	MemoryPrincipal,
	MemoryRecord,
	MemoryRepository,
	MemoryScope,
	MemorySource,
	MemoryStatus,
	ProfileAttribute,
	ProfileInput,
	ProfileState,
	RelateInput,
	RelationType,
	RememberInput,
	RememberResult,
	SearchHit,
	SearchOptions,
	SourceInput,
	UserModelRepository,
} from "./types.ts";

export const MEMORY_SCHEMA_VERSION = 1;

/**
 * Schema v1. Every table carries tenant and owner so isolation is enforced in SQL, not only in code.
 * Graph edges and profile attributes reference a source row (NOT NULL), which makes provenance mandatory.
 */
const SCHEMA_V1 = `
CREATE TABLE memory_sources (
	id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL,
	kind TEXT NOT NULL, reference TEXT NOT NULL, excerpt TEXT, created_at INTEGER NOT NULL,
	UNIQUE (tenant_id, owner_id, kind, reference)
);
CREATE TABLE memories (
	id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, scope TEXT NOT NULL,
	project_id TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
	content TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL,
	confidence REAL NOT NULL, importance REAL NOT NULL, flagged INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, valid_from INTEGER, valid_until INTEGER,
	version INTEGER NOT NULL DEFAULT 1, superseded_by TEXT
);
CREATE INDEX memories_owner ON memories (tenant_id, owner_id, scope, status);
CREATE UNIQUE INDEX memories_dedupe ON memories (tenant_id, owner_id, scope, project_id, agent_id, content_hash)
	WHERE status IN ('candidate', 'active', 'disputed');
CREATE TABLE memory_source_links (
	memory_id TEXT NOT NULL REFERENCES memories(id), source_id TEXT NOT NULL REFERENCES memory_sources(id),
	PRIMARY KEY (memory_id, source_id)
);
CREATE VIRTUAL TABLE memory_fts USING fts5(content, memory_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE memory_embeddings (
	memory_id TEXT NOT NULL REFERENCES memories(id), model TEXT NOT NULL, dimensions INTEGER NOT NULL,
	vector BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (memory_id, model)
);
CREATE TABLE graph_nodes (
	id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, scope TEXT NOT NULL,
	project_id TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, normalized TEXT NOT NULL, type TEXT NOT NULL,
	UNIQUE (tenant_id, owner_id, scope, project_id, normalized)
);
CREATE TABLE graph_aliases (
	node_id TEXT NOT NULL REFERENCES graph_nodes(id), alias TEXT NOT NULL, normalized TEXT NOT NULL,
	PRIMARY KEY (node_id, normalized)
);
CREATE INDEX graph_aliases_normalized ON graph_aliases (normalized);
CREATE TABLE graph_edges (
	id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES graph_nodes(id), type TEXT NOT NULL,
	to_id TEXT NOT NULL REFERENCES graph_nodes(id), source_id TEXT NOT NULL REFERENCES memory_sources(id),
	confidence REAL NOT NULL, valid_from INTEGER NOT NULL, valid_until INTEGER
);
CREATE INDEX graph_edges_from ON graph_edges (from_id, valid_until);
CREATE INDEX graph_edges_to ON graph_edges (to_id, valid_until);
CREATE TABLE profile_attributes (
	id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
	context TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES memory_sources(id),
	created_at INTEGER NOT NULL, expires_at INTEGER, ended_at INTEGER
);
CREATE INDEX profile_current ON profile_attributes (tenant_id, owner_id, key, ended_at);
CREATE TABLE profile_boundaries (
	tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, topic TEXT NOT NULL, created_at INTEGER NOT NULL,
	PRIMARY KEY (tenant_id, owner_id, topic)
);
CREATE TABLE memory_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL,
	type TEXT NOT NULL, subject_id TEXT, details TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE memory_jobs (
	id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
	run_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX memory_jobs_ready ON memory_jobs (status, run_at);
`;

const READABLE_STATUSES: MemoryStatus[] = ["active", "candidate", "disputed"];
const HISTORY_STATUSES: MemoryStatus[] = [...READABLE_STATUSES, "superseded", "archived"];
const STATUS_WEIGHT: Record<MemoryStatus, number> = {
	active: 1,
	disputed: 0.5,
	candidate: 0.6,
	superseded: 0.3,
	archived: 0.3,
	deleted: 0,
};
const STOPWORDS = new Set(
	"a o as os e de da do das dos um uma para por com sem que qual quais como no na nos nas em ao the of and or to in on for with what which how is are was we our".split(
		" ",
	),
);
const RRF_K = 60;
const DEFAULT_MIN_SIMILARITY = 0.3;
const ACYCLIC: RelationType[] = ["DEPENDS_ON", "REPLACED_BY"];

export interface MemoryStoreOptions {
	path: string;
	embeddings?: EmbeddingProvider;
	policy?: MemoryPolicy;
	now?: () => number;
	/** Cosine similarity below which a vector match is ignored. Default 0.3. */
	minSimilarity?: number;
}

export interface MemoryJob {
	id: string;
	type: string;
	payload: Record<string, unknown>;
	attempts: number;
}

export type JobHandler = (job: MemoryJob) => Promise<void>;

type Row = Record<string, SQLInputValue>;

function hash(text: string): string {
	return createHash("sha256").update(normalizeText(text)).digest("hex");
}

function cosine(a: Float32Array, b: number[] | Float32Array): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function date(value: SQLInputValue): Date | undefined {
	return typeof value === "number" ? new Date(value) : undefined;
}

/** Local memory engine on Node's built-in SQLite: FTS5 for lexical search, stored vectors for semantics. */
export class SqliteMemoryStore implements MemoryRepository, GraphRepository, UserModelRepository {
	readonly db: DatabaseSync;
	readonly embeddings?: EmbeddingProvider;
	private readonly policy: MemoryPolicy;
	private readonly now: () => number;
	private readonly minSimilarity: number;

	constructor(options: MemoryStoreOptions) {
		if (options.path !== ":memory:") {
			mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
		}
		this.db = new DatabaseSync(options.path);
		if (options.path !== ":memory:") {
			try {
				chmodSync(options.path, 0o600);
			} catch {}
		}
		this.embeddings = options.embeddings;
		this.policy = options.policy ?? defaultMemoryPolicy;
		this.now = options.now ?? Date.now;
		this.minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
		// secure_delete overwrites freed pages, so forgotten content does not linger in the file.
		this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
		try {
			if (options.path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
			this.migrate();
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	close(): void {
		if (this.db.isOpen) this.db.close();
	}

	/** Applies pending migrations; refuses databases written by a newer schema instead of corrupting them. */
	private migrate(): void {
		const current = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
		if (current > MEMORY_SCHEMA_VERSION)
			throw new Error(`Memory database schema ${current} is newer than supported ${MEMORY_SCHEMA_VERSION}.`);
		if (current === MEMORY_SCHEMA_VERSION) return;
		this.transaction(() => {
			if (current < 1) this.db.exec(SCHEMA_V1);
			this.db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`);
		});
	}

	schemaVersion(): number {
		return Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
	}

	private transaction<T>(fn: () => T): T {
		if (this.db.isTransaction) return fn();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private event(
		principal: MemoryPrincipal,
		type: string,
		subjectId?: string,
		details?: Record<string, unknown>,
	): void {
		this.db
			.prepare(
				"INSERT INTO memory_events (tenant_id, owner_id, type, subject_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				principal.tenantId,
				principal.ownerId,
				type,
				subjectId ?? null,
				details ? JSON.stringify(details) : null,
				this.now(),
			);
	}

	/** Source rows are idempotent per reference, so replaying the same session entry reuses provenance. */
	private source(principal: MemoryPrincipal, input: SourceInput): string {
		if (!input.reference.trim()) throw new Error("Memory provenance requires a source reference.");
		const existing = this.db
			.prepare("SELECT id FROM memory_sources WHERE tenant_id = ? AND owner_id = ? AND kind = ? AND reference = ?")
			.get(principal.tenantId, principal.ownerId, input.kind, input.reference) as Row | undefined;
		if (existing) return String(existing.id);
		const id = randomUUID();
		const excerpt = input.excerpt ? this.policy.sanitize(input.excerpt).text.slice(0, 500) : null;
		this.db
			.prepare(
				"INSERT INTO memory_sources (id, tenant_id, owner_id, kind, reference, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(id, principal.tenantId, principal.ownerId, input.kind, input.reference, excerpt, this.now());
		return id;
	}

	private partition(principal: MemoryPrincipal, scope: MemoryScope): { projectId: string; agentId: string } {
		if (scope === "project" && !principal.projectId) throw new Error("Project memory requires a project.");
		if (scope === "agent" && !principal.agentId) throw new Error("Agent memory requires an agent.");
		return {
			projectId: scope === "project" ? (principal.projectId ?? "") : "",
			agentId: scope === "agent" ? (principal.agentId ?? "") : "",
		};
	}

	/** SQL visibility predicate mirroring MemoryPolicy.canRead; `m` is the aliased table. */
	private visible(principal: MemoryPrincipal, alias: string): { sql: string; params: SQLInputValue[] } {
		return {
			sql: `${alias}.tenant_id = ? AND (${alias}.scope = 'shared' OR (${alias}.owner_id = ? AND (${alias}.scope = 'user' OR (${alias}.scope = 'project' AND ${alias}.project_id = ?) OR (${alias}.scope = 'agent' AND ${alias}.agent_id = ?))))`,
			params: [
				principal.tenantId,
				principal.ownerId,
				principal.projectId ?? "\u0000",
				principal.agentId ?? "\u0000",
			],
		};
	}

	private toRecord(row: Row): MemoryRecord {
		const sourceIds = (
			this.db.prepare("SELECT source_id FROM memory_source_links WHERE memory_id = ?").all(row.id as string) as Row[]
		).map((link) => String(link.source_id));
		return {
			id: String(row.id),
			tenantId: String(row.tenant_id),
			ownerId: String(row.owner_id),
			scope: row.scope as MemoryScope,
			projectId: row.project_id ? String(row.project_id) : undefined,
			agentId: row.agent_id ? String(row.agent_id) : undefined,
			kind: row.kind as MemoryKind,
			content: String(row.content),
			status: row.status as MemoryStatus,
			confidence: Number(row.confidence),
			importance: Number(row.importance),
			sourceIds,
			createdAt: new Date(Number(row.created_at)),
			updatedAt: new Date(Number(row.updated_at)),
			validFrom: date(row.valid_from),
			validUntil: date(row.valid_until),
			version: Number(row.version),
			flagged: row.flagged === 1,
		};
	}

	sources(ids: string[]): MemorySource[] {
		if (ids.length === 0) return [];
		return (
			this.db
				.prepare(`SELECT * FROM memory_sources WHERE id IN (${ids.map(() => "?").join(",")})`)
				.all(...ids) as Row[]
		).map((row) => ({
			id: String(row.id),
			kind: row.kind as MemorySource["kind"],
			reference: String(row.reference),
			excerpt: row.excerpt ? String(row.excerpt) : undefined,
			createdAt: new Date(Number(row.created_at)),
		}));
	}

	private boundaryHit(principal: MemoryPrincipal, text: string): string | undefined {
		const normalized = ` ${normalizeText(text)} `;
		const topics = this.db
			.prepare("SELECT topic FROM profile_boundaries WHERE tenant_id = ? AND owner_id = ?")
			.all(principal.tenantId, principal.ownerId) as Row[];
		return topics.map((row) => String(row.topic)).find((topic) => normalized.includes(` ${topic} `));
	}

	async remember(principal: MemoryPrincipal, input: RememberInput): Promise<RememberResult> {
		const result = this.rememberSync(principal, input);
		if (result.created && this.embeddings)
			this.enqueue("embed", { memoryId: result.record.id }, `embed:${result.record.id}:${this.embeddings.model}`);
		return result;
	}

	private rememberSync(principal: MemoryPrincipal, input: RememberInput): RememberResult {
		const sanitized = this.policy.sanitize(input.content);
		if (!sanitized.text) throw new Error("Memory content is empty.");
		const boundary = this.boundaryHit(principal, sanitized.text);
		if (boundary) throw new Error(`The user asked not to store information about "${boundary}".`);
		const { projectId, agentId } = this.partition(principal, input.scope);
		const contentHash = hash(sanitized.text);
		return this.transaction(() => {
			const sourceId = this.source(principal, input.source);
			const existing = this.db
				.prepare(
					`SELECT * FROM memories WHERE tenant_id = ? AND owner_id = ? AND scope = ? AND project_id = ? AND agent_id = ? AND content_hash = ? AND status IN ('candidate', 'active', 'disputed')`,
				)
				.get(principal.tenantId, principal.ownerId, input.scope, projectId, agentId, contentHash) as
				| Row
				| undefined;
			if (existing) {
				this.db
					.prepare("INSERT OR IGNORE INTO memory_source_links (memory_id, source_id) VALUES (?, ?)")
					.run(existing.id as string, sourceId);
				// A user statement confirms an agent candidate; agent repetition never promotes itself.
				if (existing.status === "candidate" && input.source.kind === "user") {
					this.db
						.prepare("UPDATE memories SET status = 'active', updated_at = ?, version = version + 1 WHERE id = ?")
						.run(this.now(), existing.id as string);
				}
				this.event(principal, "memory.deduplicated", String(existing.id));
				return { record: this.toRecord(this.rowById(String(existing.id))), created: false };
			}
			const id = randomUUID();
			const now = this.now();
			const status =
				input.status ?? (input.source.kind === "user" || input.source.kind === "import" ? "active" : "candidate");
			this.db
				.prepare(
					`INSERT INTO memories (id, tenant_id, owner_id, scope, project_id, agent_id, kind, content, content_hash, status,
					confidence, importance, flagged, created_at, updated_at, valid_from, valid_until)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					principal.tenantId,
					principal.ownerId,
					input.scope,
					projectId,
					agentId,
					input.kind,
					sanitized.text,
					contentHash,
					status,
					Math.min(1, Math.max(0, input.confidence ?? (input.source.kind === "user" ? 0.9 : 0.6))),
					Math.min(1, Math.max(0, input.importance ?? 0.5)),
					sanitized.flagged ? 1 : 0,
					now,
					now,
					input.validFrom?.getTime() ?? now,
					input.validUntil?.getTime() ?? null,
				);
			this.db.prepare("INSERT INTO memory_source_links (memory_id, source_id) VALUES (?, ?)").run(id, sourceId);
			this.db.prepare("INSERT INTO memory_fts (content, memory_id) VALUES (?, ?)").run(sanitized.text, id);
			if (input.supersedes) this.supersede(principal, input.supersedes, id);
			this.event(principal, "memory.created", id, {
				scope: input.scope,
				kind: input.kind,
				redacted: sanitized.redacted,
			});
			return { record: this.toRecord(this.rowById(id)), created: true };
		});
	}

	/** Temporal replacement: the old memory stays queryable as history, never as current truth. */
	private supersede(principal: MemoryPrincipal, oldId: string, newId: string): void {
		const old = this.get(principal, oldId);
		if (!old || old.ownerId !== principal.ownerId) throw new Error(`Memory ${oldId} is not available to supersede.`);
		const now = this.now();
		this.db
			.prepare(
				"UPDATE memories SET status = 'superseded', superseded_by = ?, valid_until = ?, updated_at = ?, version = version + 1 WHERE id = ?",
			)
			.run(newId, now, now, oldId);
		this.event(principal, "memory.superseded", oldId, { by: newId });
	}

	private rowById(id: string): Row {
		return this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row;
	}

	get(principal: MemoryPrincipal, id: string): MemoryRecord | undefined {
		const row = this.db.prepare("SELECT * FROM memories WHERE id = ? AND status != 'deleted'").get(id) as
			| Row
			| undefined;
		if (!row) return undefined;
		const record = this.toRecord(row);
		return this.policy.canRead(principal, record) ? record : undefined;
	}

	list(principal: MemoryPrincipal, options: SearchOptions = {}): MemoryRecord[] {
		const filter = this.visible(principal, "m");
		const statuses = options.includeHistory ? HISTORY_STATUSES : READABLE_STATUSES;
		return (
			this.db
				.prepare(
					`SELECT * FROM memories m WHERE ${filter.sql} AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT ?`,
				)
				.all(...filter.params, ...statuses, options.limit ?? 1000) as Row[]
		)
			.map((row) => this.toRecord(row))
			.filter((record) => this.matches(principal, record, options));
	}

	private matches(principal: MemoryPrincipal, record: MemoryRecord, options: SearchOptions): boolean {
		if (!this.policy.canRead(principal, record)) return false;
		if (options.scopes && !options.scopes.includes(record.scope)) return false;
		if (options.kinds && !options.kinds.includes(record.kind)) return false;
		if (!options.includeHistory && record.validUntil && record.validUntil.getTime() <= this.now()) return false;
		return true;
	}

	/** Hybrid retrieval: FTS5 and vector rankings fused with RRF, then weighted by trust and recency. */
	async search(principal: MemoryPrincipal, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
		const limit = options.limit ?? 10;
		const statuses = options.includeHistory ? HISTORY_STATUSES : READABLE_STATUSES;
		const filter = this.visible(principal, "m");
		const statusSql = `m.status IN (${statuses.map(() => "?").join(",")})`;
		const fused = new Map<string, { row: Row; score: number; matchedBy: Set<"lexical" | "semantic"> }>();
		const add = (row: Row, rank: number, by: "lexical" | "semantic") => {
			const entry = fused.get(String(row.id)) ?? { row, score: 0, matchedBy: new Set() };
			entry.score += 1 / (RRF_K + rank);
			entry.matchedBy.add(by);
			fused.set(String(row.id), entry);
		};

		const terms = [...new Set(normalizeText(query).split(" "))].filter((t) => t.length > 1 && !STOPWORDS.has(t));
		if (terms.length > 0) {
			const match = terms.map((term) => `"${term}"*`).join(" OR ");
			const rows = this.db
				.prepare(
					`SELECT m.* FROM memory_fts f JOIN memories m ON m.id = f.memory_id
					WHERE memory_fts MATCH ? AND ${filter.sql} AND ${statusSql} ORDER BY bm25(memory_fts) LIMIT 50`,
				)
				.all(match, ...filter.params, ...statuses) as Row[];
			rows.forEach((row, index) => {
				add(row, index + 1, "lexical");
			});
		}

		if (this.embeddings && query.trim()) {
			try {
				const [vector] = await this.embeddings.embed([query]);
				const rows = this.db
					.prepare(
						`SELECT m.*, e.vector AS vector FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
						WHERE e.model = ? AND e.dimensions = ? AND ${filter.sql} AND ${statusSql}`,
					)
					.all(this.embeddings.model, vector.length, ...filter.params, ...statuses) as Row[];
				rows
					.map((row) => {
						const bytes = row.vector as Uint8Array;
						const stored = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
						return { row, similarity: cosine(stored, vector) };
					})
					.filter((item) => item.similarity >= this.minSimilarity)
					.sort((a, b) => b.similarity - a.similarity)
					.slice(0, 50)
					.forEach((item, index) => {
						add(item.row, index + 1, "semantic");
					});
			} catch (error) {
				// Lexical results remain usable when the embedding model is down.
				this.event(principal, "memory.search.semantic_unavailable", undefined, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const now = this.now();
		return [...fused.values()]
			.map(({ row, score, matchedBy }) => {
				const record = this.toRecord(row);
				const ageDays = (now - record.updatedAt.getTime()) / 86_400_000;
				const weight =
					(0.5 + 0.5 * record.confidence) *
					(0.75 + 0.25 * record.importance) *
					STATUS_WEIGHT[record.status] *
					(0.8 + 0.2 * Math.exp(-Math.max(0, ageDays) / 180));
				return { record, score: score * weight, matchedBy: [...matchedBy], sources: [] as MemorySource[] };
			})
			.filter((hit) => this.matches(principal, hit.record, options))
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((hit) => ({ ...hit, sources: this.sources(hit.record.sourceIds) }));
	}

	/** Deletion scrubs content and removes every derived projection: FTS, vectors, edges and profile evidence. */
	forget(principal: MemoryPrincipal, id: string, reason: string): boolean {
		const record = this.get(principal, id);
		// Only the owner may delete, including their shared memories.
		if (!record || record.ownerId !== principal.ownerId) return false;
		this.transaction(() => {
			const now = this.now();
			this.db
				.prepare(
					"UPDATE memories SET status = 'deleted', content = '', content_hash = ?, updated_at = ?, version = version + 1 WHERE id = ?",
				)
				.run(`deleted:${id}`, now, id);
			this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(id);
			this.db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
			for (const sourceId of record.sourceIds) {
				const shared = this.db
					.prepare(
						"SELECT 1 FROM memory_source_links l JOIN memories m ON m.id = l.memory_id WHERE l.source_id = ? AND m.status != 'deleted' LIMIT 1",
					)
					.get(sourceId);
				if (shared) continue;
				this.db.prepare("DELETE FROM graph_edges WHERE source_id = ?").run(sourceId);
				this.db.prepare("DELETE FROM profile_attributes WHERE source_id = ?").run(sourceId);
				this.db.prepare("UPDATE memory_sources SET excerpt = NULL WHERE id = ?").run(sourceId);
			}
			this.db.prepare("DELETE FROM memory_jobs WHERE idempotency_key LIKE ?").run(`embed:${id}:%`);
			this.event(principal, "memory.deleted", id, { reason: reason.slice(0, 200) });
		});
		return true;
	}

	/** Marks a memory as contradicted without deleting it, so the conflict stays visible. */
	dispute(principal: MemoryPrincipal, id: string): boolean {
		const record = this.get(principal, id);
		if (!record || record.ownerId !== principal.ownerId) return false;
		this.db
			.prepare("UPDATE memories SET status = 'disputed', updated_at = ?, version = version + 1 WHERE id = ?")
			.run(this.now(), id);
		this.event(principal, "memory.disputed", id);
		return true;
	}

	// ---------------------------------------------------------------- embeddings and reindexing

	private async embedMemory(memoryId: string): Promise<void> {
		if (!this.embeddings) return;
		const row = this.db.prepare("SELECT content, status FROM memories WHERE id = ?").get(memoryId) as Row | undefined;
		if (!row || row.status === "deleted") return;
		const [vector] = await this.embeddings.embed([String(row.content)]);
		if (!vector?.length) throw new Error("Embedding provider returned an empty vector.");
		const still = this.db.prepare("SELECT status FROM memories WHERE id = ?").get(memoryId) as Row | undefined;
		if (!still || still.status === "deleted") return;
		const bytes = new Uint8Array(Float32Array.from(vector).buffer);
		this.db
			.prepare(
				"INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dimensions, vector, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(memoryId, this.embeddings.model, vector.length, bytes, this.now());
	}

	/** Queues embeddings for memories without a vector of the current model (new model or recovered data). */
	reindex(): number {
		if (!this.embeddings) return 0;
		const rows = this.db
			.prepare(
				`SELECT id FROM memories m WHERE status != 'deleted' AND NOT EXISTS
				(SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model = ?)`,
			)
			.all(this.embeddings.model) as Row[];
		this.db.prepare("DELETE FROM memory_fts").run();
		this.db.exec(
			"INSERT INTO memory_fts (content, memory_id) SELECT content, id FROM memories WHERE status != 'deleted'",
		);
		for (const row of rows) this.enqueue("embed", { memoryId: row.id }, `embed:${row.id}:${this.embeddings.model}`);
		return rows.length;
	}

	// ---------------------------------------------------------------- persistent queue

	/** Idempotent enqueue: the same key never creates a second job. */
	enqueue(type: string, payload: Record<string, unknown>, idempotencyKey: string, maxAttempts = 5): void {
		const now = this.now();
		this.db
			.prepare(
				`INSERT INTO memory_jobs (id, type, payload, idempotency_key, status, max_attempts, run_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`,
			)
			.run(randomUUID(), type, JSON.stringify(payload), idempotencyKey, maxAttempts, now, now, now);
	}

	/**
	 * Runs ready jobs. Failures retry with exponential backoff; after `max_attempts` the job moves to
	 * `dead` (dead-letter) and stays inspectable. Claiming is a conditional update, so two workers on
	 * the same database never run one job twice.
	 */
	async processJobs(handlers: Record<string, JobHandler> = {}, limit = 50): Promise<{ done: number; failed: number }> {
		const all: Record<string, JobHandler> = {
			embed: (job) => this.embedMemory(String(job.payload.memoryId)),
			...handlers,
		};
		let done = 0;
		let failed = 0;
		for (let i = 0; i < limit; i++) {
			const now = this.now();
			const row = this.db
				.prepare("SELECT * FROM memory_jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 1")
				.get(now) as Row | undefined;
			if (!row) break;
			const claimed = this.db
				.prepare(
					"UPDATE memory_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
				)
				.run(now, row.id as string);
			if (claimed.changes !== 1) continue;
			const job: MemoryJob = {
				id: String(row.id),
				type: String(row.type),
				payload: JSON.parse(String(row.payload)),
				attempts: Number(row.attempts) + 1,
			};
			try {
				const handler = all[job.type];
				if (!handler) throw new Error(`No handler for memory job ${job.type}.`);
				await handler(job);
				this.db
					.prepare("UPDATE memory_jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?")
					.run(this.now(), job.id);
				done++;
			} catch (error) {
				failed++;
				const dead = job.attempts >= Number(row.max_attempts);
				const delay = Math.min(3_600_000, 1000 * 2 ** (job.attempts - 1));
				this.db
					.prepare("UPDATE memory_jobs SET status = ?, run_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
					.run(
						dead ? "dead" : "pending",
						this.now() + delay,
						(error instanceof Error ? error.message : String(error)).slice(0, 500),
						this.now(),
						job.id,
					);
			}
		}
		return { done, failed };
	}

	/** Returns jobs stuck in `running` (crashed worker) to the queue. */
	recoverStaleJobs(olderThanMs = 600_000): number {
		return Number(
			this.db
				.prepare(
					"UPDATE memory_jobs SET status = 'pending', updated_at = ? WHERE status = 'running' AND updated_at < ?",
				)
				.run(this.now(), this.now() - olderThanMs).changes,
		);
	}

	jobs(status?: string): Array<{ id: string; type: string; status: string; attempts: number; lastError?: string }> {
		const rows = (
			status
				? this.db.prepare("SELECT * FROM memory_jobs WHERE status = ? ORDER BY created_at").all(status)
				: this.db.prepare("SELECT * FROM memory_jobs ORDER BY created_at").all()
		) as Row[];
		return rows.map((row) => ({
			id: String(row.id),
			type: String(row.type),
			status: String(row.status),
			attempts: Number(row.attempts),
			lastError: row.last_error ? String(row.last_error) : undefined,
		}));
	}

	// ---------------------------------------------------------------- knowledge graph

	private graphScope(principal: MemoryPrincipal, scope?: MemoryScope): { scope: MemoryScope; projectId: string } {
		const chosen = scope ?? (principal.projectId ? "project" : "user");
		if (chosen === "agent") throw new Error("Graph relations support user, project and shared scopes.");
		return { scope: chosen, projectId: this.partition(principal, chosen).projectId };
	}

	/** Entity resolution: a name matches an existing node by canonical name or alias before a node is created. */
	private findNode(principal: MemoryPrincipal, name: string): Row | undefined {
		const normalized = normalizeText(name);
		const filter = this.visible(principal, "n");
		return this.db
			.prepare(
				`SELECT n.* FROM graph_nodes n WHERE ${filter.sql} AND (n.normalized = ? OR EXISTS
				(SELECT 1 FROM graph_aliases a WHERE a.node_id = n.id AND a.normalized = ?))
				ORDER BY CASE n.scope WHEN 'project' THEN 0 WHEN 'user' THEN 1 ELSE 2 END LIMIT 1`,
			)
			.get(...filter.params, normalized, normalized) as Row | undefined;
	}

	private ensureNode(principal: MemoryPrincipal, entity: { name: string; type?: string }, scope?: MemoryScope): Row {
		const name = this.policy.sanitize(entity.name).text.slice(0, 200);
		if (!normalizeText(name)) throw new Error("Graph entities need a name.");
		const found = this.findNode(principal, name);
		if (found) return found;
		const target = this.graphScope(principal, scope);
		const id = randomUUID();
		this.db
			.prepare(
				"INSERT INTO graph_nodes (id, tenant_id, owner_id, scope, project_id, name, normalized, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				principal.tenantId,
				principal.ownerId,
				target.scope,
				target.projectId,
				name,
				normalizeText(name),
				entity.type ?? "entity",
			);
		return this.db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(id) as Row;
	}

	private toNode(row: Row): GraphNode {
		const aliases = (
			this.db.prepare("SELECT alias FROM graph_aliases WHERE node_id = ?").all(row.id as string) as Row[]
		).map((alias) => String(alias.alias));
		return { id: String(row.id), name: String(row.name), type: String(row.type), aliases };
	}

	private toEdge(row: Row): GraphEdge {
		const node = (id: SQLInputValue) =>
			this.toNode(this.db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(id as string) as Row);
		return {
			id: String(row.id),
			from: node(row.from_id),
			type: row.type as RelationType,
			to: node(row.to_id),
			sourceId: String(row.source_id),
			validFrom: new Date(Number(row.valid_from)),
			validUntil: date(row.valid_until),
			confidence: Number(row.confidence),
		};
	}

	addAlias(principal: MemoryPrincipal, name: string, alias: string): GraphNode {
		return this.transaction(() => {
			const node = this.ensureNode(principal, { name });
			const clash = this.findNode(principal, alias);
			if (clash && clash.id !== node.id) throw new Error(`"${alias}" already names another entity (${clash.name}).`);
			this.db
				.prepare("INSERT OR IGNORE INTO graph_aliases (node_id, alias, normalized) VALUES (?, ?, ?)")
				.run(node.id as string, alias, normalizeText(alias));
			return this.toNode(node);
		});
	}

	relate(principal: MemoryPrincipal, input: RelateInput): GraphEdge {
		return this.transaction(() => {
			const from = this.ensureNode(principal, input.from, input.scope);
			const to = this.ensureNode(principal, input.to, input.scope);
			if (from.id === to.id) throw new Error("A relation needs two different entities.");
			const current = this.db
				.prepare("SELECT * FROM graph_edges WHERE from_id = ? AND type = ? AND to_id = ? AND valid_until IS NULL")
				.get(from.id as string, input.type, to.id as string) as Row | undefined;
			if (current) return this.toEdge(current);
			if (ACYCLIC.includes(input.type) && this.reachable(String(to.id), String(from.id), input.type))
				throw new Error(`${input.type} would create a cycle between ${input.to.name} and ${input.from.name}.`);
			const sourceId = this.source(principal, input.source);
			const id = randomUUID();
			this.db
				.prepare(
					"INSERT INTO graph_edges (id, from_id, type, to_id, source_id, confidence, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(id, from.id as string, input.type, to.id as string, sourceId, input.confidence ?? 0.8, this.now());
			this.event(principal, "graph.related", id, { type: input.type });
			return this.toEdge(this.db.prepare("SELECT * FROM graph_edges WHERE id = ?").get(id) as Row);
		});
	}

	replace(principal: MemoryPrincipal, input: RelateInput & { previous: string }): GraphEdge {
		return this.transaction(() => {
			const from = this.ensureNode(principal, input.from, input.scope);
			const previous = this.findNode(principal, input.previous);
			const now = this.now();
			if (previous) {
				this.db
					.prepare(
						"UPDATE graph_edges SET valid_until = ? WHERE from_id = ? AND type = ? AND to_id = ? AND valid_until IS NULL",
					)
					.run(now, from.id as string, input.type, previous.id as string);
				this.relate(principal, {
					from: { name: String(previous.name) },
					type: "REPLACED_BY",
					to: input.to,
					source: input.source,
					scope: input.scope,
				});
			}
			return this.relate(principal, input);
		});
	}

	private reachable(start: string, target: string, type: RelationType): boolean {
		const seen = new Set([start]);
		const queue = [start];
		while (queue.length > 0) {
			const id = queue.shift() as string;
			if (id === target) return true;
			for (const row of this.db
				.prepare("SELECT to_id FROM graph_edges WHERE from_id = ? AND type = ? AND valid_until IS NULL")
				.all(id, type) as Row[]) {
				const next = String(row.to_id);
				if (!seen.has(next)) {
					seen.add(next);
					queue.push(next);
				}
			}
		}
		return false;
	}

	private edgesOf(principal: MemoryPrincipal, nodeId: string, includeHistory: boolean): Row[] {
		const from = this.visible(principal, "a");
		const to = this.visible(principal, "b");
		return this.db
			.prepare(
				`SELECT e.* FROM graph_edges e JOIN graph_nodes a ON a.id = e.from_id JOIN graph_nodes b ON b.id = e.to_id
				WHERE (e.from_id = ? OR e.to_id = ?) AND ${from.sql} AND ${to.sql} ${includeHistory ? "" : "AND e.valid_until IS NULL"}
				ORDER BY e.valid_from`,
			)
			.all(nodeId, nodeId, ...from.params, ...to.params) as Row[];
	}

	neighbors(principal: MemoryPrincipal, name: string, options: { includeHistory?: boolean } = {}): GraphEdge[] {
		const node = this.findNode(principal, name);
		if (!node) return [];
		return this.edgesOf(principal, String(node.id), options.includeHistory ?? false).map((row) => this.toEdge(row));
	}

	path(principal: MemoryPrincipal, fromName: string, toName: string, maxHops = 3): GraphEdge[] | undefined {
		const from = this.findNode(principal, fromName);
		const to = this.findNode(principal, toName);
		if (!from || !to) return undefined;
		const previous = new Map<string, Row | null>([[String(from.id), null]]);
		let frontier = [String(from.id)];
		for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
			const next: string[] = [];
			for (const id of frontier) {
				for (const edge of this.edgesOf(principal, id, false)) {
					const other = String(edge.from_id) === id ? String(edge.to_id) : String(edge.from_id);
					if (previous.has(other)) continue;
					previous.set(other, edge);
					next.push(other);
				}
			}
			if (previous.has(String(to.id))) break;
			frontier = next;
		}
		if (!previous.has(String(to.id))) return undefined;
		const edges: GraphEdge[] = [];
		let cursor = String(to.id);
		for (let edge = previous.get(cursor); edge; edge = previous.get(cursor)) {
			edges.unshift(this.toEdge(edge));
			cursor = String(edge.from_id) === cursor ? String(edge.to_id) : String(edge.from_id);
		}
		return edges;
	}

	/** Names of visible entities mentioned in a text, used to expand retrieval through the graph. */
	mentionedEntities(principal: MemoryPrincipal, text: string): string[] {
		const normalized = ` ${normalizeText(text)} `;
		const filter = this.visible(principal, "n");
		const rows = this.db
			.prepare(
				`SELECT n.name, n.normalized, a.normalized AS alias FROM graph_nodes n LEFT JOIN graph_aliases a ON a.node_id = n.id WHERE ${filter.sql}`,
			)
			.all(...filter.params) as Row[];
		return [
			...new Set(
				rows
					.filter((row) => [row.normalized, row.alias].some((value) => value && normalized.includes(` ${value} `)))
					.map((row) => String(row.name)),
			),
		];
	}

	// ---------------------------------------------------------------- evolving user model

	private toAttribute(row: Row): ProfileAttribute {
		return {
			id: String(row.id),
			key: String(row.key),
			value: String(row.value),
			context: String(row.context),
			state: row.state as ProfileState,
			sourceId: String(row.source_id),
			createdAt: new Date(Number(row.created_at)),
			expiresAt: date(row.expires_at),
		};
	}

	setAttribute(principal: MemoryPrincipal, input: ProfileInput): ProfileAttribute {
		const key = normalizeText(input.key).replace(/ /g, "_");
		const value = this.policy.sanitize(input.value).text.slice(0, 500);
		if (!key || !value) throw new Error("Profile attributes need a key and a value.");
		const boundary = this.boundaryHit(principal, `${input.key} ${value}`);
		if (boundary) throw new Error(`The user asked not to store or infer information about "${boundary}".`);
		const context = normalizeText(input.context ?? "");
		return this.transaction(() => {
			const current = this.db
				.prepare(
					"SELECT * FROM profile_attributes WHERE tenant_id = ? AND owner_id = ? AND key = ? AND context = ? AND ended_at IS NULL",
				)
				.get(principal.tenantId, principal.ownerId, key, context) as Row | undefined;
			// An observation or inference never overrides what the user declared or confirmed.
			if (
				current &&
				(current.state === "declared" || current.state === "confirmed") &&
				(input.state === "observed" || input.state === "inferred")
			) {
				this.event(principal, "profile.inference_ignored", String(current.id), { key });
				return this.toAttribute(current);
			}
			if (current && current.value === value && current.state === input.state) return this.toAttribute(current);
			const now = this.now();
			if (current)
				this.db.prepare("UPDATE profile_attributes SET ended_at = ? WHERE id = ?").run(now, current.id as string);
			const sourceId = this.source(principal, input.source);
			const id = randomUUID();
			this.db
				.prepare(
					`INSERT INTO profile_attributes (id, tenant_id, owner_id, key, value, context, state, source_id, created_at, expires_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					principal.tenantId,
					principal.ownerId,
					key,
					value,
					context,
					input.state,
					sourceId,
					now,
					input.expiresAt?.getTime() ?? null,
				);
			this.event(principal, current ? "profile.changed" : "profile.created", id, { key, state: input.state });
			return this.toAttribute(this.db.prepare("SELECT * FROM profile_attributes WHERE id = ?").get(id) as Row);
		});
	}

	revokeAttribute(principal: MemoryPrincipal, key: string, context?: string): number {
		const normalizedKey = normalizeText(key).replace(/ /g, "_");
		const params: SQLInputValue[] = [this.now(), principal.tenantId, principal.ownerId, normalizedKey];
		let sql =
			"UPDATE profile_attributes SET state = 'revoked', ended_at = ? WHERE tenant_id = ? AND owner_id = ? AND key = ? AND ended_at IS NULL";
		if (context !== undefined) {
			sql += " AND context = ?";
			params.push(normalizeText(context));
		}
		const changes = Number(this.db.prepare(sql).run(...params).changes);
		if (changes) this.event(principal, "profile.revoked", undefined, { key: normalizedKey });
		return changes;
	}

	profile(principal: MemoryPrincipal, context?: string): ProfileAttribute[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM profile_attributes WHERE tenant_id = ? AND owner_id = ? AND ended_at IS NULL
				AND state NOT IN ('revoked', 'expired') AND (expires_at IS NULL OR expires_at > ?) ORDER BY key, created_at`,
			)
			.all(principal.tenantId, principal.ownerId, this.now()) as Row[];
		const wanted = normalizeText(context ?? "");
		const byKey = new Map<string, ProfileAttribute>();
		for (const attribute of rows.map((row) => this.toAttribute(row))) {
			if (attribute.context && attribute.context !== wanted) continue;
			const existing = byKey.get(attribute.key);
			if (!existing || (attribute.context && !existing.context)) byKey.set(attribute.key, attribute);
		}
		return [...byKey.values()];
	}

	allAttributes(principal: MemoryPrincipal): ProfileAttribute[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM profile_attributes WHERE tenant_id = ? AND owner_id = ? AND ended_at IS NULL ORDER BY key",
				)
				.all(principal.tenantId, principal.ownerId) as Row[]
		).map((row) => this.toAttribute(row));
	}

	history(principal: MemoryPrincipal, key: string): ProfileAttribute[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM profile_attributes WHERE tenant_id = ? AND owner_id = ? AND key = ? ORDER BY created_at",
				)
				.all(principal.tenantId, principal.ownerId, normalizeText(key).replace(/ /g, "_")) as Row[]
		).map((row) => this.toAttribute(row));
	}

	addBoundary(principal: MemoryPrincipal, topic: string): void {
		const normalized = normalizeText(topic);
		if (!normalized) throw new Error("A boundary needs a topic.");
		this.transaction(() => {
			this.db
				.prepare(
					"INSERT OR IGNORE INTO profile_boundaries (tenant_id, owner_id, topic, created_at) VALUES (?, ?, ?, ?)",
				)
				.run(principal.tenantId, principal.ownerId, normalized, this.now());
			// Minimization: what is already stored about the topic stops being used.
			for (const attribute of this.allAttributes(principal)) {
				if (` ${normalizeText(`${attribute.key} ${attribute.value}`)} `.includes(` ${normalized} `))
					this.revokeAttribute(principal, attribute.key, attribute.context);
			}
			this.event(principal, "profile.boundary_added");
		});
	}

	boundaries(principal: MemoryPrincipal): string[] {
		return (
			this.db
				.prepare("SELECT topic FROM profile_boundaries WHERE tenant_id = ? AND owner_id = ? ORDER BY topic")
				.all(principal.tenantId, principal.ownerId) as Row[]
		).map((row) => String(row.topic));
	}

	// ---------------------------------------------------------------- operations

	/**
	 * Retention: expires temporary profile hypotheses, purges scrubbed tombstones and finished jobs
	 * older than `retentionMs`, and drops graph nodes no relation references.
	 */
	garbageCollect(retentionMs = 30 * 86_400_000): { expired: number; purged: number } {
		return this.transaction(() => {
			const now = this.now();
			const expired = Number(
				this.db
					.prepare(
						"UPDATE profile_attributes SET state = 'expired', ended_at = ? WHERE ended_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?",
					)
					.run(now, now).changes,
			);
			const cutoff = now - retentionMs;
			const tombstones = this.db
				.prepare("SELECT id FROM memories WHERE status = 'deleted' AND updated_at < ?")
				.all(cutoff) as Row[];
			for (const row of tombstones)
				this.db.prepare("DELETE FROM memory_source_links WHERE memory_id = ?").run(row.id as string);
			const purged = Number(
				this.db.prepare("DELETE FROM memories WHERE status = 'deleted' AND updated_at < ?").run(cutoff).changes,
			);
			this.db.prepare("DELETE FROM memory_jobs WHERE status = 'done' AND updated_at < ?").run(cutoff);
			this.db.exec(
				"DELETE FROM graph_aliases WHERE node_id IN (SELECT id FROM graph_nodes n WHERE NOT EXISTS (SELECT 1 FROM graph_edges e WHERE e.from_id = n.id OR e.to_id = n.id))",
			);
			this.db.exec(
				"DELETE FROM graph_nodes WHERE NOT EXISTS (SELECT 1 FROM graph_edges e WHERE e.from_id = graph_nodes.id OR e.to_id = graph_nodes.id)",
			);
			return { expired, purged };
		});
	}

	/** Consistent online backup through `VACUUM INTO`. */
	backup(target: string): void {
		mkdirSync(dirname(target), { recursive: true });
		this.db.prepare("VACUUM INTO ?").run(target);
	}

	stats(principal: MemoryPrincipal): Record<string, number> {
		const count = (sql: string, ...params: SQLInputValue[]) => Number((this.db.prepare(sql).get(...params) as Row).n);
		const owner = [principal.tenantId, principal.ownerId];
		return {
			memories: count(
				"SELECT COUNT(*) n FROM memories WHERE tenant_id = ? AND owner_id = ? AND status IN ('active','candidate','disputed')",
				...owner,
			),
			candidates: count(
				"SELECT COUNT(*) n FROM memories WHERE tenant_id = ? AND owner_id = ? AND status = 'candidate'",
				...owner,
			),
			history: count(
				"SELECT COUNT(*) n FROM memories WHERE tenant_id = ? AND owner_id = ? AND status IN ('superseded','archived')",
				...owner,
			),
			embeddings: count(
				"SELECT COUNT(*) n FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id WHERE m.tenant_id = ? AND m.owner_id = ?",
				...owner,
			),
			relations: count(
				"SELECT COUNT(*) n FROM graph_edges e JOIN graph_nodes n ON n.id = e.from_id WHERE n.tenant_id = ? AND n.owner_id = ? AND e.valid_until IS NULL",
				...owner,
			),
			profileAttributes: count(
				"SELECT COUNT(*) n FROM profile_attributes WHERE tenant_id = ? AND owner_id = ? AND ended_at IS NULL",
				...owner,
			),
			pendingJobs: count("SELECT COUNT(*) n FROM memory_jobs WHERE status IN ('pending','running')"),
			deadJobs: count("SELECT COUNT(*) n FROM memory_jobs WHERE status = 'dead'"),
		};
	}

	events(principal: MemoryPrincipal, limit = 50): Array<{ type: string; subjectId?: string; at: Date }> {
		return (
			this.db
				.prepare("SELECT * FROM memory_events WHERE tenant_id = ? AND owner_id = ? ORDER BY id DESC LIMIT ?")
				.all(principal.tenantId, principal.ownerId, limit) as Row[]
		).map((row) => ({
			type: String(row.type),
			subjectId: row.subject_id ? String(row.subject_id) : undefined,
			at: new Date(Number(row.created_at)),
		}));
	}

	/** Everything the user may take with them: current and historical memories, relations and profile. */
	export(principal: MemoryPrincipal): {
		memories: Array<MemoryRecord & { sources: MemorySource[] }>;
		relations: GraphEdge[];
		profile: ProfileAttribute[];
		boundaries: string[];
	} {
		const memories = this.list(principal, { includeHistory: true, limit: 100_000 })
			.filter((record) => record.ownerId === principal.ownerId)
			.map((record) => ({ ...record, sources: this.sources(record.sourceIds) }));
		const relations = (
			this.db
				.prepare(
					"SELECT e.* FROM graph_edges e JOIN graph_nodes n ON n.id = e.from_id WHERE n.tenant_id = ? AND n.owner_id = ? ORDER BY e.valid_from",
				)
				.all(principal.tenantId, principal.ownerId) as Row[]
		).map((row) => this.toEdge(row));
		const profile = (
			this.db
				.prepare("SELECT * FROM profile_attributes WHERE tenant_id = ? AND owner_id = ? ORDER BY key, created_at")
				.all(principal.tenantId, principal.ownerId) as Row[]
		).map((row) => this.toAttribute(row));
		return { memories, relations, profile, boundaries: this.boundaries(principal) };
	}
}

/** Restores a backup after checking that it is a memory database this version can open. */
export function restoreMemoryStore(backupPath: string, targetPath: string): void {
	const probe = new DatabaseSync(backupPath, { readOnly: true });
	try {
		const version = Number((probe.prepare("PRAGMA user_version").get() as Row).user_version);
		if (version < 1 || version > MEMORY_SCHEMA_VERSION)
			throw new Error(`Backup schema ${version} is not restorable.`);
		const check = probe.prepare("PRAGMA integrity_check").get() as Row;
		if (check.integrity_check !== "ok") throw new Error("Backup failed the integrity check.");
	} finally {
		probe.close();
	}
	mkdirSync(dirname(targetPath), { recursive: true });
	// Stale WAL files of the replaced database would be replayed over the restored copy.
	for (const suffix of ["-wal", "-shm"]) rmSync(`${targetPath}${suffix}`, { force: true });
	copyFileSync(backupPath, targetPath);
}
