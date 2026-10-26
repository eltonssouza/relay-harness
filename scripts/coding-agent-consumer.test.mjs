import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installCodingAgentConsumer, packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";

const codingAgentName = "@relay-harness/coding-agent";

function createFixture(t, { importUndeclared = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "relay-consumer-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const packages = [{ name: codingAgentName, directory: join(root, "packages", "coding-agent") }];
	for (const pkg of packages) {
		const manifest = {
			name: pkg.name,
			version: "1.0.0",
			type: "module",
			exports: { ".": "./dist/index.js" },
			bin: { relay: "dist/bundle/cli.js" },
		};
		const files = {
			"package.json": JSON.stringify(manifest),
			"dist/index.js": `
${importUndeclared ? 'import "@relay-harness/undeclared";' : ""}
export function createAgentSession() {}
export class SessionManager { static inMemory() {} }
export class ModelRuntime { static create() {} }
`,
			"dist/cli.js": 'console.log("1.0.0");',
			"dist/bundle/cli.js": 'console.log("1.0.0");',
		};
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(pkg.directory, path)), { recursive: true });
			writeFileSync(join(pkg.directory, path), content);
		}
	}
	const tarballs = packReleasePackages(packages, join(root, "tarballs"));
	const directory = join(root, "consumer");
	installCodingAgentConsumer(directory, tarballs);
	return directory;
}

// #9132: installing every tarball directly hid undeclared runtime imports.
test("installs only coding-agent directly", (t) => {
	const directory = createFixture(t);
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies), [codingAgentName]);
	smokeTestCodingAgentConsumer(directory);
});

// #9132: smoke-test the public SDK, not just a bundled CLI that hides missing imports.
test("fails when the SDK imports an undeclared package despite a working CLI", (t) => {
	const directory = createFixture(t, { importUndeclared: true });
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /Cannot find package '@relay-harness\/undeclared'/);
});
