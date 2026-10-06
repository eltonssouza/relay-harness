import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

export function getPublicWorkspacePackages() {
	return findPackageDirectories()
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true)
		.map(({ directory, name, version, dependencies, optionalDependencies, peerDependencies }) => ({
			directory,
			name,
			version,
			dependencies: Object.keys({ ...dependencies, ...optionalDependencies, ...peerDependencies }),
		}));
}

/**
 * Orders packages so every package comes after the workspace packages it depends on. Publishing in
 * this order means no published version ever depends on a version that is not on npm yet, so an
 * install that races a release does not fail. Ties keep the alphabetical order of the input.
 */
export function sortByInternalDependencies(packages) {
	const names = new Set(packages.map((pkg) => pkg.name));
	const remaining = new Map(
		packages.map((pkg) => [pkg.name, new Set((pkg.dependencies ?? []).filter((name) => names.has(name) && name !== pkg.name))]),
	);
	const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
	const sorted = [];

	while (remaining.size > 0) {
		const ready = [...remaining].find(([, dependencies]) => dependencies.size === 0);
		if (!ready) {
			throw new Error(`Workspace packages depend on each other in a cycle: ${[...remaining.keys()].join(", ")}`);
		}
		const [name] = ready;
		remaining.delete(name);
		for (const dependencies of remaining.values()) dependencies.delete(name);
		sorted.push(byName.get(name));
	}

	return sorted;
}
