import type { MemoryPolicy, MemoryPrincipal, MemoryRecord } from "./types.ts";

const SECRET_PATTERNS: RegExp[] = [
	/\bBearer\s+[^\s"']+/gi,
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const ASSIGNMENT =
	/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi;
const INJECTION =
	/\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all)\b.{0,40}\b(instructions?|rules?|prompts?)\b|<\/?\s*(system|assistant|developer)\b|\byou are now\b|\bnew instructions?\s*:/i;

export const MAX_MEMORY_LENGTH = 4000;

/**
 * Default local policy: memories are private to their owner unless shared; project and agent memories
 * stay inside their project and agent. Secrets are masked before anything is stored, and text that reads
 * like instructions is flagged so the context builder can present it as quoted data only.
 */
export const defaultMemoryPolicy: MemoryPolicy = {
	canRead(
		principal: MemoryPrincipal,
		record: Pick<MemoryRecord, "tenantId" | "ownerId" | "scope" | "projectId" | "agentId">,
	) {
		if (record.tenantId !== principal.tenantId) return false;
		if (record.scope === "shared") return true;
		if (record.ownerId !== principal.ownerId) return false;
		if (record.scope === "project") return record.projectId !== undefined && record.projectId === principal.projectId;
		if (record.scope === "agent") return record.agentId !== undefined && record.agentId === principal.agentId;
		return true;
	},
	sanitize(text: string) {
		let result = text.replace(/\r\n?/g, "\n").trim();
		const before = result;
		for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[redacted]");
		result = result.replace(ASSIGNMENT, "$1=[redacted]");
		return {
			text: result.slice(0, MAX_MEMORY_LENGTH),
			redacted: result !== before,
			flagged: INJECTION.test(result),
		};
	},
};

/** Canonical form used for deduplication and entity resolution: case, accents and spacing do not matter. */
export function normalizeText(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}
