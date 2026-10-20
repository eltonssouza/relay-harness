import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { canonicalPath, preflight } from "../../core/audit/config.ts";
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
/** No commands, tools, hooks, prompts, resources or target IO until explicitly enabled. */
export default function auditExtension(relay: ExtensionAPI) {
	if (process.env.RELAY_AUDIT_ENABLED !== "1") return;
	const running = new Set<string>();
	let starting = false;
	let pending: AbortController | undefined;
	async function start(text: string, ctx: ExtensionCommandContext, resume: boolean) {
		if (starting || running.size) throw new Error("An audit is already running in this host; cancel it or wait");
		const parts = args(text);
		const recover = resume && parts.length === 3 && parts[2] === "--recover-stale-lock";
		if (!recover && parts.length !== (resume ? 2 : 1))
			throw new Error(resume ? 'Usage: /audit-resume "config.yaml" audit-<uuid>' : 'Usage: /audit "config.yaml"');
		starting = true;
		pending = new AbortController();
		try {
			const config = await readAuditConfig(parts[0], ctx.cwd);
			if (!ctx.model || ctx.model.provider !== config.model.provider || ctx.model.id !== config.model.id)
				throw new Error("Select the exact provider/model explicitly authorized by audit config");
			const task = runAudit({
				config,
				signal: pending.signal,
				runId: resume ? parts[1] : undefined,
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
						`Audit ${outcome.run.run_id}: ${outcome.run.status}. Local artifacts: ${outcome.directory}`,
						outcome.run.status === "COMPLETED" ? "info" : "warning",
					);
				})
				.catch(() => {
					starting = false;
					pending = undefined;
					for (const id of running) if (!activeAuditStatus(id)) running.delete(id);
					ctx.ui.notify(
						"Audit failed a preflight, checkpoint or IO gate; inspect local artifacts. No report success claimed.",
						"error",
					);
				});
			ctx.ui.notify(
				"Static audit starting. Model egress explicitly authorized by config; no dynamic tests, PDF or remote publishing. Use /audit-status and /audit-cancel.",
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
			} catch {
				ctx.ui.notify(
					"Audit request rejected. Check explicit model consent, static-only options, output authorization, config path and command arguments.",
					"error",
				);
			}
		};
	relay.registerCommand("audit", {
		description: "Opt-in static universal audit: /audit config.yaml",
		handler: guarded((text, ctx) => start(text, ctx, false)),
	});
	relay.registerCommand("audit-resume", {
		description: "Resume an unchanged snapshot/config: /audit-resume config.yaml audit-<uuid>",
		handler: guarded((text, ctx) => start(text, ctx, true)),
	});
	relay.registerCommand("audit-status", {
		description: "Local audit status; optionally config.yaml audit-<uuid>",
		handler: guarded(async (text, ctx) => {
			const parts = args(text);
			if (parts.length === 0) {
				ctx.ui.notify(JSON.stringify([...running].map((id) => ({ id, ...activeAuditStatus(id) }))), "info");
				return;
			}
			if (parts.length !== 2) throw new Error("Usage: /audit-status [config.yaml audit-<uuid>]");
			const config = await readAuditConfig(parts[0], ctx.cwd);
			const status = readAuditStatus(config.scope.output_root, parts[1]);
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
	relay.registerCommand("audit-cancel", {
		description: "Cancel a local audit; checkpoints and partial results retained",
		handler: guarded(async (text, ctx) => {
			const parts = args(text);
			if (parts.length > 1) throw new Error("Usage: /audit-cancel [audit-<uuid>]");
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
