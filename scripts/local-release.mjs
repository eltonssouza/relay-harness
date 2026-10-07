#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { installCodingAgentConsumer, packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";

const packages = [
	{ directory: "packages/chord", name: "@relay-harness/chord" },
	{ directory: "packages/telemetry", name: "@relay-harness/telemetry" },
	{ directory: "packages/codemode", name: "@relay-harness/codemode" },
	{ directory: "packages/mcp", name: "@relay-harness/mcp" },
	{ directory: "packages/ai", name: "@relay-harness/ai" },
	{ directory: "packages/durable", name: "@relay-harness/durable" },
	{ directory: "packages/tui", name: "@relay-harness/tui" },
	{ directory: "packages/agent", name: "@relay-harness/agent-core" },
	{ directory: "packages/protocol", name: "@relay-harness/protocol" },
	{ directory: "packages/client", name: "@relay-harness/client" },
	{ directory: "packages/server", name: "@relay-harness/server" },
	{ directory: "packages/coding-agent", name: "@relay-harness/coding-agent" },
];

function printUsage() {
	console.log(`Usage: node scripts/local-release.mjs [options]

Builds and packs the publishable packages, then installs the tarballs into an
isolated directory outside the repository for local release testing.

Options:
  --out <dir>          Output directory. Defaults to a new directory under ${tmpdir()}
  --force              Remove --out first if it already exists
  --skip-check         Do not run npm run check before building
  --skip-test          Do not run ./test.sh before building
  --skip-install       Only create tarballs; do not create isolated installs
  --skip-bun-install   Do not create the isolated Bun install
  --help               Show this help
`);
}

