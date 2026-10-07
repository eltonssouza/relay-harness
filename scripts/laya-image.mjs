#!/usr/bin/env node

// Builds the Laya Docker images of this Relay version, and pushes the ones the registry lacks.
//
// Usage: node scripts/laya-image.mjs [--variant cpu|cuda|all] [--push] [--print]
//
// The image tag is a hash of the build context (Dockerfile, scripts, model manifest), computed by
// the same code Relay uses to pick its image, so a release publishes exactly the images its users
// pull. Without --push the images are only built locally; Relay uses a local image without pulling.
// --print only prints the image references.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYA_MODEL_MANIFEST } from "../packages/coding-agent/src/extensions/laya/model-manifest.ts";
import { layaImage, layaImageContext } from "../packages/coding-agent/src/extensions/laya/runtime.ts";

const args = process.argv.slice(2);
const option = (name) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : undefined;
};
const variantOption = option("variant") ?? "all";
if (!["cpu", "cuda", "all"].includes(variantOption)) {
	console.error("Usage: node scripts/laya-image.mjs [--variant cpu|cuda|all] [--push] [--print]");
	process.exit(1);
}
const variants = variantOption === "all" ? ["cpu", "cuda"] : [variantOption];
const push = args.includes("--push");

function docker(dockerArgs, options = {}) {
	const result = spawnSync("docker", dockerArgs, { stdio: options.quiet ? "ignore" : "inherit" });
	if (result.error) throw result.error;
	return result.status ?? 1;
}

for (const variant of variants) {
	const image = layaImage(LAYA_MODEL_MANIFEST, variant);
	if (args.includes("--print")) {
		console.log(image);
		continue;
	}
	if (push && docker(["manifest", "inspect", image], { quiet: true }) === 0) {
		console.log(`${image} is already published`);
		continue;
	}
	const context = mkdtempSync(join(tmpdir(), `relay-laya-${variant}-`));
	try {
		for (const [name, content] of Object.entries(layaImageContext(LAYA_MODEL_MANIFEST, variant))) {
			writeFileSync(join(context, name), content, "utf8");
		}
		console.log(`Building ${image}`);
		if (docker(["build", "--tag", image, context]) !== 0) process.exit(1);
	} finally {
		rmSync(context, { recursive: true, force: true });
	}
	if (push) {
		console.log(`Pushing ${image}`);
		if (docker(["push", image]) !== 0) process.exit(1);
	}
}
