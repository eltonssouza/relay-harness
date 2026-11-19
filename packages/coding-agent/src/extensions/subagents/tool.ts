/**
 * The `agent` tool: delegate a task to a subagent that runs in this process, as its own session
 * with its own tools, model and harness. The schema is Claude Code's (`subagent_type`,
 * `description`, `prompt`), so orchestrator prompts written for Claude Code work unchanged.
 *
 * The harness sees through the delegation:
 * - the brief enters the child with origin `agent`, so it authorizes nothing and states no
 *   constraint; the developer's constraints are handed to the child explicitly;
 * - the child asks for authorization through the parent's UI, prefixed with the agent's name;
 * - the child's tool calls are reported to the parent's evidence, so a delegated edit without a
 *   check is gated when the parent reports completion.
 */

import type { DelegatedOutcome } from "@relay-harness/agent-core";
import { type Api, contentText, type JsonObject, type Model, type Usage } from "@relay-harness/ai";
import { Type } from "typebox";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { createExtensionRuntime } from "../../core/extensions/loader.ts";
import { defineTool, type ExtensionToolContext, type ExtensionUIContext } from "../../core/extensions/types.ts";
import { parseModelRef, resolveTier } from "../../core/model-tiers.ts";
import type { ResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { type Settings, SettingsManager } from "../../core/settings-manager.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { type AgentCatalog, type AgentDefinition, agentPrompt } from "./definitions.ts";

export interface SubagentLimits {
	/** Sessions in a delegation chain, the developer's included: 3 allows main, orchestrator and specialist. */
	maxDepth: number;
	/** Subagents running at once in one chain. */
	maxConcurrency: number;
	/** Tokens one subagent may spend before it is stopped. */
	maxTokens: number;
	/** Milliseconds one subagent may run before it is stopped. */
	timeoutMs: number;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
	maxDepth: 3,
	maxConcurrency: 4,
	maxTokens: 400_000,
	timeoutMs: 20 * 60_000,
};

export interface AgentToolOptions {
	/** Depth of the session that owns the tool: 1 for the developer's session. */
	depth: number;
	limits: SubagentLimits;
	/** Agent definitions available to the session. */
	catalog: (ctx: ExtensionToolContext) => AgentCatalog;
	/** Settings the subagent inherits: harness, model tiers, shell. */
	settings: () => Settings;
	/** Shared by every session of one chain, so `maxConcurrency` holds across levels. */
	limiter: Limiter;
	/** Receives the outcomes of the subagents this tool ran, so an outer delegation sees them too. */
	onDelegated?: (outcomes: readonly DelegatedOutcome[]) => void;
}

export interface AgentToolDetails {
	agent: string;
	model?: string;
	status: "completed" | "failed" | "aborted" | "over-budget" | "timed-out";
	toolCalls: number;
	tokens: number;
}

/** Counts running subagents and queues the rest. */
export class Limiter {
	private readonly max: () => number;
	private active = 0;
	private readonly waiting: Array<() => void> = [];

	constructor(max: () => number) {
		this.max = max;
	}

	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.active >= Math.max(1, this.max())) await new Promise<void>((resolve) => this.waiting.push(resolve));
		this.active++;
		try {
			return await task();
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}
}

const AgentParams = Type.Object({
	description: Type.String({ description: "A short (3-5 word) description of the task" }),
	prompt: Type.String({ description: "The task for the agent to perform" }),
	subagent_type: Type.String({ description: "The type of specialized agent to use for this task" }),
});

/** No discovery and no extensions: a subagent gets only the tools its definition names. */
function subagentResourceLoader(systemPrompt: string): ResourceLoader {
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
			throw new Error("Subagent resource discovery is disabled");
		},
		reload: async () => {},
	};
}

