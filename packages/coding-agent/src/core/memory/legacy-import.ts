import { readRecentLogbookEvents } from "../../extensions/logbook/storage.ts";
import type { SqliteMemoryStore } from "./sqlite-store.ts";
import type { MemoryPrincipal } from "./types.ts";

/**
 * Imports earlier memory into the engine without changing the original files:
 * notes written with `/logbook note` become project memories. Each note keeps its logbook event id
 * as provenance, so running the import again only extends provenance and never duplicates memories.
 */
export async function importLogbookNotes(
	store: SqliteMemoryStore,
	principal: MemoryPrincipal,
	root: string,
): Promise<{ imported: number; skipped: number }> {
	let imported = 0;
	let skipped = 0;
	for (const event of readRecentLogbookEvents(root, 10_000)) {
		if (event.type !== "note" || !event.text?.trim()) continue;
		try {
			const result = await store.remember(principal, {
				scope: "project",
				kind: "fact",
				content: event.text,
				source: { kind: "import", reference: `logbook:${event.id}`, excerpt: event.text },
				validFrom: new Date(event.timestamp),
			});
			if (result.created) imported++;
			else skipped++;
		} catch {
			// A note blocked by a user boundary, or empty after masking, is not imported.
			skipped++;
		}
	}
	return { imported, skipped };
}
