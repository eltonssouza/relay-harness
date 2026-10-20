import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type AuditConfig = {
	version: "3.0";
	project: { name: string; repository_path: string };
	scope: { include: string[]; exclude: string[]; output_root: string; allow_output_in_target: boolean };
	model: { authorized: true; provider: string; id: string };
	context: {
		target_jurisdictions: string[];
		regulated_industries: string[];
		personal_data_processing: "yes" | "no" | "unknown";
	};
	execution: {
		max_parallel_specialists: number;
		max_task_ms: number;
		max_run_ms: number;
		max_task_tokens: number;
		max_task_cost: number;
		max_task_tool_calls: number;
		max_task_output_bytes: number;
		max_tokens: number;
		max_cost: number;
		max_tool_calls: number;
		max_output_bytes: number;
		max_handoffs: number;
		max_retries: number;
		generate_issues_drafts: boolean;
	};
	snapshot: {
		policy: "working-tree";
		git_revision: boolean;
		max_files: number;
		max_file_bytes: number;
		max_total_bytes: number;
	};
};
export function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
export function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Invalid ${label}: expected object`);
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported ${label}.${key}`);
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
		throw new Error(`Invalid ${label}`);
	return value;
}
function strings(value: unknown, fallback: string[], label: string): string[] {
	if (value === undefined) return fallback;
	if (
		!Array.isArray(value) ||
		value.length > 128 ||
		!value.every((v) => typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v))
	)
		throw new Error(`Invalid ${label}`);
	return value;
}
function bounded(value: unknown, fallback: number, max: number, label: string, minimum = 1): number {
	const n = value ?? fallback;
	if (typeof n !== "number" || !Number.isSafeInteger(n) || n < minimum || n > max)
		throw new Error(`Invalid ${label} (1..${max})`);
	return n;
}
function cost(value: unknown, fallback: number, label: string): number {
	const n = value ?? fallback;
	if (typeof n !== "number" || !Number.isFinite(n) || n < 0.001 || n > 1000) throw new Error(`Invalid ${label}`);
	return n;
}
export function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
// Reject links even when they resolve inside the target: output consent is for a path, not its referent.
export function canonicalPath(path: string): string {
	if (path.startsWith("\\\\") || path.startsWith("//") || /^[a-z]:(?![\\/])/i.test(path))
		throw new Error("Network, device and drive-relative paths are not supported");
	const absolute = resolve(path);
	let cursor = absolute;
	for (;;) {
		try {
			if (lstatSync(cursor).isSymbolicLink()) throw new Error("Symlink/junction path is not authorized");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	cursor = absolute;
	while (true) {
		try {
			return resolve(realpathSync(cursor), relative(cursor, absolute));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(cursor);
			if (parent === cursor) throw error;
			cursor = parent;
		}
	}
}
export async function preflight(input: unknown, cwd = process.cwd()): Promise<AuditConfig> {
	const v = record(input, "configuration");
	keys(v, ["version", "project", "scope", "model", "context", "execution", "snapshot"], "configuration");
	if (v.version !== "3.0") throw new Error("Unsupported audit config version");
	const model = record(v.model, "model authorization");
	keys(model, ["authorized", "provider", "id"], "model");
	if (model.authorized !== true)
		throw new Error("Model egress must be explicitly authorized (including local models)");
	const provider = text(model.provider, "model.provider"),
		id = text(model.id, "model.id");
	const project = record(v.project, "project");
	keys(project, ["name", "repository_path", "repository_revision"], "project");
	if (project.repository_revision != null) throw new Error("repository_revision is determined by the executor");
	const scope = record(v.scope ?? {}, "scope");
	keys(
		scope,
		[
			"include",
			"exclude",
			"output_root",
			"allow_output_in_target",
			"authorized_environments",
			"runtime_testing",
			"sandbox_authorized",
			"external_network_access",
			"git_history_analysis",
			"allow_write_to_target",
			"allow_publish_github_issues",
		],
		"scope",
	);
	for (const key of [
		"runtime_testing",
		"sandbox_authorized",
		"external_network_access",
		"git_history_analysis",
		"allow_write_to_target",
		"allow_publish_github_issues",
	]) {
		if (scope[key] !== undefined && scope[key] !== false)
			throw new Error(`Unsupported scope.${key}; only static read-only audit is supported`);
	}
	if (
		scope.authorized_environments !== undefined &&
		JSON.stringify(scope.authorized_environments) !== '["local-repo"]'
	)
		throw new Error("Only local-repo is supported");
	if (scope.allow_output_in_target !== undefined && typeof scope.allow_output_in_target !== "boolean")
		throw new Error("Invalid output consent");
	const execution = record(v.execution ?? {}, "execution");
	keys(
		execution,
		[
			"max_parallel_specialists",
			"max_task_ms",
			"max_run_ms",
			"max_task_tokens",
			"max_task_cost",
			"max_task_tool_calls",
			"max_task_output_bytes",
			"max_tokens",
			"max_cost",
			"max_tool_calls",
			"max_output_bytes",
			"max_handoffs",
			"max_retries",
			"generate_pdf",
			"generate_issues_drafts",
			"resumable",
			"completeness_policy",
			"severity_model",
			"proof_of_concept",
		],
		"execution",
	);
	if (execution.generate_pdf !== undefined && execution.generate_pdf !== false)
		throw new Error("PDF generation is not supported; use JSON and Markdown");
	if (execution.resumable !== undefined && execution.resumable !== true)
		throw new Error("Checkpoints cannot be disabled");
	for (const [key, expected] of Object.entries({
		completeness_policy: "report_partial_if_missing",
		severity_model: "CVSS_v4_if_justifiable_else_qualitative",
		proof_of_concept: "non_destructive_authorized_only",
	}))
		if (execution[key] !== undefined && execution[key] !== expected) throw new Error(`Unsupported execution.${key}`);
	if (execution.generate_issues_drafts !== undefined && typeof execution.generate_issues_drafts !== "boolean")
		throw new Error("Invalid drafts option");
	const context = record(v.context ?? {}, "context");
	keys(context, ["target_jurisdictions", "regulated_industries", "personal_data_processing"], "context");
	const processing = context.personal_data_processing ?? "unknown";
	if (processing !== "yes" && processing !== "no" && processing !== "unknown")
		throw new Error("Invalid personal_data_processing");
	const snapshot = record(v.snapshot, "explicit snapshot policy");
	keys(snapshot, ["policy", "git_revision", "max_files", "max_file_bytes", "max_total_bytes"], "snapshot");
	if (snapshot.policy !== "working-tree")
		throw new Error(
			"Explicit snapshot.policy: working-tree consent is required (includes untracked and ignored files unless excluded)",
		);
	if (snapshot.git_revision !== undefined && typeof snapshot.git_revision !== "boolean")
		throw new Error("Invalid Git revision consent");
	const include = strings(scope.include, ["**/*"], "include"),
		exclude = strings(scope.exclude, [], "exclude");
	if (
		!include.length ||
		[...include, ...exclude].some(
			(p) => p.includes("\\") || p.startsWith("/") || p.split("/").includes("..") || p.includes(":"),
		)
	)
		throw new Error("Scope patterns must be relative POSIX globs");
	const effectiveExecution: AuditConfig["execution"] = {
		max_parallel_specialists: bounded(execution.max_parallel_specialists, 1, 4, "parallelism"),
		max_task_ms: bounded(execution.max_task_ms, 120_000, 600_000, "task time"),
		max_run_ms: bounded(execution.max_run_ms, 1_800_000, 86_400_000, "run time"),
		max_task_tokens: bounded(execution.max_task_tokens, 16000, 200000, "task tokens"),
		max_task_cost: cost(execution.max_task_cost, 2, "task cost"),
		max_task_tool_calls: bounded(execution.max_task_tool_calls, 40, 1000, "task tool calls"),
		max_task_output_bytes: bounded(execution.max_task_output_bytes, 65536, 1048576, "task output"),
		max_tokens: bounded(execution.max_tokens, 200_000, 2_000_000, "tokens"),
		max_cost: cost(execution.max_cost, 10, "cost"),
		max_tool_calls: bounded(execution.max_tool_calls, 200, 10000, "tool calls"),
		max_output_bytes: bounded(execution.max_output_bytes, 262144, 1048576, "output size"),
		max_handoffs: bounded(execution.max_handoffs, 20, 100, "handoffs", 0),
		max_retries: bounded(execution.max_retries, 1, 2, "retries", 0),
		generate_issues_drafts: execution.generate_issues_drafts === true,
	};
	const effectiveSnapshot: AuditConfig["snapshot"] = {
		policy: "working-tree",
		git_revision: snapshot.git_revision === true,
		max_files: bounded(snapshot.max_files, 10000, 100000, "files"),
		max_file_bytes: bounded(snapshot.max_file_bytes, 262144, 1048576, "file size"),
		max_total_bytes: bounded(snapshot.max_total_bytes, 20 * 1024 * 1024, 100 * 1024 * 1024, "snapshot size"),
	};
	const name = text(project.name, "project.name");
	const effectiveContext: AuditConfig["context"] = {
		target_jurisdictions: strings(context.target_jurisdictions, [], "jurisdictions"),
		regulated_industries: strings(context.regulated_industries, [], "industries"),
		personal_data_processing: processing,
	};
	// No target content is inspected until ALL authorization, budgets and unsupported options pass.
	const target = canonicalPath(resolve(cwd, text(project.repository_path, "repository_path")));
	const output = canonicalPath(resolve(cwd, text(scope.output_root, "output_root")));
	if (output.split(/[\\/]/).some((part) => part.toLowerCase() === ".git"))
		throw new Error("Output cannot be Git metadata");
	if (!lstatSync(target).isDirectory()) throw new Error("Target must be a directory");
	if (target === output || isWithin(output, target)) throw new Error("Output cannot contain the target");
	if (isWithin(target, output) && scope.allow_output_in_target !== true)
		throw new Error("Output in target requires allow_output_in_target consent for that directory only");
	return {
		version: "3.0",
		project: { name, repository_path: target },
		scope: { include, exclude, output_root: output, allow_output_in_target: scope.allow_output_in_target === true },
		model: { authorized: true, provider, id },
		context: effectiveContext,
		execution: effectiveExecution,
		snapshot: effectiveSnapshot,
	};
}
