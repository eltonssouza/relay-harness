import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
	type ToolCallEvent,
} from "../../core/extensions/types.ts";
import { projectRoot } from "../project-memory/graph.ts";
import {
	appendLogbookEvent,
	findInterruptedActivity,
	type LogbookEvent,
	type LogbookEventType,
	readRecentLogbookEvents,
	sanitizeLogbookText,
} from "./storage.ts";

function appendForContext(
	ctx: ExtensionContext,
	type: LogbookEventType,
	extra: Partial<Pick<LogbookEvent, "toolName" | "path" | "outcome" | "files" | "text" | "relatedSessionId">> = {},
	allowEphemeral = false,
): boolean {
	if (!ctx.isProjectTrusted() || (!allowEphemeral && ctx.sessionManager.getSessionFile() === undefined)) {
		return false;
	}
	try {
		appendLogbookEvent(projectRoot(ctx.cwd), {
			sessionId: ctx.sessionManager.getSessionId(),
			type,
			...extra,
		});
		return true;
	} catch (error) {
		ctx.ui.notify(
			`Diário de bordo indisponível; a sessão continua. ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		return false;
	}
}

function formatEvent(event: LogbookEvent): string {
	const time = new Date(event.timestamp).toLocaleString();
	const parts = [time, event.type];
	if (event.toolName) parts.push(event.toolName);
	if (event.path) parts.push(event.path);
	if (event.outcome) parts.push(event.outcome);
	if (event.files?.length) parts.push(`arquivos: ${event.files.join(", ")}`);
	if (event.text) parts.push(event.text);
	return `- ${parts.join(" — ")}`;
}

function summarizeRequest(prompt: string): string {
	const lineEnd = prompt.indexOf("\n");
	const firstLine = (lineEnd < 0 ? prompt : prompt.slice(0, lineEnd)).replace(/\r/g, "").trim() || "Activity started";
	return sanitizeLogbookText(firstLine).slice(0, 200);
}

function getTouchedPath(root: string, cwd: string, event: ToolCallEvent): string | undefined {
	if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return undefined;
	const absolutePath = resolve(cwd, event.input.path);
	const path = relative(root, absolutePath);
	if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) return undefined;
	const parts = path.split(sep).map((part) => part.toLowerCase());
	const name = parts.at(-1) ?? "";
	if (
		parts.some((part) => [".aws", ".ssh"].includes(part)) ||
		/^\.env(?:\.|$)/.test(name) ||
		/(?:secret|credential|auth|token)s?\.(?:json|ya?ml|toml)$/.test(name) ||
		/\.(?:pem|key|p12|pfx)$/.test(name)
	) {
		return undefined;
	}
	return path.split(sep).join("/");
}

export default function logbookExtension(relay: ExtensionAPI): void {
	const pendingPaths = new Map<string, string>();
	const touchedFiles = new Set<string>();
	let lastOutcome: "completed" | "aborted" | "error" = "completed";

	relay.on("session_start", (_event, ctx) => {
		appendForContext(ctx, "session_started");
		if (!ctx.isProjectTrusted()) return;
		try {
			const interrupted = findInterruptedActivity(projectRoot(ctx.cwd));
			if (!interrupted) return;
			const text = "Uma atividade anterior terminou sem registrar conclusão; confira o checkpoint e o working tree.";
			appendForContext(ctx, "interruption_detected", { relatedSessionId: interrupted.sessionId, text });
			ctx.ui.notify(`Diário de bordo: ${text} Use /logbook history para ver o progresso salvo.`, "warning");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Não foi possível verificar atividades interrompidas: ${message}`, "warning");
		}
	});
	relay.on("before_agent_start", (event, ctx) => {
		pendingPaths.clear();
		touchedFiles.clear();
		appendForContext(ctx, "request_started", { text: summarizeRequest(event.prompt) });
	});
	relay.on("tool_call", (event, ctx) => {
		const path = getTouchedPath(projectRoot(ctx.cwd), ctx.cwd, event);
		if (path) pendingPaths.set(event.toolCallId, path);
	});
	relay.on("tool_execution_start", (event, ctx) => {
		appendForContext(ctx, "tool_started", { toolName: sanitizeLogbookText(event.toolName) });
	});
	relay.on("tool_execution_end", (event, ctx) => {
		const path = pendingPaths.get(event.toolCallId);
		pendingPaths.delete(event.toolCallId);
		const toolName = sanitizeLogbookText(event.toolName);
		appendForContext(ctx, event.isError ? "tool_failed" : "tool_completed", { toolName });
		if (!event.isError && path) {
			const safePath = sanitizeLogbookText(path);
			touchedFiles.add(safePath);
			appendForContext(ctx, "file_changed", { toolName, path: safePath });
		}
	});
	relay.on("agent_before_settle", (event, ctx) => {
		lastOutcome = event.outcome;
		appendForContext(ctx, "checkpoint", { outcome: event.outcome, files: [...touchedFiles].slice(0, 100) });
	});
	relay.on("agent_settled", (_event, ctx) => {
		appendForContext(ctx, "activity_settled", { outcome: lastOutcome });
	});
	relay.on("session_shutdown", (event, ctx) => {
		appendForContext(ctx, "session_shutdown", { text: event.reason });
	});

	relay.registerCommand("logbook", {
		description: "Show or add to the project development logbook",
		getArgumentCompletions: (prefix) =>
			["note", "checkpoint", "history"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("Confie neste projeto antes de gravar ou ler o diário de bordo.", "warning");
				return;
			}
			const [action, ...rest] = args.trim().split(/\s+/);
			if (action === "note") {
				const text = sanitizeLogbookText(rest.join(" ").trim());
				if (!text) {
					ctx.ui.notify("Uso: /logbook note <texto>", "warning");
					return;
				}
				const saved = appendForContext(ctx, "note", { text }, true);
				if (saved) ctx.ui.notify("Anotação adicionada ao diário de bordo.");
				return;
			}
			if (action && action !== "history" && action !== "checkpoint") {
				ctx.ui.notify("Uso: /logbook [history|checkpoint|note <texto>]", "warning");
				return;
			}
			if (action === "checkpoint") {
				const saved = appendForContext(
					ctx,
					"checkpoint",
					{ files: [...touchedFiles].slice(0, 100), outcome: lastOutcome },
					true,
				);
				if (!saved) return;
			}
			try {
				const events = readRecentLogbookEvents(projectRoot(ctx.cwd));
				ctx.ui.notify(
					events.length ? events.map(formatEvent).join("\n") : "O diário ainda não tem eventos registrados.",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Não foi possível ler o diário: ${message}`, "error");
			}
		},
	});
}
