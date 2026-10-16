import { createHash } from "node:crypto";
import type { LayaModelManifest } from "./runtime.ts";

export interface LayaCheckpointIdentity {
	version: string;
	sha256: string;
	artifactSha256: string;
}

/** Bind weights, configuration and tokenizer bytes independently of their download location. */
export function layaCheckpointIdentity(manifest: LayaModelManifest): LayaCheckpointIdentity {
	const hash = createHash("sha256");
	const paths = new Set<string>();
	for (const file of [...manifest.files].sort((left, right) =>
		Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
	)) {
		if (
			!file.path ||
			file.path.startsWith("/") ||
			file.path.includes(":") ||
			file.path.split("/").some((part) => !part || part === "." || part === "..") ||
			/[\\\u0000-\u001f]/.test(file.path) ||
			paths.has(file.path) ||
			!Number.isSafeInteger(file.size) ||
			file.size < 1 ||
			!/^[0-9a-f]{64}$/.test(file.sha256)
		)
			throw new Error("Invalid pinned Laya checkpoint manifest");
		paths.add(file.path);
		hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
	}
	const weights = manifest.files.find((file) => file.path === "model.safetensors");
	if (!manifest.version || !weights) throw new Error("Pinned Laya checkpoint weights are missing");
	return { version: manifest.version, sha256: weights.sha256, artifactSha256: hash.digest("hex") };
}

/** Persisted authorizations must name the exact checkpoint, not only its public version. */
export function isSameLayaCheckpoint(actual: unknown, expected: unknown): boolean {
	return Boolean(
		actual &&
			expected &&
			typeof actual === "object" &&
			typeof expected === "object" &&
			"version" in actual &&
			"version" in expected &&
			typeof actual.version === "string" &&
			actual.version.trim() &&
			actual.version === expected.version &&
			"sha256" in actual &&
			"sha256" in expected &&
			typeof actual.sha256 === "string" &&
			/^[0-9a-f]{64}$/.test(actual.sha256) &&
			actual.sha256 === expected.sha256 &&
			"artifactSha256" in actual &&
			"artifactSha256" in expected &&
			typeof actual.artifactSha256 === "string" &&
			/^[0-9a-f]{64}$/.test(actual.artifactSha256) &&
			actual.artifactSha256 === expected.artifactSha256,
	);
}
