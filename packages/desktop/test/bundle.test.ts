/**
 * What the installers are built from, checked without building them: the release workflow runs
 * the Tauri bundler on each platform, so a missing icon or a version mismatch would only fail on
 * release day. These checks catch it in every CI run.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const SHELL = fileURLToPath(new URL("../src-tauri/", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface TauriConfig {
	version: string;
	bundle: { active: boolean; targets: string[]; icon: string[]; resources: Record<string, string> };
}

interface Job {
	needs?: string;
	strategy: { matrix: { include: Array<{ os: string; bundle: string; binary: string }> } };
	steps: Array<{ run?: string; uses?: string }>;
}

const config = JSON.parse(readFileSync(join(SHELL, "tauri.conf.json"), "utf8")) as TauriConfig;
const workflow = parse(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8")) as {
	jobs: Record<string, Job>;
};
const installers = workflow.jobs["desktop-installers"];
const runs = (job: Job) => job.steps.map((step) => step.run ?? "").join("\n");

/** Width and height of a PNG, from its IHDR chunk. */
function pngSize(data: Buffer): [number, number] {
	expect(data.subarray(1, 4).toString("ascii")).toBe("PNG");
	return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

describe("the desktop installers", () => {
	it("take the version the release sets on every workspace package", () => {
		const desktop = JSON.parse(readFileSync(join(SHELL, config.version), "utf8")) as {
			name: string;
			version: string;
		};
		const codingAgent = JSON.parse(readFileSync(join(ROOT, "packages/coding-agent/package.json"), "utf8")) as {
			version: string;
		};
		expect(desktop.name).toBe("@relay-harness/desktop");
		expect(desktop.version).toBe(codingAgent.version);
	});

	it("bundle for Windows, macOS and Linux with the icons each needs", () => {
		expect(config.bundle.active).toBe(true);
		expect([...config.bundle.targets].sort()).toEqual(["appimage", "dmg", "msi"]);
		for (const icon of config.bundle.icon) {
			const data = readFileSync(join(SHELL, icon));
			if (icon.endsWith(".png")) {
				const [width, height] = pngSize(data);
				const named = /(\d+)x(\d+)(@2x)?\.png$/.exec(icon);
				expect(width).toBe(height);
				if (named) expect(width).toBe(Number(named[1]) * (named[3] ? 2 : 1));
			} else if (icon.endsWith(".ico")) {
				expect(data.readUInt16LE(2)).toBe(1);
				const sizes = Array.from({ length: data.readUInt16LE(4) }, (_, index) => data[6 + 16 * index] || 256);
				expect(sizes).toContain(256);
			} else if (icon.endsWith(".icns")) {
				expect(data.subarray(0, 4).toString("ascii")).toBe("icns");
				expect(data.readUInt32BE(4)).toBe(data.length);
			} else {
				throw new Error(`unexpected icon ${icon}`);
			}
		}
	});

	it("are built and kept by the release workflow on each platform", () => {
		const bundles = installers.strategy.matrix.include.map((entry) => entry.bundle);
		expect(bundles.sort()).toEqual(["appimage", "dmg", "msi"]);
		expect(runs(installers)).toMatch(/cargo tauri build --bundles \$\{\{ matrix\.bundle \}\}/);
		expect(runs(installers)).toContain("npm run build --workspace @relay-harness/desktop");
		expect(installers.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@"))).toBe(true);
	});

	it("carry the relay binary of their platform from the release's binaries job", () => {
		// The folder is in every checkout, so a local build finds it; only the release fills it.
		expect(config.bundle.resources).toEqual({ "resources/relay": "relay" });
		expect(readFileSync(join(SHELL, "resources/relay/.gitignore"), "utf8")).toMatch(/^\*$/m);

		expect(installers.needs).toBe("binaries");
		expect(runs(workflow.jobs.binaries)).toContain("scripts/build-binaries.sh");
		const script = readFileSync(join(ROOT, "scripts/build-binaries.sh"), "utf8");
		// The script's list of every platform, not the `--platform` override.
		const platforms = /^\s*PLATFORMS=\(([a-z0-9 -]+)\)/m.exec(script)?.[1].split(" ") ?? [];
		expect(platforms).toContain("windows-x64");
		for (const entry of installers.strategy.matrix.include) expect(platforms).toContain(entry.binary);
		const extracts = installers.steps.filter((step) => step.run?.includes("matrix.binary"));
		expect(extracts.length).toBe(2);
		for (const step of extracts) expect(step.run).toContain("packages/desktop/src-tauri/resources/relay");
	});
});
