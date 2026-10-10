import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import ignore from "ignore";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { findGitPaths } from "../../core/footer-data-provider.ts";
import { renderGraphViewer } from "./viewer.ts";

export interface MemoryNode {
	id: string;
	kind: "directory" | "file" | "package" | "dependency";
	label: string;
	path?: string;
	summary: string;
	symbols?: string[];
	imports?: string[];
	dependencies?: string[];
	scripts?: string[];
	stamp?: string;
	hash?: string;
}

export interface MemoryEdge {
	from: string;
	to: string;
	kind: "contains" | "imports" | "depends" | "links";
}

export interface ProjectGraph {
	version: 1;
	updatedAt: string;
	nodes: MemoryNode[];
	edges: MemoryEdge[];
	warnings: string[];
}

const execFileAsync = promisify(execFile);
const MAX_FILES = 30000;
const MAX_TEXT_BYTES = 256 * 1024;
const TEXT_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".md",
	".py",
	".go",
	".rs",
	".java",
	".cs",
	".rb",
	".sh",
	".ps1",
	".json",
	".yaml",
	".yml",
	".toml",
	".html",
	".css",
	".sql",
]);
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".venv",
	"venv",
	"__pycache__",
	".aws",
	".ssh",
]);

export function projectRoot(cwd: string): string {
	return findGitPaths(resolve(cwd))?.repoDir ?? resolve(cwd);
}

export function memoryPaths(root: string): { directory: string; graph: string; viewer: string } {
	const directory = join(root, CONFIG_DIR_NAME, "memory");
	return { directory, graph: join(directory, "graph.json"), viewer: join(directory, "graph.html") };
}

function excluded(path: string): boolean {
	const parts = path.split("/");
	const name = basename(path).toLowerCase();
	return (
		parts.some((part) => EXCLUDED_DIRECTORIES.has(part)) ||
		path.startsWith(`${CONFIG_DIR_NAME}/memory/`) ||
		/^\.env(?:\.|$)/.test(name) ||
		/(?:secret|credential|auth|token)s?\.(?:json|ya?ml|toml)$/.test(name) ||
		/\.(?:pem|key|p12|pfx)$/.test(name)
	);
}

/** Refuse symlinks in any path component, including links to directories outside the repository. */
export async function safeProjectFile(root: string, path: string): Promise<boolean> {
	const rel = relative(root, resolve(root, path));
	if (!rel || isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === "..") return false;
	let current = root;
	try {
		for (const part of rel.split(sep)) {
			current = join(current, part);
			if ((await lstat(current)).isSymbolicLink()) return false;
		}
		return (await lstat(current)).isFile();
	} catch {
		return false;
	}
}

async function listFiles(root: string): Promise<string[]> {
	if (findGitPaths(root)) {
		// Git applies nested ignore files and includes both tracked and untracked project files.
		const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
			timeout: 30000,
		});
		return [...new Set(stdout.split("\0").filter((path) => path && !excluded(path)))].sort();
	}
	const files: string[] = [];
	async function walk(
		directory: string,
		inherited: Array<{ prefix: string; rules: ReturnType<typeof ignore> }>,
	): Promise<void> {
		const scopes = [...inherited];
		const prefix = relative(root, directory).split(sep).join("/");
		const rules = ignore();
		for (const name of [".gitignore", ".relayignore"]) {
			try {
				if (!(await safeProjectFile(root, join(prefix, name)))) continue;
				const content = await readFile(join(directory, name), "utf8");
				rules.add(content);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		scopes.push({ prefix: prefix ? `${prefix}/` : "", rules });
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			const candidate = `${path}${entry.isDirectory() ? "/" : ""}`;
			let ignored = false;
			for (const scope of scopes) {
				const result = scope.rules.test(candidate.slice(scope.prefix.length));
				if (result.ignored) ignored = true;
				if (result.unignored) ignored = false;
			}
			if (excluded(candidate) || entry.isSymbolicLink() || ignored) continue;
			if (entry.isDirectory()) await walk(join(directory, entry.name), scopes);
			else if (entry.isFile()) files.push(path);
			if (files.length > MAX_FILES) return;
		}
	}
	await walk(root, []);
	return files.sort();
}

function isMemoryNode(value: unknown): value is MemoryNode {
	if (!value || typeof value !== "object") return false;
	const node = value as Record<string, unknown>;
	return (
		["id", "label", "summary"].every((key) => typeof node[key] === "string") &&
		["file", "directory", "package", "dependency"].includes(String(node.kind)) &&
		["path", "stamp", "hash"].every((key) => node[key] === undefined || typeof node[key] === "string") &&
		["symbols", "imports", "dependencies", "scripts"].every(
			(key) =>
				node[key] === undefined ||
				(Array.isArray(node[key]) && node[key].every((item: unknown) => typeof item === "string")),
		)
	);
}

