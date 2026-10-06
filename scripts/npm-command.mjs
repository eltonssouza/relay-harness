import { spawnSync } from "node:child_process";

/**
 * Runs `npm` the same way on every platform. On Windows `npm` is `npm.cmd`, and Node refuses to
 * spawn a `.cmd` file without a shell (EINVAL), so the shell is used there. Every argument the
 * release scripts pass is a fixed flag or a package name, so nothing needs escaping.
 */
export function spawnNpm(args, options = {}) {
	return spawnSync("npm", args, { ...options, shell: process.platform === "win32" });
}
