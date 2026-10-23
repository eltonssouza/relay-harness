/**
 * Contracts of the native memory engine. Domain code depends on these types; SQLite and embedding
 * models are adapters behind them, so another database can replace the local one without changing callers.
 */

export type MemoryScope = "user" | "project" | "agent" | "shared";
export type MemoryStatus = "candidate" | "active" | "superseded" | "disputed" | "archived" | "deleted";
export type MemoryKind = "fact" | "event" | "preference" | "procedure";

/** Who is asking. Every read and write is filtered by this identity; nothing crosses tenants. */
export interface MemoryPrincipal {
	tenantId: string;
	ownerId: string;
	/** Project the request runs in. Project memories of other projects are invisible. */
	projectId?: string;
	/** Agent the request runs as. Agent memories of other agents are invisible. */
	agentId?: string;
}

export interface MemoryRecord {
	id: string;
	tenantId: string;
	ownerId: string;
	scope: MemoryScope;
	projectId?: string;
	agentId?: string;
	kind: MemoryKind;
	content: string;
	status: MemoryStatus;
	confidence: number;
	importance: number;
	sourceIds: string[];
	createdAt: Date;
	updatedAt: Date;
	validFrom?: Date;
	validUntil?: Date;
	version: number;
	/** Set when the content looked like instructions to the model; it is still shown only as quoted data. */
	flagged: boolean;
}

/** Provenance: where a memory, relation or profile attribute came from. Mandatory for every write. */
export interface MemorySource {
	id: string;
	kind: "user" | "session" | "tool" | "import" | "agent";
	/** Stable reference to the origin: session id and entry id, imported file path, tool call id. */
	reference: string;
	excerpt?: string;
	createdAt: Date;
}

export type SourceInput = Omit<MemorySource, "id" | "createdAt">;

export interface RememberInput {
	scope: MemoryScope;
	kind: MemoryKind;
	content: string;
	source: SourceInput;
	/** Defaults to active for user statements and candidate for agent or tool observations. */
	status?: MemoryStatus;
	confidence?: number;
	importance?: number;
	validFrom?: Date;
	validUntil?: Date;
	/** Memory this one replaces; the old record becomes superseded and keeps its history. */
	supersedes?: string;
}

export interface RememberResult {
	record: MemoryRecord;
	/** False when an identical memory already existed and only its provenance was extended. */
	created: boolean;
}

export interface SearchOptions {
	limit?: number;
	scopes?: MemoryScope[];
	kinds?: MemoryKind[];
	/** Includes superseded and archived memories, e.g. to answer historical questions. */
	includeHistory?: boolean;
}

export interface SearchHit {
	record: MemoryRecord;
	score: number;
	/** Which indexes matched: lexical, semantic, or both. */
	matchedBy: Array<"lexical" | "semantic">;
	sources: MemorySource[];
}

export interface MemoryRepository {
	remember(principal: MemoryPrincipal, input: RememberInput): Promise<RememberResult>;
	get(principal: MemoryPrincipal, id: string): MemoryRecord | undefined;
	search(principal: MemoryPrincipal, query: string, options?: SearchOptions): Promise<SearchHit[]>;
	/** Deletion propagates to the lexical index, embeddings, graph evidence and profile evidence. */
	forget(principal: MemoryPrincipal, id: string, reason: string): boolean;
	list(principal: MemoryPrincipal, options?: SearchOptions): MemoryRecord[];
}

export interface EmbeddingProvider {
	/** Model identity stored with each vector; vectors of another model are never compared. */
	readonly model: string;
	embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export type RelationType = "USES" | "PREFERS" | "DECIDED" | "DEPENDS_ON" | "REPLACED_BY" | "LEARNED_FROM";

export interface GraphNode {
	id: string;
	name: string;
	type: string;
	aliases: string[];
}

export interface GraphEdge {
	id: string;
	from: GraphNode;
	type: RelationType;
	to: GraphNode;
	sourceId: string;
	validFrom: Date;
	validUntil?: Date;
	confidence: number;
}

export interface RelateInput {
	from: { name: string; type?: string };
	type: RelationType;
	to: { name: string; type?: string };
	source: SourceInput;
	scope?: MemoryScope;
	confidence?: number;
}

export interface GraphRepository {
	addAlias(principal: MemoryPrincipal, name: string, alias: string): GraphNode;
	relate(principal: MemoryPrincipal, input: RelateInput): GraphEdge;
	/** Ends the current relation to the old object and records the new one; history is kept. */
	replace(principal: MemoryPrincipal, input: RelateInput & { previous: string }): GraphEdge;
	neighbors(principal: MemoryPrincipal, name: string, options?: { includeHistory?: boolean }): GraphEdge[];
	/** Shortest relation path, at most `maxHops` edges, over current relations. */
	path(principal: MemoryPrincipal, from: string, to: string, maxHops?: number): GraphEdge[] | undefined;
}

export type ProfileState = "declared" | "observed" | "inferred" | "confirmed" | "revoked" | "expired";

export interface ProfileAttribute {
	id: string;
	key: string;
	value: string;
	/** Situation where it applies, e.g. "code-review"; empty means general. Specific contexts win. */
	context: string;
	state: ProfileState;
	sourceId: string;
	createdAt: Date;
	expiresAt?: Date;
}

export interface ProfileInput {
	key: string;
	value: string;
	context?: string;
	state: Extract<ProfileState, "declared" | "observed" | "inferred" | "confirmed">;
	source: SourceInput;
	expiresAt?: Date;
}

export interface UserModelRepository {
	setAttribute(principal: MemoryPrincipal, input: ProfileInput): ProfileAttribute;
	revokeAttribute(principal: MemoryPrincipal, key: string, context?: string): number;
	/** Current attributes; for each key the specific context overrides the general value. */
	profile(principal: MemoryPrincipal, context?: string): ProfileAttribute[];
	history(principal: MemoryPrincipal, key: string): ProfileAttribute[];
	/** Topics the user asked never to store or infer. */
	addBoundary(principal: MemoryPrincipal, topic: string): void;
}

export interface MemoryPolicy {
	canRead(
		principal: MemoryPrincipal,
		record: Pick<MemoryRecord, "tenantId" | "ownerId" | "scope" | "projectId" | "agentId">,
	): boolean;
	sanitize(text: string): { text: string; redacted: boolean; flagged: boolean };
}
