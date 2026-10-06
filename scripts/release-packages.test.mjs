import assert from "node:assert/strict";
import test from "node:test";
import { spawnNpm } from "./npm-command.mjs";
import { getPublicWorkspacePackages, sortByInternalDependencies } from "./release-packages.mjs";

const pkg = (name, dependencies = []) => ({ name, version: "1.0.0", directory: name, dependencies });

test("publishes a package after the workspace packages it depends on", () => {
	const sorted = sortByInternalDependencies([pkg("a-app", ["b-lib"]), pkg("b-lib", ["c-core"]), pkg("c-core")]);
	assert.deepEqual(
		sorted.map((p) => p.name),
		["c-core", "b-lib", "a-app"],
	);
});

test("keeps the input order for packages that do not depend on each other", () => {
	const sorted = sortByInternalDependencies([pkg("a"), pkg("b"), pkg("c")]);
	assert.deepEqual(
		sorted.map((p) => p.name),
		["a", "b", "c"],
	);
});

test("ignores external dependencies and self references", () => {
	const sorted = sortByInternalDependencies([pkg("a", ["left-pad", "a"]), pkg("b")]);
	assert.deepEqual(
		sorted.map((p) => p.name),
		["a", "b"],
	);
});

test("rejects a dependency cycle", () => {
	assert.throws(() => sortByInternalDependencies([pkg("a", ["b"]), pkg("b", ["a"])]), /in a cycle: a, b/);
});

test("orders the real workspace so no package precedes its dependencies", () => {
	const packages = getPublicWorkspacePackages();
	const published = new Set();
	for (const { name, dependencies } of sortByInternalDependencies(packages)) {
		for (const dependency of dependencies) {
			if (packages.some((p) => p.name === dependency)) {
				assert.ok(published.has(dependency), `${name} would be published before its dependency ${dependency}`);
			}
		}
		published.add(name);
	}
	assert.equal(published.size, packages.length);
});

test("spawns npm on every platform", () => {
	const result = spawnNpm(["--version"], { encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});
