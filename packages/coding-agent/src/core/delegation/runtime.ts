import { Buffer } from "node:buffer";
import type { AgentToolResult } from "@relay-harness/agent-core";
import type { Api, Model, Usage } from "@relay-harness/ai";
import type { AgentSession } from "../agent-session.ts";
import { createExtensionRuntime } from "../extensions/loader.ts";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import { SettingsManager } from "../settings-manager.ts";
import { combineUsage } from "../usage-totals.ts";
import { buildWorkerInstructions, type WorkerContext } from "./context.ts";
import {
	type ApprovedWorkPlan,
	validateApprovedWorkPlan,
	WORKER_CONTROL_TOOLS,
	type WorkerEvidence,
	type WorkerMetrics,
	type WorkerResult,
	type WorkResourceCatalog,
} from "./contracts.ts";

export interface WorkerRuntimeOptions {
	cwd: string;
	model: Model<Api>;
	modelRuntime: ModelRuntime;
	parent: ExtensionToolContext;
	plan: ApprovedWorkPlan;
	catalog: WorkResourceCatalog;
	context: WorkerContext;
	/** Reads the principal session's global mutation counter at observation time. */
	getWorkspaceRevision(): number;
	/** Revision recorded by the principal's preflight, after its own mutation accounting. */
	getToolRevision?(toolCallId: string): number | undefined;
	/** Called for every invocation, before the parent's validation/hooks/permissions. */
	checkCall(name: string, args: unknown): void | Promise<void>;
	/** Persist observations before returning the tool outcome to the worker. */
	onEvidence(evidence: WorkerEvidence, fullText: string): void | Promise<void>;
	onStarted?(instructions: ReturnType<typeof buildWorkerInstructions>): void | Promise<void>;
	/** Final observed metrics, including unsuccessful attempts; never a result or acceptance. */
	onFinished?(metrics: WorkerMetrics): void | Promise<void>;
	signal?: AbortSignal;
}

/** No discovery and no child extensions: delegation and session-control tools cannot be installed by a prompt. */
function workerResourceLoader(systemPrompt: string): ResourceLoader {
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {
			throw new Error("Worker resource discovery is disabled");
		},
		reload: async () => {},
	};
}

