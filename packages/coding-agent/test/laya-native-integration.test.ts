import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { LayaSettings } from "../src/core/settings-manager.ts";
import layaExtension from "../src/extensions/laya/index.ts";
import { NativeLayaServer } from "../src/extensions/laya/native-server.ts";
import { LayaServer } from "../src/extensions/laya/server.ts";
import { trainingWorkspace } from "../src/extensions/laya/training.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("Laya inference backend", () => {
	let home: string;
	let harness: Harness | undefined;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "relay-laya-backend-"));
		vi.stubEnv(ENV_AGENT_DIR, home);
		vi.spyOn(NativeLayaServer.prototype, "install").mockResolvedValue(true);
		vi.spyOn(LayaServer.prototype, "install").mockResolvedValue(true);
		vi.spyOn(LayaServer.prototype, "stop").mockResolvedValue();
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("uses native inference for the shipped checkpoint by default", async () => {
		harness = await createHarness({ extensionFactories: [layaExtension] });
		await harness.session.prompt("/laya setup");
		expect(NativeLayaServer.prototype.install).toHaveBeenCalledOnce();
		expect(LayaServer.prototype.install).not.toHaveBeenCalled();
	});

	it.each<LayaSettings>([{ runtime: "docker" }, { image: "custom-laya:cpu" }])(
		"keeps explicit Docker configuration: %j",
		async (laya) => {
			harness = await createHarness({ settings: { laya }, extensionFactories: [layaExtension] });
			await harness.session.prompt("/laya setup");
			expect(LayaServer.prototype.install).toHaveBeenCalledOnce();
			expect(NativeLayaServer.prototype.install).not.toHaveBeenCalled();
		},
	);

	it("keeps registered volume checkpoints in Docker and can select shipped native inference", async () => {
		const registry = trainingWorkspace(join(home, "laya")).registry;
		mkdirSync(dirname(registry), { recursive: true });
		writeFileSync(registry, JSON.stringify({ active: "local-1", models: [{ name: "local-1" }] }));
		harness = await createHarness({ extensionFactories: [layaExtension] });
		await harness.session.prompt("/laya setup");
		expect(LayaServer.prototype.install).toHaveBeenCalledOnce();
		await harness.session.prompt("/laya use shipped");
		expect(NativeLayaServer.prototype.install).toHaveBeenCalledOnce();
	});
});
