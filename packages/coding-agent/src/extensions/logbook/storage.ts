import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LogbookEventType =
	| "session_started"
	| "request_started"
	| "tool_started"
	| "tool_completed"
	| "tool_failed"
	| "file_changed"
	| "checkpoint"
	| "activity_settled"
	| "interruption_detected"
	| "session_shutdown"
	| "note";

export interface LogbookEvent {
	version: 1;
	id: string;
	timestamp: string;
	sessionId: string;
	processId: number;
	type: LogbookEventType;
	relatedSessionId?: string;
	toolName?: string;
	path?: string;
	outcome?: "completed" | "aborted" | "error";
	files?: string[];
	text?: string;
}

const MAX_READ_BYTES = 256 * 1024;

export function getLogbookFile(root: string): string {
	return join(root, ".relay", "memory", "logbook", "events.jsonl");
}

function ensureLogbookDirectory(root: string): string {
	let directory = root;
	for (const part of [".relay", "memory", "logbook"]) {
		directory = join(directory, part);
		try {
			const stats = lstatSync(directory);
			if (stats.isSymbolicLink() || !stats.isDirectory()) {
				throw new Error(`Refusing unsafe logbook directory: ${directory}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				mkdirSync(directory);
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				const stats = lstatSync(directory);
				if (stats.isSymbolicLink() || !stats.isDirectory()) {
					throw new Error(`Refusing unsafe logbook directory: ${directory}`);
				}
			}
		}
	}
	return directory;
}

function isLogbookEvent(value: unknown): value is LogbookEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const event = value as Record<string, unknown>;
	return (
		event.version === 1 &&
		typeof event.id === "string" &&
		typeof event.timestamp === "string" &&
		typeof event.sessionId === "string" &&
		typeof event.processId === "number" &&
		typeof event.type === "string"
	);
}

export function appendLogbookEvent(
	root: string,
	input: Omit<LogbookEvent, "version" | "id" | "timestamp" | "processId">,
): void {
	const directory = ensureLogbookDirectory(root);
	const path = join(directory, "events.jsonl");
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Refusing unsafe logbook file: ${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const event: LogbookEvent = {
		version: 1,
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		processId: process.pid,
		...input,
	};
	const fd = openSync(path, "a+", 0o600);
	try {
		const size = fstatSync(fd).size;
		const lastByte = Buffer.alloc(1);
		const hasTrailingNewline = size === 0 || (readSync(fd, lastByte, 0, 1, size - 1) === 1 && lastByte[0] === 10);
		writeFileSync(fd, `${hasTrailingNewline ? "" : "\n"}${JSON.stringify(event)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function findInterruptedActivity(root: string): LogbookEvent | undefined {
	const activeBySession = new Map<string, LogbookEvent>();
	for (const event of readRecentLogbookEvents(root, 1000)) {
		if (event.type === "request_started") activeBySession.set(event.sessionId, event);
		if (event.type === "activity_settled") activeBySession.delete(event.sessionId);
		if (event.type === "interruption_detected" && event.relatedSessionId) {
			activeBySession.delete(event.relatedSessionId);
		}
	}
	return [...activeBySession.values()]
		.filter((event) => event.processId !== process.pid && !isProcessAlive(event.processId))
		.sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
}

function isProcessAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export function readRecentLogbookEvents(root: string, limit = 30): LogbookEvent[] {
	const path = getLogbookFile(root);
	try {
		let directory = root;
		for (const part of [".relay", "memory", "logbook"]) {
			directory = join(directory, part);
			const stats = lstatSync(directory);
			if (stats.isSymbolicLink() || !stats.isDirectory()) {
				throw new Error(`Refusing unsafe logbook directory: ${directory}`);
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Refusing unsafe logbook file: ${path}`);
	const fd = openSync(path, "r");
	try {
		const length = Math.min(stats.size, MAX_READ_BYTES);
		const buffer = Buffer.alloc(length);
		const start = Math.max(0, stats.size - length);
		const bytesRead = readSync(fd, buffer, 0, length, start);
		let text = buffer.toString("utf8", 0, bytesRead);
		if (start > 0) {
			const firstLine = text.indexOf("\n");
			text = firstLine < 0 ? "" : text.slice(firstLine + 1);
		}
		return text
			.split("\n")
			.filter((line) => line.length > 0)
			.flatMap((line) => {
				try {
					const event: unknown = JSON.parse(line);
					return isLogbookEvent(event) ? [event] : [];
				} catch {
					return [];
				}
			})
			.slice(-limit);
	} finally {
		closeSync(fd);
	}
}

export function sanitizeLogbookText(text: string): string {
	return text
		.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
		.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted]")
		.replace(/\b(api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
		.replace(/[\r\n\t]+/g, " ")
		.slice(0, 2000);
}
