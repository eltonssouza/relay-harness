import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import * as checkpoint from "../src/extensions/delegation/checkpoint.ts";
import { layaCheckpointIdentity } from "../src/extensions/laya/model-identity.ts";

/** Test-only boundary: evaluate completed local candidates without weakening the production pin. */
export function useCandidateCheckpoint() {
	const directory = process.env.RELAY_DELEGATION_EVAL_CHECKPOINT;
	if (!directory) throw new Error("Set RELAY_DELEGATION_EVAL_CHECKPOINT to the completed candidate directory");
	const report: unknown = JSON.parse(readFileSync(join(directory, "report.json"), "utf8"));
	if (
		!report ||
		typeof report !== "object" ||
		!("smoke" in report) ||
		report.smoke !== false ||
		!("candidate_sha256" in report)
	)
		throw new Error("Candidate training must be complete and cannot be a smoke run");
	const identity = layaCheckpointIdentity({
		version: checkpoint.DELEGATION_MODEL,
		layaPackage: "evaluation only",
		baseUrl: "",
		files: [
			"encoder/config.json",
			"model.safetensors",
			"rl_agent_config.json",
			"tokenizer/tokenizer.json",
			"tokenizer/tokenizer_config.json",
		].map((path) => {
			const bytes = readFileSync(join(directory, path));
			return { path, asset: path, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
		}),
	});
	if (identity.sha256 !== report.candidate_sha256)
		throw new Error("Candidate weights differ from the completed training report");
	vi.spyOn(checkpoint, "delegationCheckpoint").mockReturnValue(identity);
	return identity;
}
