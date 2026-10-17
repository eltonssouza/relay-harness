import { createHash } from "node:crypto";
import {
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import ignore, { type Ignore } from "ignore";

export interface WorkspaceSnapshot {
	version: 1;
	digest: string;
	files: ReadonlyMap<string, string>;
}

export interface WorkspaceBaseline {
	version: 2;
	digest: string;
	observedFiles: string[];
	/** Runtime-owned session files inside this workspace, retained across navigation. */
	controlFiles: string[];
}

interface CachedFile {
	identity: string;
	digest: string;
}

const IGNORE_FILES = [".gitignore", ".ignore", ".fdignore"];

/** Content fingerprints, independent of mtimes and of Git availability. Never traverses directory links. */
export function captureWorkspace(
	cwd: string,
	observedFiles: readonly string[] = [],
	options: { cache?: Map<string, CachedFile>; rehash?: boolean; controlFiles?: readonly string[] } = {},
): WorkspaceSnapshot {
	const root = realpathSync(resolve(cwd));
	const files = new Map<string, string>();
	const buffer = Buffer.allocUnsafe(64 * 1024);
	const controlFiles = new Set(
		(options.controlFiles ?? []).flatMap((file) => {
			const path = resolve(root, file);
			const canonical = lstatSync(path, { throwIfNoEntry: false }) ? realpathSync(path) : path;
			return [path, canonical].map((name) => (process.platform === "win32" ? name.toLowerCase() : name));
		}),
	);
	const hashFile = (path: string): string => {
		const metadata = statSync(path, { bigint: true });
		const identity = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
		const cached = options.cache?.get(path);
		if (!options.rehash && cached?.identity === identity) return cached.digest;
		const descriptor = openSync(path, "r");
		try {
			const before = fstatSync(descriptor, { bigint: true });
			const hash = createHash("sha256");
			for (;;) {
				const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
				if (bytes === 0) break;
				hash.update(buffer.subarray(0, bytes));
			}
			const after = fstatSync(descriptor, { bigint: true });
			const current = statSync(path, { bigint: true });
			if (
				before.size !== after.size ||
				before.mtimeNs !== after.mtimeNs ||
				before.ctimeNs !== after.ctimeNs ||
				current.dev !== after.dev ||
				current.ino !== after.ino ||
				current.size !== after.size ||
				current.mtimeNs !== after.mtimeNs ||
				current.ctimeNs !== after.ctimeNs
			)
				throw new Error(`Workspace file changed during capture: ${path}`);
			const digest = hash.digest("hex");
			options.cache?.set(path, { identity, digest });
			return digest;
		} finally {
			closeSync(descriptor);
		}
	};
	const record = (path: string, name: string): void => {
		if (controlFiles.has(process.platform === "win32" ? path.toLowerCase() : path)) return;
		const entry = lstatSync(path, { throwIfNoEntry: false });
		if (!entry) {
			files.set(name, "missing");
			return;
		}
		const target = entry.isSymbolicLink() ? statSync(path, { throwIfNoEntry: false }) : undefined;
		const canonical = !entry.isSymbolicLink() || target ? realpathSync(path) : undefined;
		if (canonical && controlFiles.has(process.platform === "win32" ? canonical.toLowerCase() : canonical))
			files.set(name, "session-artifact");
		else if (entry.isSymbolicLink()) {
			files.set(
				name,
				`link:${JSON.stringify(readlinkSync(path))}:${target?.isFile() ? hashFile(path) : target?.isDirectory() ? "directory" : "missing"}`,
			);
		} else if (entry.isFile()) files.set(name, `file:${hashFile(path)}`);
		else if (entry.isDirectory()) {
			if ((process.platform === "win32" ? name.toLowerCase() : name) !== ".relay")
				files.set(`${name}/`, "directory");
		} else files.set(name, `special:${entry.mode}`);
	};
	const walk = (directory: string, parents: readonly { base: string; rules: Ignore }[]): void => {
		const rules = ignore({ ignorecase: process.platform === "win32" });
		for (const name of IGNORE_FILES) {
			const path = join(directory, name);
			if (statSync(path, { throwIfNoEntry: false })?.isFile()) rules.add(readFileSync(path, "utf8"));
		}
		const layers = [...parents, { base: directory, rules }];
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		)) {
			const path = join(directory, entry.name);
			const name = relative(root, path).replaceAll("\\", "/");
			const baseName = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
			if (baseName === ".git" || baseName === "node_modules") continue;
			let excluded = false;
			for (const layer of layers) {
				const match = layer.rules.test(
					relative(layer.base, path).replaceAll("\\", "/") + (entry.isDirectory() ? "/" : ""),
				);
				if (match.ignored) excluded = true;
				else if (match.unignored) excluded = false;
			}
			// The rules themselves are inputs even if a rule would hide its own file.
			if (excluded && !IGNORE_FILES.includes(entry.name)) continue;
			record(path, name);
			if (entry.isDirectory()) walk(path, layers);
		}
	};
	walk(root, []);
	for (const observed of observedFiles) {
		const path = resolve(root, observed);
		const name = relative(root, path).replaceAll("\\", "/");
		const key =
			name === ".." || name.startsWith("../") || isAbsolute(name) ? `absolute:${path.replaceAll("\\", "/")}` : name;
		if (!name || files.has(key)) continue;
		record(path, key);
	}
	const entries = [...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return { version: 1, digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), files };
}

