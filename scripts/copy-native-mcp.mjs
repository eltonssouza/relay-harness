import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Standalone binaries cannot resolve npm dependencies. Copy the installed runtime
// closure without executing lifecycle scripts or fetching anything at release time.
const modules = realpathSync(fileURLToPath(new URL("../node_modules", import.meta.url)));
const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/copy-native-mcp.mjs <resources/native-mcp>");
const destination = resolve(output);
const copied = new Set();

function copyPackage(name, from, optional = false) {
	let directory = from;
	let source;
	while (true) {
		const candidate = join(directory, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) {
			source = realpathSync(candidate);
			break;
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	if (!source) {
		if (optional) return;
		throw new Error(`Missing installed native MCP dependency: ${name}`);
	}
	if (copied.has(source)) return;
	const location = relative(modules, source);
	if (location.startsWith(`..${sep}`) || location === ".." || isAbsolute(location))
		throw new Error(`Native MCP dependency outside node_modules: ${name}`);
	copied.add(source);
	const target = join(destination, "node_modules", location);
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, {
		recursive: true,
		filter: (path) => relative(source, path).split(sep)[0] !== "node_modules",
	});
	const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
	for (const dependency of Object.keys(manifest.dependencies ?? {})) copyPackage(dependency, source);
	for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) copyPackage(dependency, source, true);
	for (const dependency of Object.keys(manifest.peerDependencies ?? {}))
		copyPackage(dependency, source, manifest.peerDependenciesMeta?.[dependency]?.optional === true);
}

for (const name of ["@upstash/context7-mcp", "@playwright/mcp"]) copyPackage(name, dirname(modules));
