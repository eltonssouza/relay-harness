/**
 * Helpers for the stream recorders: byte offsets for chunk splits, splitting a body into chunks,
 * and replacing times.
 */

/** The UTF-8 byte offset of `part` in `text`. */
export function byteOffset(text: string, part: string): number {
	const index = text.indexOf(part);
	if (index === -1) throw new Error(`${part} is not in the stream`);
	return new TextEncoder().encode(text.slice(0, index)).length;
}

export function everyBytes(sseText: string, step: number): number[] {
	const length = new TextEncoder().encode(sseText).length;
	const splits: number[] = [];
	for (let offset = step; offset < length; offset += step) splits.push(offset);
	return splits;
}

export function bodyChunks(sseText: string, splits: number[]): Uint8Array[] {
	const bytes = new TextEncoder().encode(sseText);
	const chunks: Uint8Array[] = [];
	let start = 0;
	for (const split of [...splits, bytes.length]) {
		if (split > start) chunks.push(bytes.slice(start, split));
		start = Math.max(start, split);
	}
	return chunks;
}

export function zeroTimes(value: unknown, key?: string): unknown {
	if (key === "timestamp" && typeof value === "number") return 0;
	if (Array.isArray(value)) return value.map((item) => zeroTimes(item));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, zeroTimes(item, name)]));
	}
	return value;
}

/** A fetch that answers every request with `chunks` as a server-sent event stream. */
export function sseFetch(chunks: Uint8Array[]): typeof globalThis.fetch {
	return async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
}