/** Separate SDK history with tool implementations replaced by calls into the principal Harness. */
export async function runWorker(options: WorkerRuntimeOptions): Promise<WorkerResult> {
	const startedAt = performance.now();
	const context = structuredClone(options.context);
	const parent = options.parent;
	validateApprovedWorkPlan(options.plan, options.catalog);
	const task = options.plan.proposal.tasks.find((task) => task.taskId === context.identity.taskId);
	const selection = options.plan.selections.find((selection) => selection.taskId === context.identity.taskId);
	if (
		context.identity.workflowId !== options.plan.proposal.workflowId ||
		context.identity.planVersion !== options.plan.proposal.version ||
		!Number.isInteger(context.identity.attempt) ||
		context.identity.attempt < 1 ||
		JSON.stringify(task) !== JSON.stringify(context.task) ||
		JSON.stringify(selection) !== JSON.stringify(context.selection)
	)
		throw new Error("Worker context does not match the approved plan");
	const evidence: WorkerEvidence[] = [];
	const observedChildCalls = new Set<string>();
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	let session: AgentSession | undefined;
	let limitError: string | undefined;
	let observationError: unknown;
	let steps = 0;
	let outputBytes = 0;
	let localCallCount = 0;
	const metrics = (): WorkerMetrics => {
		let usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		let toolUsage: Usage | undefined;
		for (const message of session?.messages ?? []) {
			if (message.role === "assistant") usage = combineUsage(usage, message.usage);
			else if (message.role === "toolResult" && message.usage)
				toolUsage = toolUsage ? combineUsage(toolUsage, message.usage) : message.usage;
		}
		return { usage, toolUsage, elapsedMs: performance.now() - startedAt, steps, outputBytes };
	};
	const enforce = (): void => {
		signal.throwIfAborted();
		if (++steps > context.task.limits.steps) {
			limitError = "Worker step limit exceeded";
			controller.abort();
			throw new Error(limitError);
		}
	};
	const tools: ToolDefinition[] = context.selection.tools.map((name) => {
		if (WORKER_CONTROL_TOOLS.includes(name)) throw new Error(`Worker control tool is forbidden: ${name}`);
		const tool = parent.tools.find((tool) => tool.name === name);
		if (!tool) throw new Error(`Worker tool is no longer callable: ${name}`);
		return {
			name,
			label: tool.label,
			description: tool.description,
			parameters: structuredClone(tool.parameters),
			executionMode: "sequential",
			execute: async (_id, args, childSignal, onUpdate) => {
				enforce();
				await options.checkCall(name, args);
				signal.throwIfAborted();
				const startedRevision = options.getWorkspaceRevision();
				const outcome = await parent.executeTool(name, args, {
					signal: childSignal ? AbortSignal.any([signal, childSignal]) : signal,
					onUpdate,
				});
				const text = outcome.result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const observed: WorkerEvidence = {
					...context.identity,
					id: `${context.identity.workerId}/${outcome.toolCall.id}`,
					toolCallId: outcome.toolCall.id,
					tool: name,
					command:
						args && typeof args === "object" && "command" in args && typeof args.command === "string"
							? args.command
							: undefined,
					isError: outcome.isError,
					text: Buffer.from(text).subarray(0, context.task.limits.outputBytes).toString("utf8"),
					// A concurrent mutation while a test runs cannot make that test fresh.
					workspaceRevision: options.getToolRevision?.(outcome.toolCall.id) ?? startedRevision,
				};
				observedChildCalls.add(_id);
				evidence.push(observed);
				try {
					await options.onEvidence(observed, text);
				} catch (error) {
					observationError = error;
					controller.abort();
					throw error;
				}
				outputBytes += Buffer.byteLength(JSON.stringify(outcome.result.content));
				if (outputBytes > context.task.limits.outputBytes) {
					limitError = "Worker output limit exceeded";
					controller.abort();
				}
				return { ...outcome.result, isError: outcome.isError };
			},
		};
	});
	const instructions = buildWorkerInstructions(
		context,
		tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
	);
	const timer = setTimeout(() => {
		limitError = "Worker duration limit exceeded";
		controller.abort();
	}, context.task.limits.durationMs);
	const abort = (): void => {
		session?.agent.abort();
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		const created = await createAgentSession({
			cwd: options.cwd,
			model: options.model,
			modelRuntime: options.modelRuntime,
			tools: context.selection.tools,
			customTools: tools,
			resourceLoader: workerResourceLoader(instructions.systemPrompt),
			sessionManager: SessionManager.inMemory(options.cwd),
			settingsManager: SettingsManager.inMemory({
				harnessCore: { evidence: false },
				compaction: { enabled: false },
				retry: { enabled: false },
				cacheWarming: "off",
			}),
		});
		session = created.session;
		signal.throwIfAborted();
		session.agent.subscribe(async (event) => {
			if (event.type !== "tool_execution_end") return;
			if (observedChildCalls.delete(event.toolCallId)) return;
			const result = event.result as AgentToolResult<unknown>;
			const text = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const observed: WorkerEvidence = {
				...context.identity,
				id: `${context.identity.workerId}/local/${++localCallCount}/${event.toolCallId}`,
				toolCallId: `${context.identity.workerId}/local/${localCallCount}/${event.toolCallId}`,
				tool: event.toolName,
				isError: true,
				text: Buffer.from(text).subarray(0, context.task.limits.outputBytes).toString("utf8"),
				workspaceRevision: options.getWorkspaceRevision(),
			};
			evidence.push(observed);
			try {
				await options.onEvidence(observed, text);
			} catch (error) {
				observationError = error;
				controller.abort();
			}
			outputBytes += Buffer.byteLength(JSON.stringify(result.content));
			if (outputBytes > context.task.limits.outputBytes) {
				limitError = "Worker output limit exceeded";
				controller.abort();
			}
		});
		session.subscribe((event) => {
			if (event.type === "turn_start") {
				try {
					enforce();
				} catch {
					abort();
				}
			}
			if ((event.type === "message_end" || event.type === "message_update") && event.message.role === "assistant") {
				const bytes = Buffer.byteLength(JSON.stringify(event.message.content));
				if (outputBytes + bytes > context.task.limits.outputBytes) {
					limitError = "Worker output limit exceeded";
					controller.abort();
				}
				if (event.type === "message_end") outputBytes += bytes;
			}
		});
		await options.onStarted?.(instructions);
		signal.throwIfAborted();
		await session.prompt(instructions.prompt);
		if (observationError) throw observationError;
		if (limitError) throw new Error(limitError);
		signal.throwIfAborted();
		const last = session.messages.findLast((message) => message.role === "assistant");
		if (last?.role === "assistant" && last.stopReason === "aborted")
			throw new DOMException(last.errorMessage ?? "Worker response interrupted", "AbortError");
		if (!last || last.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted")
			throw new Error(
				last?.role === "assistant" ? (last.errorMessage ?? last.stopReason) : "Worker returned no report",
			);
		return {
			...context.identity,
			summary: last.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
			limitations:
				evidence.some((item) => item.isError) ||
				session.messages.some((message) => message.role === "toolResult" && message.isError)
					? ["One or more observed tool calls failed"]
					: [],
			evidence,
			workspaceRevision: options.getWorkspaceRevision(),
			accepted: false,
			stale: false,
			...metrics(),
		};
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		try {
			await session?.abort();
			await options.onFinished?.(metrics());
		} finally {
			session?.dispose();
		}
	}
}
