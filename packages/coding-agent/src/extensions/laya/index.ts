import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type Api,
	type ClassifierModel,
	createProvider,
	type Message,
	type Model,
	type ModelThinkingLevel,
	type Provider,
} from "@relay-harness/ai";
import { typesafeSystemOneApi } from "@relay-harness/ai/api/typesafe-system-one.lazy";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { LayaSettings } from "../../core/settings-manager.ts";
import type { ModelRoute, ModelRouteRequest } from "../../core/virtual-models.ts";
import { assessmentFromAnswers, heuristicAssessment, type TaskAssessment } from "./assessment.ts";
import {
	buildLearnPrompt,
	exercisesToRows,
	LEARN_TOOL_NAME,
	learnToolSchema,
	renderQuestions,
	renderTask,
	type SessionTask,
	sessionTasks,
} from "./learn.ts";
import { LAYA_MODEL_MANIFEST } from "./model-manifest.ts";
import {
	applyPolicy,
	type Candidate,
	DEFAULT_MODEL_REGISTRY,
	type EscalationReason,
	nextTier,
	PerformanceHistory,
	POLICY_PROFILES,
	type PolicyDecision,
	type PolicyProfile,
	parseModelRef,
	QuotaManager,
	rankCandidates,
	type ScoredCandidate,
	taskKey,
} from "./policy.ts";
import { CAPABILITY_TIERS, type CapabilityTier, LAYA_QUESTIONS, layaDecisionsFile } from "./questions.ts";
import { LAYA_PLAN_MESSAGE, renderPlanMessage, selectSkills, unneededTools } from "./routers.ts";
import { layaPaths, setupLayaRuntime } from "./runtime.ts";
import { generateSeed } from "./seed.ts";
import { isLocalUrl, LayaServer } from "./server.ts";
import {
	datasetFromTelemetry,
	HARNESS_MESSAGE,
	historyFromTelemetry,
	summarizeRun,
	TelemetryStore,
	truncateRequest,
} from "./telemetry.ts";
import {
	accuracy,
	describeProgress,
	hasAccelerator,
	readRegistry,
	type Score,
	SESSION_SOURCE,
	sharedTrainer,
	type TrainingListener,
	type TrainingOutcome,
} from "./training.ts";

export { LAYA_PLAN_MESSAGE } from "./routers.ts";

export const LAYA_PROVIDER_ID = "laya";
export const LAYA_CLASSIFIER_ID = "execution-intelligence";
export const LAYA_VIRTUAL_MODEL_ID = "auto";
export const DEFAULT_LAYA_BASE_URL = "http://127.0.0.1:8000/v1";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MIN_CONFIDENCE = 0.5;
const DEFAULT_ESCALATE_AFTER_FAILURES = 3;
/** After a failed classifier call, keyword rules answer for this long before Laya is tried again. */
const LAYA_RETRY_AFTER_MS = 60_000;
const QUOTA_ERROR = /rate.?limit|\b429\b|overload|\b529\b|quota|capacity|too many requests|usage limit/i;

/** Router state stored on the session branch. */
export interface LayaRouterState {
	taskId: string;
	request: string;
	assessment: TaskAssessment;
	policy: PolicyDecision;
	profile: PolicyProfile;
	/** Tier and model currently handling the task. */
	tier: CapabilityTier;
	model: string;
	thinkingLevel: ModelThinkingLevel;
	/** Failed tool calls of the turn already answered by an escalation. */
	failuresAtEscalation: number;
	escalations: Array<{ reason: EscalationReason; from: CapabilityTier; to: CapabilityTier }>;
	attempts: number;
	/** Top-ranked alternatives at selection time, for `/laya`. */
	alternatives: string[];
}

const layaClassifier: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	id: LAYA_CLASSIFIER_ID,
	name: "Laya Execution Intelligence",
	api: "typesafe-system-one",
	provider: LAYA_PROVIDER_ID,
	baseUrl: DEFAULT_LAYA_BASE_URL,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
};

/**
 * The local Laya server speaks TypeSafe's System One protocol, so the built-in implementation serves
 * it. It needs no key; `LAYA_API_KEY` is sent when set, for servers that require one.
 */
