import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	opendirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
} from "node:fs";
import { join, relative } from "node:path";
import { minimatch } from "minimatch";
import { type AuditConfig, canonicalPath, hash, isWithin } from "./config.ts";

export type InventoryEntry = {
	path: string;
	status: "included" | "excluded" | "symlink" | "binary" | "inaccessible" | "oversized" | "submodule";
	sha256?: string;
	bytes?: number;
	lines?: number;
	reason?: string;
};
export type Snapshot = {
	version: 1;
	id: string;
	repositoryRevision: string;
	entries: InventoryEntry[];
	files: Record<string, string>;
	limitations: string[];
};
export type ReadReceipt = { path: string; start: number; end: number };
export function observed(reads: ReadReceipt[], path: string, start: number, end: number): boolean {
	const ranges = reads.filter((r) => r.path === path).sort((a, b) => a.start - b.start);
	let next = start;
	for (const range of ranges) {
		if (range.start > next) return false;
		if (range.end >= next) next = range.end + 1;
		if (next > end) return true;
	}
	return false;
}
export function redact(text: string): string {
	return text
		.replace(
			/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
			(value) => `[REDACTED PRIVATE KEY]${"\n".repeat(value.split("\n").length - 1)}`,
		)
		.replace(
			/((?:["']?)(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization)(?:["']?)[ \t]*[=:][ \t]*)(["'])([^\r\n]*?)\2/gi,
			"$1$2[REDACTED]$2",
		)
		.replace(
			/((?:["']?)(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization)(?:["']?)[ \t]*[=:][ \t]*)[^\r\n'"\s,;{}]+/gi,
			"$1[REDACTED]",
		)
		.replace(/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[a-zA-Z0-9]{20,}|sk-[a-zA-Z0-9_-]{20,})\b/g, "[REDACTED]")
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
export function redactData<T>(value: T): T {
	function clean(item: unknown): unknown {
		if (typeof item === "string") return redact(item);
		if (Array.isArray(item)) return item.map(clean);
		if (item && typeof item === "object")
			return Object.fromEntries(
				Object.entries(item).map(([key, val]) => [
					key,
					typeof val === "string" &&
					/^(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization)$/i.test(key)
						? "[REDACTED]"
						: clean(val),
				]),
			);
		return item;
	}
	return clean(value) as T;
}
export function safeRelative(path: string): string {
	if (
		!path ||
		path.includes("\\") ||
		path.includes(":") ||
		path.includes("\0") ||
		path.startsWith("/") ||
		path.split("/").some((p) => p === ".." || p === "." || p === "" || p.toLowerCase() === ".git")
	)
		throw new Error("Path is outside snapshot policy");
	return path;
}
export function readSnapshotFile(snapshot: Snapshot, path: string, start = 1, end?: number): string {
	safeRelative(path);
	if (!Object.hasOwn(snapshot.files, path)) throw new Error("File is not readable in this snapshot");
	const lines = snapshot.files[path].split("\n");
	const last = end ?? lines.length;
	if (!Number.isInteger(start) || !Number.isInteger(last) || start < 1 || last < start || last > lines.length)
		throw new Error("Invalid snapshot line range");
	return lines.slice(start - 1, last).join("\n");
}
export async function createSnapshot(
	config: AuditConfig,
	options: { signal?: AbortSignal; deadline?: number } = {},
): Promise<Snapshot> {
	const deadline = options.deadline ?? Date.now() + config.execution.max_run_ms;
	function check() {
		options.signal?.throwIfAborted();
		if (Date.now() > deadline) {
			const error = new Error("Snapshot time budget exhausted");
			error.name = "SnapshotLimit";
			throw error;
		}
	}
	const root = config.project.repository_path;
	const entries: InventoryEntry[] = [];
	const files: Record<string, string> = Object.create(null);
	const outputRelative = relative(root, config.scope.output_root).replaceAll("\\", "/");
	if (isWithin(root, config.scope.output_root))
		entries.push({
			path: outputRelative,
			status: "excluded",
			reason: "Explicit output directory; contents never inventoried",
		});
	const limitations = [
		"Static working-tree snapshot; tracked, untracked and gitignored files follow explicit include/exclude policy. No Git history, hooks, submodule traversal or binary analysis.",
		"Secret masking is heuristic, not a guarantee. Redacted text preserves line positions; evidence hashes identify original bytes.",
	];
	let total = 0,
		visited = 0;
	async function walk(dir: string) {
		check();
		if (!isWithin(root, realpathSync(dir))) throw new Error("Snapshot directory escaped root");
		const names: string[] = [];
		const handle = opendirSync(dir);
		try {
			for (;;) {
				const entry = handle.readSync();
				if (!entry) break;
				names.push(entry.name);
				if (names.length + visited > config.snapshot.max_files) {
					const error = new Error("Snapshot file/inventory limit exceeded");
					error.name = "SnapshotLimit";
					throw error;
				}
				if (names.length % 100 === 0) {
					await new Promise<void>((resolve) => setImmediate(resolve));
					check();
				}
			}
		} finally {
			handle.closeSync();
		}
		names.sort();
		if (!isWithin(root, realpathSync(dir))) throw new Error("Snapshot directory changed during enumeration");
		for (const name of names) {
			if (visited % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			check();
			if (++visited > config.snapshot.max_files) {
				const error = new Error("Snapshot file/inventory limit exceeded");
				error.name = "SnapshotLimit";
				throw error;
			}
			const absolute = join(dir, name);
			if (isWithin(config.scope.output_root, absolute)) continue;
			const path = relative(root, absolute).replaceAll("\\", "/");
			const entry: InventoryEntry = { path, status: "inaccessible" };
			entries.push(entry);
			try {
				const stat = lstatSync(absolute);
				if (stat.isSymbolicLink()) {
					entry.status = "symlink";
					entry.reason = "Links and junctions are not traversed";
					continue;
				}
				if (!isWithin(root, realpathSync(absolute))) throw new Error("Path escaped root");
				const sensitive =
					/(^|\/)(\.git|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.netrc|\.pypirc|auth\.json|credentials(?:\.json)?|id_rsa|id_ed25519)(\/|$)|\.(?:p12|pfx|pem|key)$/i.test(
						path,
					);
				const excluded = config.scope.exclude.some(
					(p) => minimatch(path, p, { dot: true }) || minimatch(`${path}/`, p, { dot: true }),
				);
				if (sensitive || excluded || isWithin(config.scope.output_root, absolute)) {
					entry.status = "excluded";
					entry.reason = sensitive ? "Credential or Git metadata policy" : "Configured exclusion/output directory";
					continue;
				}
				if (stat.isDirectory()) {
					// Nested repositories/submodules are inventoried but never traversed.
					try {
						lstatSync(join(absolute, ".git"));
						entry.status = "submodule";
						entry.reason = "Nested repository";
						continue;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
					await walk(absolute);
					entries.splice(entries.indexOf(entry), 1);
					continue;
				}
				if (!stat.isFile()) {
					entry.reason = "Non-regular file";
					continue;
				}
				if (stat.nlink > 1) {
					entry.status = "excluded";
					entry.reason = "Hard-linked file; origin cannot be confined";
					continue;
				}
				if (!config.scope.include.some((p) => minimatch(path, p, { dot: true }))) {
					entry.status = "excluded";
					entry.reason = "Outside include patterns";
					continue;
				}
				entry.bytes = stat.size;
				if (stat.size > config.snapshot.max_file_bytes || total + stat.size > config.snapshot.max_total_bytes) {
					entry.status = "oversized";
					continue;
				}
				const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				let data: Buffer;
				try {
					const before = fstatSync(fd);
					if (!before.isFile() || before.size > config.snapshot.max_file_bytes)
						throw new Error("File changed during snapshot");
					const buffer = Buffer.alloc(Math.min(before.size + 1, config.snapshot.max_file_bytes + 1));
					let bytes = 0;
					while (bytes < buffer.length) {
						const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
						if (!count) break;
						bytes += count;
					}
					if (bytes > config.snapshot.max_file_bytes || total + bytes > config.snapshot.max_total_bytes)
						throw new Error("File grew beyond snapshot byte limits");
					data = buffer.subarray(0, bytes);
					const after = fstatSync(fd);
					if (
						data.length !== before.size ||
						before.size !== after.size ||
						before.mtimeMs !== after.mtimeMs ||
						!isWithin(root, realpathSync(absolute))
					)
						throw new Error("File changed during snapshot");
				} finally {
					closeSync(fd);
				}
				total += data.length;
				entry.sha256 = hash(data);
				if (data.includes(0)) {
					entry.status = "binary";
					continue;
				}
				const text = data.toString("utf8");
				if (text.includes("\ufffd")) {
					entry.status = "binary";
					continue;
				}
				entry.status = "included";
				entry.lines = text.split("\n").length;
				files[path] = redact(text);
			} catch (error) {
				if (options.signal?.aborted || (error instanceof Error && error.name === "SnapshotLimit")) throw error;
				entry.status = "inaccessible";
				entry.reason = "Not a stable accessible regular file";
			}
		}
	}
	await walk(root);
	check();
	const id = hash(JSON.stringify(entries));
	let gitRevision: string | undefined;
	if (config.snapshot.git_revision) {
		try {
			const git = join(root, ".git");
			function gitText(path: string): string {
				const absolute = canonicalPath(join(git, path));
				if (!isWithin(git, absolute)) throw new Error("Git metadata escape");
				const stat = lstatSync(absolute);
				if (!stat.isFile() || stat.nlink > 1 || stat.size > 4096)
					throw new Error("Git metadata is not a bounded regular file");
				return readFileSync(absolute, "utf8").trim();
			}
			const head = gitText("HEAD");
			const ref = head.startsWith("ref: ") ? head.slice(5) : undefined;
			if (
				ref &&
				(!/^refs\/heads\/[a-zA-Z0-9._/-]+$/.test(ref) || ref.split("/").some((p) => p === ".." || p === "." || !p))
			)
				throw new Error("Invalid Git HEAD reference");
			const revision = ref ? gitText(ref) : head;
			if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)) throw new Error("Invalid Git object ID");
			gitRevision = revision.toLowerCase();
		} catch {
			limitations.push(
				"Authorized Git HEAD identity unavailable (packed refs/worktree links are not followed); snapshot hash remains authoritative. No Git history was read.",
			);
		}
	}
	if (entries.some((e) => e.status !== "included"))
		limitations.push("Inventory omissions are not proof of non-applicability and reduce coverage.");
	for (const entry of entries) Object.freeze(entry);
	Object.freeze(entries);
	Object.freeze(files);
	Object.freeze(limitations);
	return Object.freeze({
		version: 1,
		id,
		repositoryRevision: `${gitRevision ? `git:${gitRevision};` : ""}snapshot:${id}`,
		entries,
		files,
		limitations,
	});
}
