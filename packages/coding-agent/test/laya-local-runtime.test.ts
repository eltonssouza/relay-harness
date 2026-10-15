import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getPackageDir } from "../src/config.ts";

const python = (process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]).find(
	(command) =>
		spawnSync(command, ["-I", "-c", "import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)"], {
			windowsHide: true,
		}).status === 0,
);

it.skipIf(!python)("checks native checkpoint integrity, interrupted downloads and offline cache reuse", () => {
	const result = execFileSync(python!, ["-I", join(getPackageDir(), "test", "laya-local-runtime.test.py")], {
		encoding: "utf8",
		windowsHide: true,
		stdio: "pipe",
	});
	expect(result).toContain("downloading encoder/model");
});