function createLayaProvider(baseUrl: () => string | undefined): Provider {
	return createProvider({
		id: LAYA_PROVIDER_ID,
		name: "Laya",
		auth: {
			apiKey: {
				name: "Laya",
				resolve: async ({ ctx, credential }) => ({
					auth: {
						apiKey: credential?.key ?? (await ctx.env("LAYA_API_KEY")) ?? "local",
						baseUrl: baseUrl() ?? (await ctx.env("LAYA_BASE_URL")) ?? DEFAULT_LAYA_BASE_URL,
					},
					source: "Laya server",
				}),
			},
		},
		models: [layaClassifier],
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
	});
}

function messageText(message: Message): string {
	if (message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Index of the latest message the user wrote; harness and plan messages do not count. */
function lastUserIndex(messages: readonly Message[]): number {
	return messages.findLastIndex((message) => message.role === "user" && !HARNESS_MESSAGE.test(messageText(message)));
}

/** Failed tool calls and harness verification requests since the user's latest message. */
function failuresThisTurn(messages: readonly Message[]): { count: number; evidence: boolean } {
	let count = 0;
	let evidence = false;
	for (const message of messages.slice(lastUserIndex(messages) + 1)) {
		if (message.role === "toolResult" && message.isError) count++;
		if (message.role === "user" && messageText(message).startsWith("[harness:evidence]")) {
			count++;
			evidence = true;
		}
	}
	return { count, evidence };
}

const percent = (score: Score) => `${(accuracy(score) * 100).toFixed(1)}%`;

/** What a finished training changed, for the user. */
export function describeTrainingOutcome({ model, activated, previous }: TrainingOutcome): string {
	const session = `${model.session.candidate.correct} of ${model.session.candidate.n} answers on the session tasks right (${previous}: ${model.session.current.correct})`;
	const minutes = Math.max(1, Math.round(model.seconds / 60));
	return activated
		? `Laya learned ${model.sessionTasks} session tasks in about ${minutes} min: ${model.name} now routes requests. It gets ${session}; test ${percent(model.test.candidate)} (${previous}: ${percent(model.test.current)}).`
		: `Laya trained ${model.name}, but ${previous} keeps routing: the test score fell from ${percent(model.test.current)} to ${percent(model.test.candidate)}. It gets ${session}. /laya use ${model.name} activates it anyway.`;
}

export default function layaExtension(relay: ExtensionAPI): void {
	const quota = new QuotaManager();
	const layaHome = join(getAgentDir(), "laya");
	const store = new TelemetryStore(join(layaHome, "telemetry.jsonl"));
	const paths = layaPaths(layaHome, LAYA_MODEL_MANIFEST);
	const trainer = sharedTrainer({ home: layaHome, manifest: LAYA_MODEL_MANIFEST, paths });
	const server = new LayaServer({
		paths,
		manifest: LAYA_MODEL_MANIFEST,
		baseUrl: () => settings.baseUrl ?? process.env.LAYA_BASE_URL ?? DEFAULT_LAYA_BASE_URL,
		model: () => trainer.activeModel().dir,
	});
	let setupOffered = false;
	let setupRunning: Promise<void> | undefined;
	let history = new PerformanceHistory();
	let settings: LayaSettings = {};
	let profileOverride: PolicyProfile | undefined;
	let layaUnavailableUntil = 0;
	let lastClassifierError: string | undefined;
	/** Plan computed in before_agent_start for the prompt about to be sent. */
	let pending: { request: string; assessment: TaskAssessment } | undefined;
	/** Latest state returned by the router, and the run it belongs to. */
	let current: LayaRouterState | undefined;
	let run: { taskId: string; startedAt: number } | undefined;
	/** Tools active before enforced tool routing changed them. */
	let toolBaseline: { tools: string[]; applied: string[] } | undefined;
	/** Tasks `/laya learn` listed for the agent to label, numbered as the agent saw them. */
	let learnTasks: { tasks: SessionTask[]; session: string } | undefined;
	/** This runtime's training listener, while it is the latest one. */
	let listener: TrainingListener | undefined;

	const refreshSettings = () => {
		settings = relay.getSettings().laya ?? {};
		quota.configure(settings.quota);
	};
	const profile = (): PolicyProfile => {
		const flag = relay.getFlag("laya-policy");
		const fromFlag = POLICY_PROFILES.find((name) => name === flag);
		return profileOverride ?? fromFlag ?? settings.policy ?? "balanced";
	};
	const isSelected = (ctx: ExtensionContext) =>
		ctx.model?.provider === LAYA_PROVIDER_ID && ctx.model.id === LAYA_VIRTUAL_MODEL_ID;

	relay.registerFlag("laya-policy", {
		type: "string",
		description: "Cost profile of the laya/auto router: economy, balanced, quality or critical",
	});
	relay.registerProvider(createLayaProvider(() => settings.baseUrl));

	/** System 1: Laya's answers, or keyword rules when the server cannot answer. */
	async function assess(request: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<TaskAssessment> {
		const classifier = ctx.modelRegistry.findOfType("classifier", LAYA_PROVIDER_ID, LAYA_CLASSIFIER_ID);
		if (!classifier || Date.now() < layaUnavailableUntil) return heuristicAssessment(request);
		// Starts the local server when the runtime is installed; a failed start falls through to the
		// classifier call, which fails fast and lands on the keyword rules. Training has the GPU to itself.
		if (settings.autostart !== false && !trainer.running) await server.ensureRunning(signal);
		const result = await ctx.modelRegistry.classify(
			classifier,
			{ state: { request: truncateRequest(request) }, questions: LAYA_QUESTIONS },
			{ signal, timeoutMs: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxRetries: 0 },
		);
		try {
			if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? "Laya did not answer");
			const assessment = assessmentFromAnswers(result.answers);
			lastClassifierError = undefined;
			return assessment;
		} catch (error) {
			if (signal?.aborted) throw error;
			lastClassifierError = error instanceof Error ? error.message : String(error);
			layaUnavailableUntil = Date.now() + LAYA_RETRY_AFTER_MS;
			return heuristicAssessment(request);
		}
	}

	/** Model registry: configured models whose provider has credentials. */
	function candidates(ctx: ExtensionContext): Array<Candidate & { model: Model<Api> }> {
		const registry = { ...DEFAULT_MODEL_REGISTRY, ...settings.models };
		const result: Array<Candidate & { model: Model<Api> }> = [];
		for (const tier of CAPABILITY_TIERS) {
			for (const ref of registry[tier] ?? []) {
				const parsed = parseModelRef(ref);
				const model = parsed && ctx.modelRegistry.find(parsed.provider, parsed.id);
				if (!model || model.provider === LAYA_PROVIDER_ID || !ctx.modelRegistry.hasConfiguredAuth(model)) continue;
				result.push({ ref, provider: model.provider, tier, order: result.length, model });
			}
		}
		return result;
	}

	function rank(
		ctx: ExtensionContext,
		input: { assessment: TaskAssessment; requiredTier: CapabilityTier; minTier: CapabilityTier },
	): Array<ScoredCandidate & { model: Model<Api> }> {
		const available = candidates(ctx);
		if (available.length === 0) {
			throw new Error(
				"laya/auto: no model of the Laya model registry has credentials. Log in to a provider or set laya.models.",
			);
		}
		const byRef = new Map(available.map((candidate) => [candidate.ref, candidate.model]));
		const ranked = rankCandidates(available, {
			requiredTier: input.requiredTier,
			minTier: input.minTier,
			risk: input.assessment.task.risk,
			profile: profile(),
			taskKey: taskKey(input.assessment),
			history,
			quota,
		});
		// Every candidate is below the floor or out of quota: take the strongest one available.
		const fallback = [...available].sort(
			(a, b) => CAPABILITY_TIERS.indexOf(b.tier) - CAPABILITY_TIERS.indexOf(a.tier),
		);
		const list =
			ranked.length > 0
				? ranked
				: fallback.map((candidate) => ({
						...candidate,
						success: 0,
						cost: 0,
						latency: 0,
						utility: 0,
						eligible: false,
					}));
		return list.map((candidate) => ({ ...candidate, model: byRef.get(candidate.ref)! }));
	}

	function select(
		ctx: ExtensionContext,
		base: Omit<LayaRouterState, "tier" | "model" | "thinkingLevel" | "alternatives">,
		minTier: CapabilityTier,
		requiredTier: CapabilityTier,
	): { route: ModelRoute<LayaRouterState>; state: LayaRouterState } {
		const ranked = rank(ctx, { assessment: base.assessment, requiredTier, minTier });
		const chosen = ranked[0];
		const state: LayaRouterState = {
			...base,
			tier: chosen.tier,
			model: chosen.ref,
			thinkingLevel: base.policy.thinkingLevel,
			alternatives: ranked.slice(1, 4).map((candidate) => candidate.ref),
		};
		current = state;
		ctx.ui.setStatus(
			"laya",
			`laya ${profile()}: ${base.assessment.task.type} → ${chosen.tier} ${chosen.model.id} • ${state.thinkingLevel}${
				base.assessment.source === "heuristic" ? " (rules)" : ""
			}`,
		);
		return { route: { model: chosen.model, thinkingLevel: state.thinkingLevel, state }, state };
	}

	async function planTask(
		request: ModelRouteRequest<LayaRouterState>,
		ctx: ExtensionContext,
	): Promise<ModelRoute<LayaRouterState>> {
		const index = lastUserIndex(request.messages);
		const text = index >= 0 ? messageText(request.messages[index]) : "";
		const assessment =
			pending && pending.request === text ? pending.assessment : await assess(text, ctx, request.signal);
		pending = undefined;
		const policy = applyPolicy(assessment, text, {
			minConfidence: settings.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
		});
		const taskId = randomUUID();
		run = { taskId, startedAt: run?.startedAt ?? Date.now() };
		const escalations = policy.escalations.map((reason) => ({
			reason,
			from: policy.recommendedTier,
			to: policy.requiredTier,
		}));
		return select(
			ctx,
			{
				taskId,
				request: truncateRequest(text),
				assessment,
				policy,
				profile: profile(),
				failuresAtEscalation: 0,
				escalations,
				attempts: 1,
			},
			policy.minTier,
			policy.requiredTier,
		).route;
	}

	/** Moves the task one tier up, or to an equivalent model when the provider is out of quota. */
	function escalate(
		ctx: ExtensionContext,
		state: LayaRouterState,
		reason: EscalationReason,
		failures: number,
	): ModelRoute<LayaRouterState> | undefined {
		const sameTier = reason === "provider_unavailable";
		const target = sameTier ? state.tier : nextTier(state.tier);
		if (!target) return undefined;
		const { route } = select(
			ctx,
			{
				...state,
				failuresAtEscalation: failures,
				escalations: [...state.escalations, { reason, from: state.tier, to: target }],
				attempts: state.attempts + 1,
			},
			target,
			target,
		);
		return route;
	}

	function sticky(ctx: ExtensionContext, state: LayaRouterState): ModelRoute<LayaRouterState> {
		const parsed = parseModelRef(state.model);
		const model = parsed && ctx.modelRegistry.find(parsed.provider, parsed.id);
		if (!model) throw new Error(`laya/auto: routed model ${state.model} is no longer in the catalog`);
		current = state;
		return { model, thinkingLevel: state.thinkingLevel };
	}

	async function route(
		request: ModelRouteRequest<LayaRouterState>,
		ctx: ExtensionContext,
	): Promise<ModelRoute<LayaRouterState>> {
		const state = request.state;
		if (request.reason === "direct") {
			// Compaction summaries and extension calls: a balanced model without heavy reasoning.
			const ranked = rank(ctx, { assessment: heuristicAssessment(""), requiredTier: "balanced", minTier: "fast" });
			return { model: ranked[0].model, thinkingLevel: "low" };
		}
		if (request.reason === "user" || !state) return planTask(request, ctx);

		if (request.reason === "retry" && request.failed) {
			if (QUOTA_ERROR.test(request.failed.message.errorMessage ?? "")) {
				quota.recordPressure(request.failed.model.provider);
				const route = escalate(ctx, state, "provider_unavailable", state.failuresAtEscalation);
				if (route) return route;
			}
			return sticky(ctx, state);
		}

		const threshold = settings.escalateAfterFailures ?? DEFAULT_ESCALATE_AFTER_FAILURES;
		const failures = failuresThisTurn(request.messages);
		if (threshold > 0 && failures.count - state.failuresAtEscalation >= threshold) {
			const route = escalate(ctx, state, failures.evidence ? "test_failure" : "repeated_failure", failures.count);
			if (route) return route;
		}
		return sticky(ctx, state);
	}

	relay.registerVirtualModel<LayaRouterState>({
		provider: LAYA_PROVIDER_ID,
		id: LAYA_VIRTUAL_MODEL_ID,
		name: "Auto (Laya)",
		route,
	});

	/** Installs the Python environment and downloads the trained model. Concurrent calls share one run. */
	function setupRuntime(ctx: ExtensionContext): Promise<void> {
		setupRunning ??= (async () => {
			try {
				await setupLayaRuntime({
					exec: (command, args, options) => relay.exec(command, args, options),
					home: layaHome,
					manifest: LAYA_MODEL_MANIFEST,
					python: settings.python,
					signal: ctx.signal,
					report: (message) => ctx.ui.setStatus("laya-setup", `laya setup: ${message}`),
				});
				ctx.ui.notify("Laya is installed. Starting the server on the next request.");
			} catch (error) {
				ctx.ui.notify(`Laya setup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				ctx.ui.setStatus("laya-setup", undefined);
				setupRunning = undefined;
			}
		})();
		return setupRunning;
	}

	/** Capability tier of a `provider/model` in the Laya model registry. */
	const tierOf = (ref: string): CapabilityTier | undefined => {
		const registry = { ...DEFAULT_MODEL_REGISTRY, ...settings.models };
		return CAPABILITY_TIERS.find((tier) => registry[tier]?.includes(ref));
	};

	/**
	 * Starts training on the collected exercises. It runs in the background in interactive modes and
	 * reports through the listener; print and JSON mode wait for it, since the process ends with the turn.
	 */
	async function startTraining(ctx: ExtensionContext): Promise<string> {
		if (trainer.running) return "Laya is already training; run /laya train after it ends to include these tasks.";
		if (server.status() === "missing-environment") {
			return "Laya is not installed, so it cannot train yet. Run /laya setup, then /laya train.";
		}
		if (!(await hasAccelerator((command, args, options) => relay.exec(command, args, options)))) {
			const accepted =
				!ctx.hasUI ||
				(await ctx.ui.confirm(
					"Train Laya on the CPU?",
					"This computer has no GPU Laya can use. Training still works, but can take an hour or more. Keyword rules route requests meanwhile.",
				));
			if (!accepted) return "Training was not started. Run /laya train when you want it.";
		}
		// Training needs the GPU memory the server holds; keyword rules route until it ends.
		server.stop();
		const job = trainer.train();
		if (ctx.mode === "print" || ctx.mode === "json") {
			try {
				return describeTrainingOutcome(await job);
			} catch (error) {
				return `Laya training failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		// The listener reports the result.
		job.catch(() => {});
		return "Laya is training in the background (a few minutes with a GPU). Keyword rules route requests until it ends; then the new model routes them if it passes the test.";
	}

	relay.on("session_start", (_event, ctx) => {
		refreshSettings();
		history = settings.telemetry === false ? new PerformanceHistory() : historyFromTelemetry(store.read());
		listener = {
			progress: (progress) => ctx.ui.setStatus("laya-train", `laya training: ${describeProgress(progress)}`),
			finished: (result) => {
				ctx.ui.setStatus("laya-train", undefined);
				if ("error" in result) {
					ctx.ui.notify(`Laya training failed: ${result.error.message}`, "error");
					return;
				}
				// A server still running here serves the previous model.
				if (result.outcome.activated) server.stop();
				ctx.ui.notify(describeTrainingOutcome(result.outcome), result.outcome.activated ? "info" : "warning");
			},
		};
		trainer.listener = listener;
	});

	relay.registerTool<typeof learnToolSchema, { added: number; updated: number; training?: string }>({
		name: LEARN_TOOL_NAME,
		label: "Laya learn",
		description:
			"Save labeled tasks of this session as training exercises for Laya, Relay's routing model, and train it so similar requests get the right model, effort and tools. Use after /laya learn lists the tasks, or when the user asks Relay to learn from this session or conversation.",
		parameters: learnToolSchema,
		// Loaded by /laya learn, or found by tool search when the user asks in their own words.
		exposure: "deferred",
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!learnTasks) {
				// Called without /laya learn: number this session's tasks and ask for labels against them.
				const tasks = sessionTasks(ctx.sessionManager.getBranch(), tierOf);
				learnTasks = { tasks, session: ctx.sessionManager.getSessionId() };
				throw new Error(
					[
						`Nothing was saved: label these tasks of the session by their numbers, then call ${LEARN_TOOL_NAME} again. Leave out entries that are not coding tasks, such as this request to learn.`,
						`Questions:\n${renderQuestions()}`,
						...tasks.map(renderTask),
					].join("\n\n"),
				);
			}
			const rows = exercisesToRows(learnTasks.tasks, params.exercises, {
				session: learnTasks.session,
				created: new Date().toISOString(),
			});
			const { added, updated } = trainer.addExercises(rows);
			learnTasks = undefined;
			const sessionRows = trainer.counts()[SESSION_SOURCE] ?? 0;
			const saved = `Saved ${rows.length} exercises (${added} new, ${updated} updated); ${sessionRows} session tasks in total, in ${trainer.workspace.dataset}.`;
			const training =
				params.train === false ? "Training was not started (run /laya train)." : await startTraining(ctx);
			return { content: [{ type: "text", text: `${saved} ${training}` }], details: { added, updated, training } };
		},
	});

	/** The user's own tool set: the active tools, or the set enforcement replaced while it is unchanged. */
	const userTools = (): string[] => {
		const active = relay.getActiveTools();
		const applied = toolBaseline?.applied;
		const unchanged = applied && active.length === applied.length && active.every((name, i) => name === applied[i]);
		return unchanged && toolBaseline ? toolBaseline.tools : active;
	};

	relay.on("before_agent_start", async (event, ctx) => {
		refreshSettings();
		const enforce = isSelected(ctx) && settings.toolRouting === "enforce";
		// Enforcement is off or another model is selected: give the user's tools back.
		if (toolBaseline && !enforce) {
			relay.setActiveTools(userTools());
			toolBaseline = undefined;
		}
		if (!isSelected(ctx)) return;
		// First use: offer to install the trained Laya once per session. Without it, keyword rules route.
		if (
			settings.autostart !== false &&
			!setupOffered &&
			ctx.hasUI &&
			server.status() !== "ready" &&
			isLocalUrl(settings.baseUrl ?? process.env.LAYA_BASE_URL ?? DEFAULT_LAYA_BASE_URL) &&
			!(await server.isUp())
		) {
			setupOffered = true;
			const accepted = await ctx.ui.confirm(
				"Install Laya?",
				"laya/auto routes with a trained Laya model. This downloads about 680 MB of model and a Python environment (a few GB, including torch) into ~/.relay/agent/laya. Until then, keyword rules route requests.",
			);
			if (accepted) await setupRuntime(ctx);
		}
		const assessment = await assess(event.prompt, ctx, ctx.signal);
		pending = { request: event.prompt, assessment };
		const policy = applyPolicy(assessment, event.prompt, {
			minConfidence: settings.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
		});
		const skills = selectSkills(event.systemPromptOptions.skills, assessment.agent, event.prompt);

		let deactivated: string[] = [];
		if (enforce) {
			const baseline = userTools();
			deactivated = unneededTools(baseline, assessment.tools);
			const applied = baseline.filter((name) => !deactivated.includes(name));
			toolBaseline = { tools: baseline, applied };
			relay.setActiveTools(applied);
		}
		return {
			message: {
				customType: LAYA_PLAN_MESSAGE,
				content: renderPlanMessage(assessment, policy, skills, deactivated),
				display: false,
				details: { assessment, policy, skills, deactivated },
			},
		};
	});

	relay.on("session_shutdown", (event) => {
		server.stop();
		if (trainer.listener === listener) trainer.listener = undefined;
		// Training belongs to the process: it goes on into the next session, and stops when Relay quits.
		if (event.reason === "quit") trainer.stop();
	});

	relay.on("agent_start", () => {
		run = undefined;
	});

	relay.on("agent_end", (event, ctx) => {
		const state = current;
		if (!isSelected(ctx) || !state || !run || run.taskId !== state.taskId) return;
		const summary = summarizeRun(event.messages);
		const success = summary.outcome === "completed" && summary.testsPassed !== false;
		const [provider, ...rest] = state.model.split("/");
		if (summary.outcome !== "aborted") history.record(taskKey(state.assessment), state.model, success);
		if (settings.telemetry === false) return;
		try {
			store.append({
				task_id: state.taskId,
				timestamp: new Date().toISOString(),
				request: state.request,
				classification: {
					source: state.assessment.source,
					...state.assessment.task,
					agent: state.assessment.agent,
					validation: state.assessment.validation,
					confidence: Number(state.assessment.confidence.toFixed(3)),
					recommended_tier: state.assessment.recommendation.tier,
					recommended_effort: state.assessment.recommendation.effort,
				},
				policy: { profile: state.profile, required_tier: state.policy.requiredTier, rules: state.policy.rules },
				selected: { provider, model: rest.join("/"), tier: state.tier, thinking_level: state.thinkingLevel },
				result: {
					success,
					outcome: summary.outcome,
					attempts: state.attempts,
					escalations: state.escalations,
					tests_passed: summary.testsPassed,
					tool_failures: summary.toolFailures,
				},
				usage: {
					tokens: summary.tokens,
					cost: Number(summary.cost.toFixed(6)),
					duration_ms: Date.now() - run.startedAt,
					models: summary.models,
				},
			});
		} catch (error) {
			ctx.ui.notify(
				`Laya telemetry not written: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});

	const writeJson = (path: string, content: string) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
	};

	relay.registerCommand("laya", {
		description: "Laya execution router: status, setup, learn from sessions, train, models, policy",
		getArgumentCompletions: (prefix) =>
			[
				"status",
				"setup",
				"start",
				"stop",
				"learn",
				"train",
				"models",
				"use ",
				"policy ",
				"decisions",
				"seed",
				"export",
			]
				.filter((item) => item.startsWith(prefix))
				.map((item) => ({ value: item, label: item.trim() })),
		handler: async (args, ctx) => {
			refreshSettings();
			const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const layaDir = resolve(ctx.cwd, ".laya");
			switch (subcommand) {
				case "policy": {
					const name = POLICY_PROFILES.find((value) => value === rest[0]);
					if (!name) {
						ctx.ui.notify(`Usage: /laya policy ${POLICY_PROFILES.join("|")} (current: ${profile()})`, "warning");
						return;
					}
					profileOverride = name;
					ctx.ui.notify(`Laya cost profile for this session: ${name}`);
					return;
				}
				case "decisions": {
					const path = resolve(ctx.cwd, rest[0] ?? join(layaDir, "decisions.json"));
					writeJson(path, `${JSON.stringify(layaDecisionsFile(), null, 2)}\n`);
					ctx.ui.notify(`Wrote the Laya questions to ${path}`);
					return;
				}
				case "seed": {
					const count = Number(rest[0] ?? 1100);
					if (!Number.isInteger(count) || count <= 0) {
						ctx.ui.notify("Usage: /laya seed [count] [path]", "warning");
						return;
					}
					const path = resolve(ctx.cwd, rest[1] ?? join(layaDir, "data", "relay-seed.jsonl"));
					const rows = generateSeed(count);
					writeJson(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
					ctx.ui.notify(`Wrote ${rows.length} synthetic exercises to ${path}`);
					return;
				}
				case "export": {
					const path = resolve(ctx.cwd, rest[0] ?? join(layaDir, "data", "relay-telemetry.jsonl"));
					const rows = datasetFromTelemetry(store.read(Number.MAX_SAFE_INTEGER));
					writeJson(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
					ctx.ui.notify(`Exported ${rows.length} evidence-labeled exercises to ${path}`);
					return;
				}
				case "learn": {
					const file = rest.join(" ");
					let entries = ctx.sessionManager.getBranch();
					let session = ctx.sessionManager.getSessionId();
					if (file) {
						const path = resolve(ctx.cwd, file);
						if (!existsSync(path)) {
							ctx.ui.notify(`No session file at ${path}`, "warning");
							return;
						}
						const manager = SessionManager.open(path);
						entries = manager.getBranch();
						session = manager.getSessionId();
					}
					const tasks = sessionTasks(entries, tierOf);
					if (tasks.length === 0) {
						ctx.ui.notify("The session has no requests to learn from yet.", "warning");
						return;
					}
					learnTasks = { tasks, session };
					const active = relay.getActiveTools();
					if (!active.includes(LEARN_TOOL_NAME)) relay.setActiveTools([...active, LEARN_TOOL_NAME]);
					const prompt = buildLearnPrompt(tasks, { source: file ? resolve(ctx.cwd, file) : undefined });
					if (ctx.isIdle()) relay.sendUserMessage(prompt);
					else relay.sendUserMessage(prompt, { deliverAs: "followUp" });
					return;
				}
				case "train": {
					ctx.ui.notify(await startTraining(ctx));
					return;
				}
				case "models": {
					const active = trainer.activeModel().name;
					const registry = readRegistry(trainer.workspace);
					const mark = (name: string) => (name === active ? " (routing)" : "");
					const lines = [`${LAYA_MODEL_MANIFEST.version}: shipped with Relay${mark(LAYA_MODEL_MANIFEST.version)}`];
					for (const model of registry.models) {
						lines.push(
							`${model.name}: ${model.createdAt.slice(0, 16).replace("T", " ")}, from ${model.basedOn}, ${model.sessionTasks} session tasks, test ${percent(model.test.candidate)} (${model.basedOn}: ${percent(model.test.current)}), session answers ${model.session.candidate.correct}/${model.session.candidate.n}${mark(model.name)}`,
						);
					}
					const counts = trainer.counts();
					lines.push(
						`Exercises: ${
							Object.entries(counts)
								.map(([source, count]) => `${count} ${source}`)
								.join(", ") || "none yet"
						} (${trainer.workspace.dataset})`,
					);
					if (trainer.running) {
						lines.push(`Training: ${trainer.progress ? describeProgress(trainer.progress) : "starting"}`);
					}
					ctx.ui.notify(lines.join("\n"));
					return;
				}
				case "use": {
					const name = rest[0];
					if (!name) {
						ctx.ui.notify(
							`Usage: /laya use <model> (current: ${trainer.activeModel().name}; see /laya models)`,
							"warning",
						);
						return;
					}
					try {
						trainer.use(name);
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
						return;
					}
					// The next request starts the server with the selected model.
					server.stop();
					ctx.ui.notify(`${trainer.activeModel().name} routes requests from the next one`);
					return;
				}
				case "setup": {
					await setupRuntime(ctx);
					return;
				}
				case "start": {
					ctx.ui.notify(
						(await server.ensureRunning(ctx.signal))
							? "Laya server is running"
							: "Laya server did not start (see /laya status)",
						"info",
					);
					return;
				}
				case "stop": {
					server.stop();
					ctx.ui.notify("Stopped the Laya server this session started");
					return;
				}
				case "status": {
					const providers = new Set(candidates(ctx).map((candidate) => candidate.provider));
					const lines = [
						`Profile: ${profile()}${isSelected(ctx) ? "" : " (select laya/auto to route with Laya)"}`,
						`Laya runtime: ${server.status()}${server.status() === "ready" ? "" : " (run /laya setup)"}; server ${(await server.isUp()) ? "answering" : "not answering"}`,
						`Laya server: ${lastClassifierError ? `unavailable, using keyword rules (${lastClassifierError})` : "ok or not yet asked"}`,
						`Models with credentials: ${
							candidates(ctx)
								.map((candidate) => `${candidate.tier}:${candidate.ref}`)
								.join(", ") || "none"
						}`,
						`Quota: ${
							Object.entries(quota.snapshot(providers))
								.map(([name, value]) => `${name} ${value}`)
								.join(", ") || "none"
						}`,
						`Routing model: ${trainer.activeModel().name}${
							trainer.running
								? `; training ${trainer.progress ? describeProgress(trainer.progress) : "starting"}`
								: ""
						}`,
						`Telemetry: ${settings.telemetry === false ? "off" : store.path}`,
					];
					if (current) {
						lines.push(
							`Last plan: ${current.assessment.task.type} (${current.assessment.source}, confidence ${current.assessment.confidence.toFixed(2)}), recommended ${current.policy.recommendedTier}/${current.assessment.recommendation.effort}, routed ${current.tier} ${current.model} • ${current.thinkingLevel}`,
							`Alternatives: ${current.alternatives.join(", ") || "none"}`,
						);
						if (current.escalations.length > 0) {
							lines.push(
								`Escalations: ${current.escalations.map((e) => `${e.reason} ${e.from}→${e.to}`).join(", ")}`,
							);
						}
					}
					ctx.ui.notify(lines.join("\n"));
					return;
				}
				default:
					ctx.ui.notify(
						"Usage: /laya [status|setup|start|stop|learn [session file]|train|models|use <model>|policy <profile>|decisions [path]|seed [count] [path]|export [path]]",
						"warning",
					);
			}
		},
	});
}