export async function readGraph(root: string): Promise<ProjectGraph | undefined> {
	try {
		const path = relative(root, memoryPaths(root).graph);
		if (!(await safeProjectFile(root, path))) return undefined;
		const graph: unknown = JSON.parse(await readFile(memoryPaths(root).graph, "utf8"));
		if (
			!graph ||
			typeof graph !== "object" ||
			!("version" in graph) ||
			graph.version !== 1 ||
			!("updatedAt" in graph) ||
			typeof graph.updatedAt !== "string" ||
			!("nodes" in graph) ||
			!Array.isArray(graph.nodes) ||
			!("edges" in graph) ||
			!Array.isArray(graph.edges) ||
			!("warnings" in graph) ||
			!Array.isArray(graph.warnings) ||
			!graph.warnings.every((warning) => typeof warning === "string") ||
			!graph.nodes.every(isMemoryNode) ||
			!graph.edges.every(
				(edge: unknown) =>
					!!edge &&
					typeof edge === "object" &&
					"from" in edge &&
					typeof edge.from === "string" &&
					"to" in edge &&
					typeof edge.to === "string" &&
					"kind" in edge &&
					["contains", "imports", "depends", "links"].includes(String(edge.kind)),
			)
		) {
			throw new Error("Invalid project memory. Run /init to rebuild it.");
		}
		return graph as ProjectGraph;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Atomic replacement prevents a concurrent reader from seeing half a JSON document. */
export async function writeMemoryFile(root: string, name: "graph.json" | "graph.html", content: string): Promise<void> {
	const paths = memoryPaths(root);
	// Do not let a project-controlled .relay or memory symlink redirect writes.
	for (const directory of [join(root, CONFIG_DIR_NAME), paths.directory]) {
		try {
			if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Refusing memory symlink: ${directory}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await mkdir(paths.directory, { recursive: true });
	const temporary = join(paths.directory, `${name}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
		await rename(temporary, join(paths.directory, name));
	} finally {
		await rm(temporary, { force: true });
	}
}

async function indexFile(root: string, path: string, previous?: MemoryNode): Promise<MemoryNode | undefined> {
	if (!(await safeProjectFile(root, path))) return undefined;
	const stats = await lstat(join(root, path));
	const stamp = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
	if (previous?.stamp === stamp) return previous;
	const node: MemoryNode = {
		id: `file:${path}`,
		kind: "file",
		label: basename(path),
		path,
		summary: `${extname(path).slice(1) || "file"}; ${stats.size} bytes`,
		stamp,
	};
	if (stats.size > MAX_TEXT_BYTES) {
		node.summary += "; content exceeds indexing limit";
		return node;
	}
	if (!TEXT_EXTENSIONS.has(extname(path))) return node;
	const bytes = await readFile(join(root, path));
	if (bytes.includes(0)) {
		node.summary += "; binary content not indexed";
		return node;
	}
	const text = bytes.toString("utf8");
	node.hash = createHash("sha256").update(bytes).digest("hex");
	node.symbols = [
		...text.matchAll(
			/(?:^|\n)\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type|def|fn|struct|enum)\s+(\w+)/g,
		),
	]
		.slice(0, 40)
		.map((match) => match[1]);
	if (extname(path) === ".md") {
		node.summary =
			[...text.matchAll(/^#{1,3}\s+(.+)$/gm)]
				.slice(0, 8)
				.map((match) => match[1])
				.join("; ")
				.slice(0, 500) || "Markdown document";
		node.imports = [...text.matchAll(/\]\(([^\s)#]+)(?:#[^)]*)?\)/g)].slice(0, 80).map((match) => match[1]);
	} else if (/\.[cm]?[jt]sx?$/.test(path)) {
		node.imports = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)]
			.slice(0, 80)
			.map((match) => match[1]);
		node.summary = `${node.summary}${node.symbols.length ? `; symbols: ${node.symbols.join(", ")}` : ""}`.slice(
			0,
			500,
		);
	}
	if (basename(path) === "package.json") {
		try {
			const manifest = JSON.parse(text) as {
				name?: unknown;
				scripts?: Record<string, unknown>;
				dependencies?: Record<string, unknown>;
				devDependencies?: Record<string, unknown>;
			};
			node.kind = "package";
			node.label = typeof manifest.name === "string" ? manifest.name : path;
			node.scripts = Object.keys(manifest.scripts ?? {});
			node.dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
			node.summary = `Package ${node.label}; scripts: ${node.scripts.join(", ")}`.slice(0, 500);
		} catch {
			node.summary = "Invalid package.json; inspect the source";
		}
	}
	return node;
}

export async function refreshGraph(root: string, previous?: ProjectGraph): Promise<ProjectGraph> {
	const paths = await listFiles(root);
	const warnings =
		paths.length > MAX_FILES
			? [`Index limited to ${MAX_FILES} files of ${paths.length}; narrow the repository with ignore rules.`]
			: [];
	const old = new Map(previous?.nodes.map((node) => [node.id, node]));
	const files: MemoryNode[] = [];
	// Bound filesystem concurrency and memory use in large repositories.
	for (let i = 0; i < Math.min(paths.length, MAX_FILES); i += 32) {
		const batch = await Promise.all(
			paths.slice(i, Math.min(i + 32, MAX_FILES)).map(async (path) => {
				try {
					return await indexFile(root, path, old.get(`file:${path}`));
				} catch {
					warnings.push(`Could not index ${path}`);
					return undefined;
				}
			}),
		);
		files.push(...batch.filter((node): node is MemoryNode => !!node));
	}
	const nodes = new Map(files.map((node) => [node.id, node]));
	nodes.set("dir:.", { id: "dir:.", kind: "directory", label: basename(root), path: ".", summary: "Repository root" });
	const edges: MemoryEdge[] = [];
	for (const file of files) {
		let child = file.id;
		let directory = posix.dirname(file.path!);
		while (true) {
			edges.push({ from: `dir:${directory}`, to: child, kind: "contains" });
			if (directory === "." || nodes.has(`dir:${directory}`)) break;
			nodes.set(`dir:${directory}`, {
				id: `dir:${directory}`,
				kind: "directory",
				label: posix.basename(directory),
				path: directory,
				summary: "Project directory",
			});
			child = `dir:${directory}`;
			directory = posix.dirname(directory);
		}
	}
	const packages = new Map(files.filter((node) => node.kind === "package").map((node) => [node.label, node.id]));
	function dependency(name: string): string {
		const local = packages.get(name);
		if (local) return local;
		const id = `dependency:${name}`;
		nodes.set(id, { id, kind: "dependency", label: name, summary: "External dependency" });
		return id;
	}
	for (const file of files) {
		for (const name of file.dependencies ?? []) edges.push({ from: file.id, to: dependency(name), kind: "depends" });
		for (const specifier of file.imports ?? []) {
			if (/^(?:https?:|mailto:|data:|#)/.test(specifier)) continue;
			if (!specifier.startsWith(".") && extname(file.path!) !== ".md") {
				const name = specifier.startsWith("@")
					? specifier.split("/").slice(0, 2).join("/")
					: specifier.split("/")[0];
				edges.push({ from: file.id, to: dependency(name), kind: "imports" });
				continue;
			}
			const target = posix.normalize(posix.join(posix.dirname(file.path!), specifier));
			const stem = target.replace(/\.(?:mjs|cjs|js)$/, "");
			const candidates = [
				target,
				...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].flatMap((extension) => [
					`${stem}${extension}`,
					`${target}/index${extension}`,
				]),
			];
			const matched = candidates.find((candidate) => nodes.has(`file:${candidate}`));
			if (matched)
				edges.push({
					from: file.id,
					to: `file:${matched}`,
					kind: extname(file.path!) === ".md" ? "links" : "imports",
				});
		}
	}
	const graph: ProjectGraph = {
		version: 1,
		updatedAt: new Date().toISOString(),
		nodes: [...nodes.values()],
		edges: [...new Map(edges.map((edge) => [`${edge.from}:${edge.kind}:${edge.to}`, edge])).values()],
		warnings,
	};
	if (
		previous &&
		JSON.stringify([previous.nodes, previous.edges, previous.warnings]) ===
			JSON.stringify([graph.nodes, graph.edges, graph.warnings])
	) {
		if (!(await safeProjectFile(root, relative(root, memoryPaths(root).viewer)))) {
			await writeMemoryFile(root, "graph.html", renderGraphViewer(previous));
		}
		return previous;
	}
	await writeMemoryFile(root, "graph.json", `${JSON.stringify(graph, null, 2)}\n`);
	await writeMemoryFile(root, "graph.html", renderGraphViewer(graph));
	return graph;
}

/** Retrieval is bounded; the full repository index never enters the model context. */
export function queryGraph(graph: ProjectGraph, query: string, limit = 8): string {
	const words = query.toLowerCase().match(/[\p{L}\p{N}_./-]{2,}/gu) ?? [];
	const ranked = graph.nodes
		.map((node) => {
			const path = `${node.path ?? ""} ${node.label}`.toLowerCase();
			const summary = `${node.summary} ${(node.symbols ?? []).join(" ")}`.toLowerCase();
			return {
				node,
				score: words.reduce((score, word) => score + (path.includes(word) ? 4 : summary.includes(word) ? 1 : 0), 0),
			};
		})
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
		.slice(0, Math.max(1, Math.min(limit, 20)));
	const byId = new Map(graph.nodes.map((node) => [node.id, node]));
	const lines = ranked.map(({ node }) => {
		const relations = graph.edges
			.filter((edge) => edge.from === node.id || edge.to === node.id)
			.sort((a, b) => Number(b.from === node.id) - Number(a.from === node.id));
		const links = relations
			.slice(0, 8)
			.map(
				(edge) =>
					`${edge.kind} ${edge.from === node.id ? "→" : "←"} ${byId.get(edge.from === node.id ? edge.to : edge.from)?.path ?? byId.get(edge.from === node.id ? edge.to : edge.from)?.label}`,
			)
			.join("; ");
		return `${node.path ?? node.label} [${node.kind}]: ${node.summary}\n${links}${relations.length > 8 ? `; ${relations.length - 8} more relationships; query related paths for details` : ""}`;
	});
	return (lines.join("\n\n") || "No matching project memory. Search the repository directly.").slice(0, 6000);
}