export function changedWorkspaceFiles(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
	return [...new Set([...before.files.keys(), ...after.files.keys()])]
		.filter((name) => before.files.get(name) !== after.files.get(name))
		.sort();
}

/** Cached boundary checks; checkpoints and recovery can require a fresh content hash. */
export class WorkspaceTracker {
	private readonly cwd: string;
	private readonly observed: Set<string>;
	private readonly cache = new Map<string, CachedFile>();
	private readonly controlFiles: Set<string>;
	private snapshot: WorkspaceSnapshot;
	private digest: string;

	constructor(cwd: string, baseline?: WorkspaceBaseline, controlFiles: readonly string[] = []) {
		if (
			baseline &&
			(baseline.version !== 2 ||
				!/^[a-f\d]{64}$/.test(baseline.digest) ||
				!Array.isArray(baseline.observedFiles) ||
				baseline.observedFiles.some((path) => typeof path !== "string") ||
				!Array.isArray(baseline.controlFiles) ||
				baseline.controlFiles.some((path) => typeof path !== "string"))
		)
			throw new Error("Unsupported delegation workspace baseline; start a new task");
		this.cwd = realpathSync(resolve(cwd));
		this.observed = new Set(baseline?.observedFiles);
		this.controlFiles = new Set(
			[...(baseline?.controlFiles ?? []), ...controlFiles].map((file) => {
				const path = resolve(this.cwd, file);
				return lstatSync(path, { throwIfNoEntry: false }) ? realpathSync(path) : path;
			}),
		);
		this.snapshot = captureWorkspace(this.cwd, [...this.observed], {
			cache: this.cache,
			rehash: true,
			controlFiles: [...this.controlFiles],
		});
		this.digest = baseline?.digest ?? this.snapshot.digest;
	}

	baseline(): WorkspaceBaseline {
		return {
			version: 2,
			digest: this.digest,
			observedFiles: [...this.observed].sort(),
			controlFiles: [...this.controlFiles]
				.flatMap((path) => {
					const name = relative(this.cwd, path).replaceAll("\\", "/");
					return !name || name === ".." || name.startsWith("../") || isAbsolute(name) ? [] : [name];
				})
				.sort(),
		};
	}

	inspect(rehash = false): { files: string[]; restored: boolean } | undefined {
		const next = captureWorkspace(this.cwd, [...this.observed], {
			cache: this.cache,
			rehash,
			controlFiles: [...this.controlFiles],
		});
		const changed = this.digest !== next.digest;
		const restored = this.digest !== this.snapshot.digest;
		const files = changed ? changedWorkspaceFiles(this.snapshot, next) : [];
		this.snapshot = next;
		this.digest = next.digest;
		return changed ? { files, restored } : undefined;
	}

	/** Adding a previously untracked dependency invalidates earlier validation. */
	observe(path: string): boolean {
		const absolute = resolve(this.cwd, path);
		const name = relative(this.cwd, absolute).replaceAll("\\", "/");
		const observed = name === ".." || name.startsWith("../") || isAbsolute(name) ? absolute : name;
		if (!observed || this.observed.has(observed)) return false;
		this.observed.add(observed);
		return this.inspect() !== undefined;
	}
}
