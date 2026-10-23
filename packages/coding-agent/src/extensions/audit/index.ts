import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { getAgentDir } from "../../config.ts";
import {
	type AuditConfig,
	automaticConfig,
	automaticOutputRoot,
	canonicalPath,
	preflight,
} from "../../core/audit/config.ts";
import { activeAuditStatus, cancelAudit, readAuditStatus, runAudit } from "../../core/audit/coordinator.ts";
import { createSdkWorker } from "../../core/audit/runtime.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";

export async function readAuditConfig(path: string, cwd: string) {
	const absolute = canonicalPath(resolve(cwd, path));
	const stat = lstatSync(absolute);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
		throw new Error("Audit config must be a regular file under 64 KiB");
	const text = readFileSync(absolute, "utf8");
	return preflight(
		absolute.endsWith(".json") ? JSON.parse(text) : parse(text, { maxAliasCount: 0 }),
		dirname(absolute),
	);
}
/** Automatic runs keep their artifacts outside the audited repository. */
export function automaticAuditBase(): string {
	return join(getAgentDir(), "audits");
}
const RUN_ID = /^audit-[a-f0-9-]{36}$/;
function args(text: string): string[] {
	const values: string[] = [];
	let position = 0;
	const pattern = /\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))/gy;
	while (position < text.length) {
		if (!text.slice(position).trim()) break;
		pattern.lastIndex = position;
		const match = pattern.exec(text);
		if (!match) throw new Error("Invalid quoted arguments");
		values.push(match[1] ?? match[2] ?? match[3]);
		position = pattern.lastIndex;
	}
	return values;
}
function message(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
/** No tools, hooks, prompts, resources or target IO; the target is read only after `/audit-app` and consent. */
export default function auditExtension(relay: ExtensionAPI) {
	if (process.env.RELAY_AUDIT_ENABLED === "0") return;
	const running = new Set<string>();
	let starting = false;
	let pending: AbortController | undefined;
	async function start(text: string, ctx: ExtensionCommandContext, resume: boolean) {
		if (starting || running.size) throw new Error("An audit is already running in this host; cancel it or wait");
		const parts = args(text);
		const recover = resume && parts.at(-1) === "--recover-stale-lock";
		if (recover) parts.pop();
		// `/audit-app` and `/audit-app-resume audit-<uuid>` configure themselves; a config file stays an advanced override.
		const automatic = resume ? parts.length === 1 && RUN_ID.test(parts[0]) : parts.length === 0;
		if (!automatic && parts.length !== (resume ? 2 : 1))
			throw new Error(
				resume
					? "Usage: /audit-app-resume audit-<uuid> [--recover-stale-lock] or /audit-app-resume config.yaml audit-<uuid>"
					: "Usage: /audit-app (automatic) or /audit-app config.yaml",
			);
		if (!ctx.model) throw new Error("Select a model with /model before running /audit-app");
		starting = true;
		pending = new AbortController();
		try {
			const config: AuditConfig = automatic
				? await automaticConfig(ctx.cwd, ctx.model, automaticAuditBase())
				: await readAuditConfig(parts[0], ctx.cwd);
			if (ctx.model.provider !== config.model.provider || ctx.model.id !== config.model.id)
				throw new Error("Select the exact provider/model explicitly authorized by audit config");
			// Automatic configuration never implies model egress: the user consents to this target and model.
			if (
				automatic &&
				!(await ctx.ui.confirm(
					"Static security audit",
					[
						`Target: ${config.project.repository_path}`,
						`Model: ${config.model.provider}/${config.model.id}. Snapshot excerpts are sent to this model.`,
						`Reports: ${config.scope.output_root}`,
						`Static and read-only; cost cap ${config.execution.max_cost}. Continue?`,
					].join("\n"),
				))
			) {
				starting = false;
				pending = undefined;
				ctx.ui.notify("Audit not started; no repository content was read or sent.", "info");
				return;
			}
			const task = runAudit({
				config,
				signal: pending.signal,
				runId: resume ? parts.at(-1) : undefined,
				recoverLock: recover,
				worker: createSdkWorker({
					cwd: config.scope.output_root,
					model: ctx.model,
					modelRuntime: ctx.modelRegistry.modelRuntime,
				}),
				onStatus(run) {
					running.add(run.run_id);
				},
			});
			// Background execution keeps status/cancel usable; never inject target data into the parent session.
			void task
				.then((outcome) => {
					starting = false;
					pending = undefined;
					running.delete(outcome.run.run_id);
					ctx.ui.notify(
						`Audit ${outcome.run.run_id}: ${outcome.run.status}. Report: ${join(outcome.directory, "report.md")}`,
						outcome.run.status === "COMPLETED" ? "info" : "warning",
					);
				})
				.catch((error) => {
					starting = false;
					pending = undefined;
					for (const id of running) if (!activeAuditStatus(id)) running.delete(id);
					ctx.ui.notify(
						`Audit failed a preflight, checkpoint or IO gate (${message(error)}); inspect local artifacts in ${config.scope.output_root}. No report success claimed.`,
						"error",
					);
				});
			ctx.ui.notify(
				`Static audit started for ${config.project.repository_path}; no dynamic tests, PDF or remote publishing. Use /audit-app-status and /audit-app-cancel.`,
				"info",
			);
		} catch (error) {
			starting = false;
			pending = undefined;
			throw error;
		}
	}
	const guarded =
		(fn: (text: string, ctx: ExtensionCommandContext) => Promise<void>) =>
		async (text: string, ctx: ExtensionCommandContext) => {
			try {
				await fn(text, ctx);
			} catch (error) {
				ctx.ui.notify(`Audit request rejected: ${message(error)}`, "error");
			}
		};
	relay.registerCommand("audit-app", {
		description: "Static security audit of this repository, configured automatically: /audit-app",
		handler: guarded((text, ctx) => start(text, ctx, false)),
	});
	relay.registerCommand("audit-app-resume", {
		description: "Resume an unchanged audit: /audit-app-resume audit-<uuid>",
		handler: guarded((text, ctx) => start(text, ctx, true)),
	});
	relay.registerCommand("audit-app-status", {
		description: "Local audit status; optionally audit-<uuid> (or config.yaml audit-<uuid>)",
		handler: guarded(async (text, ctx) => {
			const parts = args(text);
			if (parts.length === 0) {
				ctx.ui.notify(JSON.stringify([...running].map((id) => ({ id, ...activeAuditStatus(id) }))), "info");
				return;
			}
			const automatic = parts.length === 1 && RUN_ID.test(parts[0]);
			if (!automatic && parts.length !== 2)
				throw new Error("Usage: /audit-app-status [audit-<uuid>] or /audit-app-status config.yaml audit-<uuid>");
			const output = automatic
				? automaticOutputRoot(ctx.cwd, automaticAuditBase())
				: (await readAuditConfig(parts[0], ctx.cwd)).scope.output_root;
			const status = readAuditStatus(output, parts.at(-1)!);
			ctx.ui.notify(
				JSON.stringify({
					run_id: status.run.run_id,
					status: status.run.status,
					meter: status.meter,
					tasks: status.run.tasks,
				}),
				"info",
			);
		}),
	});
	relay.registerCommand("audit-app-cancel", {
		description: "Cancel a local audit; checkpoints and partial results retained",
		handler: guarded(async (text, ctx) => {
			const parts = args(text);
			if (parts.length > 1) throw new Error("Usage: /audit-app-cancel [audit-<uuid>]");
			if (!parts.length) pending?.abort(new Error("Audit cancelled by user"));
			const ids = parts.length ? parts : [...running];
			for (const id of ids) if (running.has(id)) cancelAudit(id);
			ctx.ui.notify("Cancellation requested; accepted results and partial artifacts are retained.", "info");
		}),
	});
	relay.on("session_shutdown", () => {
		pending?.abort(new Error("Host shutdown"));
		for (const id of running) cancelAudit(id);
	});
}
