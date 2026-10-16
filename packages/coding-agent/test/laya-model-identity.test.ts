import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { layaCheckpointIdentity } from "../src/extensions/laya/model-identity.ts";
import { LAYA_MODEL_MANIFEST } from "../src/extensions/laya/model-manifest.ts";

describe("pinned Laya checkpoint identity", () => {
	it("matches the Python server's artifact digest fixture", () => {
		const identity = layaCheckpointIdentity({
			version: "relay-laya-v4",
			layaPackage: "test",
			baseUrl: "",
			files: [
				"encoder/config.json",
				"model.safetensors",
				"rl_agent_config.json",
				"tokenizer/tokenizer.json",
				"tokenizer/tokenizer_config.json",
			].map((path) => {
				const bytes = Buffer.from(path);
				return {
					path,
					asset: path,
					size: bytes.byteLength,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				};
			}),
		});
		expect(identity.artifactSha256).toBe("664872c2e58516f14cfade07dd12d34f9f08cec7ee3924c384ebfe1c534c3679");
	});
	it("follows checkpoint contents across file ordering and download locations", () => {
		const original = layaCheckpointIdentity(LAYA_MODEL_MANIFEST);
		const moved = structuredClone(LAYA_MODEL_MANIFEST);
		moved.baseUrl = "https://example.invalid/another-mirror/";
		moved.files.reverse();
		moved.files[0].asset = "renamed-download-asset";
		expect(layaCheckpointIdentity(moved)).toEqual(original);
	});
	it.each([
		"rl_agent_config.json",
		"encoder/config.json",
		"tokenizer/tokenizer.json",
		"tokenizer/tokenizer_config.json",
	])("detects changed %s even when weights stay identical", (path) => {
		const original = layaCheckpointIdentity(LAYA_MODEL_MANIFEST);
		const changed = structuredClone(LAYA_MODEL_MANIFEST);
		changed.files.find((file) => file.path === path)!.sha256 = "0".repeat(64);
		expect(layaCheckpointIdentity(changed).sha256).toBe(original.sha256);
		expect(layaCheckpointIdentity(changed).artifactSha256).not.toBe(original.artifactSha256);
	});
	it.each(["../escape", "/absolute", "C:/absolute", "nested\\file", "duplicate/../file", "line\nname", "nul\0name"])(
		"rejects ambiguous file paths: %j",
		(path) => {
			const changed = structuredClone(LAYA_MODEL_MANIFEST);
			changed.files[0].path = path;
			expect(() => layaCheckpointIdentity(changed)).toThrow("Invalid pinned");
		},
	);
	it("rejects duplicate or missing weights and invalid sizes or hashes", () => {
		const missing = structuredClone(LAYA_MODEL_MANIFEST);
		missing.files = missing.files.filter((file) => file.path !== "model.safetensors");
		expect(() => layaCheckpointIdentity(missing)).toThrow("weights are missing");
		const duplicate = structuredClone(LAYA_MODEL_MANIFEST);
		duplicate.files.push({ ...duplicate.files[0] });
		expect(() => layaCheckpointIdentity(duplicate)).toThrow("Invalid pinned");
		for (const change of [{ size: 0 }, { size: 1.5 }, { sha256: "invalid" }]) {
			const invalid = structuredClone(LAYA_MODEL_MANIFEST);
			Object.assign(invalid.files[0], change);
			expect(() => layaCheckpointIdentity(invalid)).toThrow("Invalid pinned");
		}
	});
});
