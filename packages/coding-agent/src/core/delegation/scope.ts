import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkTask } from "./contracts.ts";

export const WORKER_INSPECTION_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/** Resolve existing ancestors as well: a new file behind a symlink must not escape its scope. */
function canonical(path: string): string {
	if (existsSync(path)) return realpathSync.native(path);
	const parent = dirname(path);
	return parent === path ? path : resolve(canonical(parent), relative(parent, path));
}

function contains(root: string, path: string): boolean {
	const child = relative(root, path);
	return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

/** File-tool confinement; shell access is workspace-wide and remains subject to principal permissions. */
export function checkWorkerScope(
	cwd: string,
	task: WorkTask,
	name: string,
	args: unknown,
	controlFiles: readonly string[] = [],
): void {
	const workspace = canonical(resolve(cwd));
	if (task.accessMode === "investigation" && !WORKER_INSPECTION_TOOLS.includes(name))
		throw new Error("Investigation workers may use only read-only file tools");
	const fileTool = [...WORKER_INSPECTION_TOOLS, "write", "edit"].includes(name);
	if (!fileTool) {
		if (["bash", "powershell"].includes(name)) {
			if (!task.resourceScope.some((scope) => canonical(resolve(cwd, scope)) === workspace))
				throw new Error("Shell validation or mutation requires explicit workspace-wide scope");
		} else if (!task.resourceScope.includes(`tool:${name}`)) {
			throw new Error(`Worker requires an explicit tool resource scope: tool:${name}`);
		}
		return;
	}
	const input = args && typeof args === "object" && "path" in args ? args.path : ".";
	if (typeof input !== "string") throw new Error("Invalid worker file path");
	const path = canonical(resolve(cwd, input));
	if (!contains(workspace, path)) throw new Error("Worker file path is outside the workspace");
	if (controlFiles.length && ["write", "edit"].includes(name)) {
		const target = statSync(path, { bigint: true, throwIfNoEntry: false });
		if (
			controlFiles.some((file) => {
				const owned = canonical(resolve(cwd, file));
				if (process.platform === "win32" ? owned.toLowerCase() === path.toLowerCase() : owned === path) return true;
				const identity = statSync(owned, { bigint: true, throwIfNoEntry: false });
				return (
					target !== undefined &&
					identity !== undefined &&
					target.dev === identity.dev &&
					target.ino === identity.ino
				);
			})
		)
			throw new Error("Workers cannot modify principal session history");
	}
	if (
		!task.resourceScope.some((scope) => !scope.startsWith("tool:") && contains(canonical(resolve(cwd, scope)), path))
	)
		throw new Error("Worker file path is outside the approved task scope");
}