/** The parent's UI, with the agent's name on every question and notice. */
function prefixedUI(ui: ExtensionUIContext, name: string): ExtensionUIContext {
	return new Proxy(ui, {
		get(target, key) {
			if (key === "confirm") {
				return (title: string, message: string, options?: unknown) =>
					target.confirm(`[${name}] ${title}`, message, options as Parameters<ExtensionUIContext["confirm"]>[2]);
			}
			if (key === "notify") {
				return (message: string, type?: Parameters<ExtensionUIContext["notify"]>[1]) =>
					target.notify(`[${name}] ${message}`, type);
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** The model a definition asks for, falling back to the session's model. */
function subagentModel(
	definition: AgentDefinition,
	ctx: ExtensionToolContext,
	settings: Settings,
): Model<Api> | undefined {
	const current = ctx.model;
	const catalog = ctx.modelRegistry.getAll();
	const choice = definition.model;
	if (choice.kind === "inherit") return current;
	if (choice.kind === "tier") {
		return resolveTier(choice.tier, {
			configured: settings.modelTiers,
			catalog,
			isAvailable: (model) => ctx.modelRegistry.hasConfiguredAuth(model),
			current,
		});
	}
	const parsed = parseModelRef(choice.ref);
	const named = parsed
		? ctx.modelRegistry.find(parsed.provider, parsed.id)
		: (catalog.find((model) => model.provider === current?.provider && model.id === choice.ref) ??
			catalog.find((model) => model.id === choice.ref));
	return named ?? current;
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function text(value: string): { type: "text"; text: string } {
	return { type: "text", text: value };
}

async function runSubagent(
	definition: AgentDefinition,
	brief: string,
	options: AgentToolOptions,
	ctx: ExtensionToolContext,
	signal: AbortSignal | undefined,
	onProgress: (line: string) => void,
): Promise<{ output: string; usage: Usage; details: AgentToolDetails; outcomes: DelegatedOutcome[] }> {
	const settings = options.settings();
	const model = subagentModel(definition, ctx, settings);
	if (!model) throw new Error("no model is selected");
	const delegates = definition.tools.includes("agent") && options.depth + 1 < options.limits.maxDepth;
	const outcomes: DelegatedOutcome[] = [];
	const customTools = delegates
		? [agentTool({ ...options, depth: options.depth + 1, onDelegated: (nested) => outcomes.push(...nested) })]
		: [];
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		model,
		modelRuntime: ctx.modelRegistry.modelRuntime,
		tools: [...definition.tools.filter((tool) => tool !== "agent"), ...(delegates ? ["agent"] : [])],
		customTools,
		resourceLoader: subagentResourceLoader(`${agentPrompt(definition)}\n\nWorking directory: ${ctx.cwd}`),
		sessionManager: SessionManager.inMemory(ctx.cwd),
		settingsManager: SettingsManager.inMemory({
			// The parent's evidence judges the delegated work; the child does not gate itself.
			harnessCore: { ...settings.harnessCore, evidence: false },
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
			...(settings.shellPath ? { shellPath: settings.shellPath } : {}),
			...(settings.shellCommandPrefix ? { shellCommandPrefix: settings.shellCommandPrefix } : {}),
			...(settings.modelTiers ? { modelTiers: settings.modelTiers } : {}),
		}),
	});
	const details: AgentToolDetails = {
		agent: definition.name,
		model: `${model.provider}/${model.id}`,
		status: "completed",
		toolCalls: 0,
		tokens: 0,
	};
	const harness = session.harnessCore.core;
	harness.engine.restoreLearnings(ctx.harnessConstraints(), []);
	if (ctx.hasUI) await session.bindExtensions({ uiContext: prefixedUI(ctx.ui, definition.name), mode: ctx.mode });

	const calls = new Map<string, { name: string; args: JsonObject }>();
	const stop = (status: AgentToolDetails["status"]) => {
		if (details.status === "completed") details.status = status;
		void session.abort();
	};
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "tool_execution_start") {
			calls.set(event.toolCallId, { name: event.toolName, args: (event.args ?? {}) as JsonObject });
			details.toolCalls++;
			onProgress(`${definition.name}: ${event.toolName}`);
		} else if (event.type === "tool_execution_end") {
			const call = calls.get(event.toolCallId);
			calls.delete(event.toolCallId);
			if (!call) return;
			const effect = harness.classify({
				type: "toolCall",
				id: event.toolCallId,
				name: call.name,
				arguments: call.args,
			});
			const content = (event.result as { content?: Parameters<typeof contentText>[0] } | undefined)?.content;
			outcomes.push({ effect, isError: event.isError, output: content ? contentText(content) : "" });
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			details.tokens += event.message.usage?.totalTokens ?? 0;
			if (details.tokens > options.limits.maxTokens) stop("over-budget");
		}
	});
	const timer = setTimeout(() => stop("timed-out"), options.limits.timeoutMs);
	const onAbort = () => stop("aborted");
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		if (signal?.aborted) stop("aborted");
		else await session.prompt(brief, { source: "agent", expandPromptTemplates: false });
		const last = session.messages.findLast((message) => message.role === "assistant");
		if (details.status === "completed" && last?.role === "assistant") {
			if (last.stopReason === "error") details.status = "failed";
			if (last.stopReason === "aborted") details.status = "aborted";
		}
		const output =
			last?.role === "assistant"
				? last.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n")
						.trim()
				: "";
		let usage = ZERO_USAGE;
		for (const message of session.messages) {
			if ((message.role === "assistant" || message.role === "toolResult") && message.usage) {
				usage = combineUsage(usage, message.usage);
			}
		}
		return { output: output || last?.errorMessage || "", usage, details, outcomes };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		await session.abort();
		session.dispose();
		// Even a stopped subagent may have changed files: the parent's evidence must see it.
		ctx.recordDelegatedEffects(outcomes);
		options.onDelegated?.(outcomes);
	}
}

/** The `agent` tool for a session at `options.depth`. */
export function agentTool(options: AgentToolOptions) {
	return defineTool<typeof AgentParams, AgentToolDetails | undefined>({
		name: "agent",
		label: "Agent",
		description:
			"Delegate a task to a specialist subagent. It runs with its own tools and model, sees only the prompt you give it, and returns its final report. Give it a complete brief: the goal, the files involved, and what done looks like. Its edits and checks count as yours: verify before reporting completion.",
		parameters: AgentParams,
		// Declared to the model only where agent definitions exist; the extension activates it.
		defaultActive: false,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const catalog = options.catalog(ctx);
			const definition = catalog.agents.find((agent) => agent.name === params.subagent_type);
			if (!definition) {
				const names = catalog.agents.map((agent) => agent.name).join(", ") || "none installed";
				return {
					content: [text(`Unknown subagent_type "${params.subagent_type}". Available agents: ${names}.`)],
					details: undefined,
					isError: true,
				};
			}
			try {
				const result = await options.limiter.run(() =>
					runSubagent(definition, params.prompt, options, ctx, signal, (line) =>
						onUpdate?.({ content: [text(line)], details: undefined }),
					),
				);
				const failed = result.details.status !== "completed";
				const report = result.output || "(the agent returned no report)";
				return {
					content: [text(failed ? `${definition.name} stopped (${result.details.status}).\n\n${report}` : report)],
					details: result.details,
					usage: result.usage,
					...(failed ? { isError: true } : {}),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [text(`${definition.name} could not start: ${message}`)],
					details: undefined,
					isError: true,
				};
			}
		},
	});
}