function parseArgs() {
	const options = {
		force: false,
		outDir: undefined,
		skipBunInstall: false,
		skipCheck: false,
		skipInstall: false,
		skipTest: false,
	};
	const args = process.argv.slice(2);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--force") {
			options.force = true;
			continue;
		}
		if (arg === "--skip-check") {
			options.skipCheck = true;
			continue;
		}
		if (arg === "--skip-test") {
			options.skipTest = true;
			continue;
		}
		if (arg === "--skip-install") {
			options.skipInstall = true;
			continue;
		}
		if (arg === "--skip-bun-install") {
			options.skipBunInstall = true;
			continue;
		}
		if (arg === "--out") {
			const value = args[++i];
			if (!value) {
				throw new Error("--out requires a directory");
			}
			options.outDir = value;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
	});

	if (result.status !== 0) {
		throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
	}

	return result.stdout ?? "";
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function commandExists(command) {
	return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function prepareOutputDirectory(options, repoRoot) {
	if (!options.outDir) {
		return mkdtempSync(join(tmpdir(), "relay-local-release-"));
	}

	const outDir = resolve(options.outDir);

	if (isInsidePath(outDir, repoRoot)) {
		throw new Error(`Output directory must be outside the repository: ${outDir}`);
	}

	if (existsSync(outDir)) {
		if (!options.force) {
			throw new Error(`Output directory already exists. Use --force to replace it: ${outDir}`);
		}
		rmSync(outDir, { force: true, recursive: true });
	}

	mkdirSync(outDir, { recursive: true });
	return outDir;
}

function currentBinaryPlatform() {
	if (process.platform === "win32") return process.arch === "arm64" ? "windows-arm64" : "windows-x64";
	if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	throw new Error(`Unsupported binary platform: ${process.platform} ${process.arch}`);
}

function buildBunBinaryRelease(targetDirectory, archiveDirectory) {
	if (!commandExists("bun")) {
		throw new Error("Bun is required for the local binary release build.");
	}
	const platform = currentBinaryPlatform();
	const binaryBuildDirectory = join(archiveDirectory, "binary-build");
	run("bash", [
		"./scripts/build-binaries.sh",
		"--skip-install",
		"--skip-build",
		"--platform",
		platform,
		"--out",
		binaryBuildDirectory,
	]);
	rmSync(targetDirectory, { force: true, recursive: true });
	cpSync(join(binaryBuildDirectory, platform), targetDirectory, { recursive: true });
	const archiveName = platform.startsWith("windows-") ? `relay-${platform}.zip` : `relay-${platform}.tar.gz`;
	cpSync(join(binaryBuildDirectory, archiveName), join(archiveDirectory, archiveName));
	return platform;
}

function createRelayShim(installDirectory) {
	const binDirectory = join(installDirectory, "node_modules", ".bin");
	if (process.platform === "win32") {
		if (existsSync(join(binDirectory, "relay.cmd"))) {
			writeFileSync(join(installDirectory, "relay.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\relay.cmd" %*\r\n');
			writeFileSync(join(installDirectory, "relay.ps1"), '& "$PSScriptRoot/node_modules/.bin/relay.ps1" @args\n');
			return;
		}
		writeFileSync(join(installDirectory, "relay.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\relay.exe" %*\r\n');
		writeFileSync(join(installDirectory, "relay.ps1"), '& "$PSScriptRoot/node_modules/.bin/relay.exe" @args\n');
		return;
	}
	symlinkSync(join("node_modules", ".bin", "relay"), join(installDirectory, "relay"));
}

const options = parseArgs();
const repoRoot = process.cwd();
const rootPackageJson = readPackageJson(repoRoot);

if (rootPackageJson.name !== "relay-monorepo") {
	throw new Error("Run this script from the repository root");
}

const outDir = prepareOutputDirectory(options, repoRoot);
const tarballDirectory = join(outDir, "tarballs");
const nodeInstallDirectory = join(outDir, "node");
const bunInstallDirectory = join(outDir, "bun-install");
const binaryDirectory = join(outDir, "bun");
mkdirSync(tarballDirectory, { recursive: true });

// Release artifacts always use a freshly generated, strictly validated catalog,
// including when checks or tests are explicitly skipped.
run("npm", ["run", "generate:models"], { cwd: repoRoot });

if (!options.skipCheck) {
	run("npm", ["run", "check"], { cwd: repoRoot });
}

for (const pkg of packages) {
	run("npm", ["run", "clean"], { cwd: pkg.directory });
	run("npm", ["run", pkg.directory === "packages/ai" ? "build:offline" : "build"], { cwd: pkg.directory });
}

if (!options.skipTest) {
	run("bash", ["./test.sh"], { cwd: repoRoot });
}

const tarballs = packReleasePackages(packages, tarballDirectory);

let binaryPlatform;
if (!options.skipInstall) {
	binaryPlatform = buildBunBinaryRelease(binaryDirectory, outDir);

	installCodingAgentConsumer(nodeInstallDirectory, tarballs);
	smokeTestCodingAgentConsumer(nodeInstallDirectory);
	createRelayShim(nodeInstallDirectory);

	if (!options.skipBunInstall) {
		if (!commandExists("bun")) {
			throw new Error("Bun is required for the isolated Bun install. Use --skip-bun-install to skip it.");
		}
		installCodingAgentConsumer(bunInstallDirectory, tarballs, "bun");
		smokeTestCodingAgentConsumer(bunInstallDirectory, "bun");
		createRelayShim(bunInstallDirectory);
	}
}

console.log("\nLocal release artifacts created:");
console.log(`  ${outDir}`);
console.log("\nTarballs:");
for (const tarball of tarballs.values()) {
	console.log(`  ${tarball}`);
}

if (!options.skipInstall) {
	console.log("\nLocal Bun binary release:");
	console.log(`  ${binaryDirectory}`);
	console.log(`  ${join(outDir, `relay-${binaryPlatform}.${String(binaryPlatform).startsWith("windows-") ? "zip" : "tar.gz"}`)}`);
	console.log("\nRun the local Bun binary release from outside the repository:");
	console.log(`  ${join(binaryDirectory, String(binaryPlatform).startsWith("windows-") ? "relay.exe" : "relay")} --help`);

	console.log("\nIsolated npm install:");
	console.log(`  ${nodeInstallDirectory}`);
	console.log("\nRun the locally packed npm CLI from outside the repository:");
	console.log(`  ${join(nodeInstallDirectory, process.platform === "win32" ? "relay.cmd" : "relay")} --help`);

	if (!options.skipBunInstall) {
		console.log("\nIsolated Bun package install:");
		console.log(`  ${bunInstallDirectory}`);
		console.log("\nRun the locally packed Bun package CLI from outside the repository:");
		console.log(`  ${join(bunInstallDirectory, process.platform === "win32" ? "relay.cmd" : "relay")} --help`);
	}
}
