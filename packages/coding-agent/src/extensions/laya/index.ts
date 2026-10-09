import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type Api,
	type ClassifierModel,
	clampThinkingLevel,
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
import { isVirtualModel } from "../../core/virtual-models.ts";
import { loadAgentProfile } from "../engineering/index.ts";
import { assessmentFromAnswers, assessmentFromLabels, heuristicAssessment, type TaskAssessment } from "./assessment.ts";
import { type DockerRun, spawnDocker } from "./docker.ts";
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
import { LAYA_LESSONS_MESSAGE, LESSON_SIMILARITY, ROUTE_SIMILARITY, renderLessons, TaskMemory } from "./memory.ts";
import { LAYA_MODEL_MANIFEST } from "./model-manifest.ts";
import {
	applyPolicy,
	type Candidate,
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
import { scopedModelRegistry } from "./provider-scope.ts";
import { CAPABILITY_TIERS, type CapabilityTier, LAYA_QUESTIONS, layaDecisionsFile } from "./questions.ts";
import { LAYA_PLAN_MESSAGE, renderPlanMessage, selectSkills, unneededTools } from "./routers.ts";
import { type LayaImageVariant, layaImage } from "./runtime.ts";
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
import { evaluateToolRetrieval, retrieveTools } from "./tool-retrieval.ts";
import {
	accuracy,
	describeProgress,
	dockerHasGpu,
	readRegistry,
	readRows,
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
/** Not 8000, the port laya-trainer's own server and many development servers use. */
export const DEFAULT_LAYA_BASE_URL = "http://127.0.0.1:8737/v1";

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
	/** False for a selected model whose capability has not been mapped to a tier. */
	capabilityKnown?: boolean;
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

export interface LayaExtensionOptions {
	/** Docker CLI runner. Default: the `docker` command. */
	docker?: DockerRun;
}

/** Files of the Python runtime Relay used to install on the host, before Laya moved to Docker. */
const HOST_RUNTIME_LEFTOVERS = ["venv", "models", "serve.py", "train.py", "server.log"];

export default function layaExtension(relay: ExtensionAPI, options: LayaExtensionOptions = {}): void {
	const quota = new QuotaManager();
	const docker = options.docker ?? spawnDocker;
	const layaHome = join(getAgentDir(), "laya");
	const store = new TelemetryStore(join(layaHome, "telemetry.jsonl"));
	const baseUrl = () => settings.baseUrl ?? process.env.LAYA_BASE_URL ?? DEFAULT_LAYA_BASE_URL;
	let variant: Promise<LayaImageVariant> | undefined;
	let gpu: Promise<boolean> | undefined;
	/** The CUDA image where an NVIDIA GPU exists, the smaller CPU image otherwise. */
	const hostVariant = async (): Promise<LayaImageVariant> => {
		if (process.platform === "darwin") return "cpu";
		try {
			return (await relay.exec("nvidia-smi", ["-L"], { timeout: 10_000 })).code === 0 ? "cuda" : "cpu";
		} catch {
			return "cpu";
		}
	};
	const imageVariant = () => {
		variant ??= hostVariant();
		return variant;
	};
	const image = async () => settings.image ?? layaImage(LAYA_MODEL_MANIFEST, await imageVariant());
	const trainingGpu = () => {
		gpu ??= (async () => (await imageVariant()) === "cuda" && dockerHasGpu(docker, await image()))();
		return gpu;
	};
	const trainer = sharedTrainer({ home: layaHome, manifest: LAYA_MODEL_MANIFEST, docker, image, gpu: trainingGpu });
	const server = new LayaServer({ docker, baseUrl, image, model: () => trainer.activeModel().dir });
	/** Server problem last reported, so a failing Docker is not reported on every start. */
	let reportedProblem: string | undefined;
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
	let retrievedTools: { before: string[]; applied: string[] } | undefined;
	let retrievalTelemetry: { candidateCount: number; retrievedNames: string[] } | undefined;
	/** Tasks `/laya learn` listed for the agent to label, numbered as the agent saw them. */
	let learnTasks: { tasks: SessionTask[]; session: string } | undefined;
	/** This runtime's training listener, while it is the latest one. */
	let listener: TrainingListener | undefined;
	let memoryCache: { version: string; memory: TaskMemory } | undefined;

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
	/** Read explicit selections, not the physical replies of the router; branch/resume restores the scope. */
	const selectedModel = (ctx: ExtensionContext): Model<Api> | undefined => {
		if (ctx.model && !isVirtualModel(ctx.model)) return ctx.model;
		for (const entry of ctx.sessionManager.getBranch().toReversed()) {
			if (entry.type === "custom" && entry.customType === "laya.selected-model") {
				const selected = entry.data as { provider?: string; id?: string } | undefined;
				const model = selected?.provider && selected.id && ctx.modelRegistry.find(selected.provider, selected.id);
				if (model && !isVirtualModel(model)) return model;
			}
			if (entry.type !== "model_change" || entry.provider === LAYA_PROVIDER_ID) continue;
			const model = ctx.modelRegistry.find(entry.provider, entry.modelId);
			if (model && !isVirtualModel(model)) return model;
		}
		return undefined;
	};

	relay.registerFlag("laya-policy", {
		type: "string",
		description: "Cost profile of the laya/auto router: economy, balanced, quality or critical",
	});
	relay.registerProvider(createLayaProvider(() => settings.baseUrl));

	/** System 1: Laya's answers, or keyword rules when the server cannot answer. */
	/** Learned tasks, reloaded when the training dataset changes. Undefined when off or empty. */
	function memory(): TaskMemory | undefined {
		if (settings.memory === false) return undefined;
		let version: string;
		try {
			const stat = statSync(trainer.workspace.dataset);
			version = `${stat.mtimeMs}:${stat.size}`;
		} catch {
			return undefined;
		}
		if (memoryCache?.version !== version) {
			memoryCache = { version, memory: TaskMemory.fromRows(readRows(trainer.workspace.dataset)) };
		}
		return memoryCache.memory.size > 0 ? memoryCache.memory : undefined;
	}

	/** Lessons of learned tasks similar to a request; none for harness messages such as /laya learn's. */
	const lessonsFor = (request: string) =>
		HARNESS_MESSAGE.test(request.trimStart())
			? undefined
			: renderLessons(memory()?.search(request, LESSON_SIMILARITY) ?? []);

	/** The labels of a learned task close to the request, then Laya's answers, then keyword rules. */
	async function assess(request: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<TaskAssessment> {
		const learned = memory()?.search(request, ROUTE_SIMILARITY, 1)[0];
		if (learned) {
			try {
				return {
					...assessmentFromLabels(learned.task.expected),
					source: "memory",
					confidence: learned.similarity,
				};
			} catch {
				// Labeled against questions that have changed since; Laya answers instead.
			}
		}
		const classifier = ctx.modelRegistry.findOfType("classifier", LAYA_PROVIDER_ID, LAYA_CLASSIFIER_ID);
		// While the container installs, or without Docker, the classifier call would only fail.
		if (!classifier || Date.now() < layaUnavailableUntil || server.state === "installing") {
			return heuristicAssessment(request);
		}
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
	function candidates(ctx: ExtensionContext): Array<Candidate & { model: Model<Api>; capabilityKnown: boolean }> {
		const selected = settings.followProvider ? selectedModel(ctx) : undefined;
		const { registry } = scopedModelRegistry(settings, selected);
		const result: Array<Candidate & { model: Model<Api>; capabilityKnown: boolean }> = [];
		for (const tier of CAPABILITY_TIERS) {
			for (const ref of registry[tier] ?? []) {
				const parsed = parseModelRef(ref);
				const model = parsed && ctx.modelRegistry.find(parsed.provider, parsed.id);
				if (!model || model.provider === LAYA_PROVIDER_ID || !ctx.modelRegistry.hasConfiguredAuth(model)) continue;
				if (isVirtualModel(model)) continue;
				result.push({ ref, provider: model.provider, tier, order: result.length, model, capabilityKnown: true });
			}
		}
		// Unknown providers still work with the selected model; do not invent rankings of their models.
		if (result.length === 0 && selected && ctx.modelRegistry.hasConfiguredAuth(selected)) {
			result.push({
				ref: `${selected.provider}/${selected.id}`,
				provider: selected.provider,
				tier: "balanced",
				order: 0,
				model: selected,
				capabilityKnown: false,
			});
		}
		return result;
	}

	function rank(
		ctx: ExtensionContext,
		input: { assessment: TaskAssessment; requiredTier: CapabilityTier; minTier: CapabilityTier },
	): Array<ScoredCandidate & { model: Model<Api>; capabilityKnown: boolean }> {
		const available = candidates(ctx);
		if (available.length === 0) {
			throw new Error(
				"laya/auto: no model of the Laya model registry has credentials. Log in to a provider or set laya.models.",
			);
		}
		const byRef = new Map(available.map((candidate) => [candidate.ref, candidate]));
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
		return list.map((candidate) => ({
			...candidate,
			model: byRef.get(candidate.ref)!.model,
			capabilityKnown: byRef.get(candidate.ref)!.capabilityKnown,
		}));
	}

	function select(
		ctx: ExtensionContext,
		base: Omit<LayaRouterState, "tier" | "model" | "thinkingLevel" | "alternatives">,
		minTier: CapabilityTier,
		requiredTier: CapabilityTier,
	): { route: ModelRoute<LayaRouterState>; state: LayaRouterState } {
		const ranked = rank(ctx, { assessment: base.assessment, requiredTier, minTier });
		const chosen = ranked[0];
		const limited =
			!chosen.capabilityKnown || CAPABILITY_TIERS.indexOf(chosen.tier) < CAPABILITY_TIERS.indexOf(requiredTier);
		if (settings.followProvider && limited) {
			ctx.ui.notify(
				`Laya: ${requiredTier} requested; ${chosen.ref} is ${chosen.capabilityKnown ? chosen.tier : "unclassified"}. Staying with the selected provider; sufficient capability is not confirmed. Configure laya.modelGroups or select a stronger model.`,
				"warning",
			);
		}
		const state: LayaRouterState = {
			...base,
			tier: chosen.tier,
			model: chosen.ref,
			thinkingLevel: clampThinkingLevel(chosen.model, base.policy.thinkingLevel),
			alternatives: ranked.slice(1, 4).map((candidate) => candidate.ref),
			capabilityKnown: chosen.capabilityKnown,
		};
		current = state;
		ctx.ui.setStatus(
			"laya",
			`laya ${profile()}: ${base.assessment.task.type} → ${chosen.capabilityKnown ? chosen.tier : "unclassified"} ${chosen.model.id} • ${state.thinkingLevel}${
				{ laya: "", memory: " (memory)", heuristic: " (rules)" }[base.assessment.source]
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
				// Following a provider is a boundary, including on rate limits and overloads.
				if (settings.followProvider) return sticky(ctx, state);
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

	/**
	 * Pulls the image and starts or updates the server container, with progress in the status line.
	 * `explicit` is a user command: it always reports the result. Otherwise only a finished
	 * installation and a new problem are reported.
	 */
	async function install(ctx: ExtensionContext, explicit = false): Promise<boolean> {
		let worked = false;
		const ok = await server.install((message) => {
			worked = true;
			ctx.ui.setStatus("laya-setup", `laya: ${message}`);
		});
		ctx.ui.setStatus("laya-setup", undefined);
		if (ok) {
			layaUnavailableUntil = 0;
			lastClassifierError = undefined;
			reportedProblem = undefined;
			if (explicit || worked) ctx.ui.notify(`Laya is ${server.describe()}; it routes laya/auto requests.`);
			return true;
		}
		const problem = server.describe();
		if (explicit || problem !== reportedProblem) {
			reportedProblem = problem;
			ctx.ui.notify(`Laya ${problem}. Keyword rules route laya/auto requests until it runs.`, "warning");
		}
		return false;
	}

	/** Deletes the Python environment and model that Relay installed on the host before Laya moved to Docker. */
	function removeHostRuntime(): void {
		for (const name of HOST_RUNTIME_LEFTOVERS) {
			try {
				rmSync(join(layaHome, name), { recursive: true, force: true });
			} catch {
				// In use or not ours to delete; it does no harm.
			}
		}
	}

	/** Capability tier of a `provider/model` in the Laya model registry. */
	const tierOf = (ref: string): CapabilityTier | undefined => {
		const parsed = parseModelRef(ref);
		if (!parsed) return undefined;
		const { registry } = scopedModelRegistry(settings, parsed);
		return CAPABILITY_TIERS.find((tier) => registry[tier]?.includes(ref));
	};

	/**
	 * Starts training on the collected exercises. It runs in the background in interactive modes and
	 * reports through the listener; print and JSON mode wait for it, since the process ends with the turn.
	 */
	async function startTraining(ctx: ExtensionContext): Promise<string> {
		if (trainer.running) return "Laya is already training; run /laya train after it ends to include these tasks.";
		if (server.state !== "ready" && !(await server.install())) {
			return `Laya ${server.describe()}, so it cannot train yet. Run /laya setup, then /laya train.`;
		}
		if (!(await trainingGpu())) {
			const accepted =
				!ctx.hasUI ||
				(await ctx.ui.confirm(
					"Train Laya on the CPU?",
					"Docker gives Laya no GPU on this computer. Training still works, but can take an hour or more. Laya keeps routing requests meanwhile.",
				));
			if (!accepted) return "Training was not started. Run /laya train when you want it.";
		}
		// The server runs on the CPU, so it keeps routing while the training container has the GPU.
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
		return "Laya is training in a Docker container (a few minutes with a GPU). The current model keeps routing until it ends; then the new model routes requests if it passes the test.";
	}

	relay.on("session_start", (_event, ctx) => {
		refreshSettings();
		history = settings.telemetry === false ? new PerformanceHistory() : historyFromTelemetry(store.read());
		removeHostRuntime();
		// Install right away in the background: pull the image on first use, then keep the container
		// running. Sessions without a UI (print mode, SDK, tests) leave Docker alone.
		if (settings.autostart !== false && ctx.hasUI && isLocalUrl(baseUrl())) void install(ctx);
		listener = {
			progress: (progress) => ctx.ui.setStatus("laya-train", `laya training: ${describeProgress(progress)}`),
			finished: (result) => {
				ctx.ui.setStatus("laya-train", undefined);
				if ("error" in result) {
					ctx.ui.notify(`Laya training failed: ${result.error.message}`, "error");
					return;
				}
				ctx.ui.notify(describeTrainingOutcome(result.outcome), result.outcome.activated ? "info" : "warning");
				// The server container is replaced by one serving the new model.
				if (result.outcome.activated) void install(ctx);
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
			const saved = `Saved ${rows.length} exercises (${added} new, ${updated} updated); ${sessionRows} session tasks in total, in ${trainer.workspace.dataset}. Requests similar to these tasks use their labels and lessons from the next one.`;
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
		const previousRetrieval = retrievedTools;
		if (previousRetrieval) {
			const active = relay.getActiveTools();
			if (
				active.length === previousRetrieval.applied.length &&
				active.every((name, i) => name === previousRetrieval.applied[i])
			) {
				relay.setActiveTools(previousRetrieval.before);
			}
			retrievedTools = undefined;
		}
		if (settings.followProvider && ctx.model && !isVirtualModel(ctx.model)) {
			relay.appendEntry("laya.selected-model", { provider: ctx.model.provider, id: ctx.model.id });
			const auto = ctx.modelRegistry.find(LAYA_PROVIDER_ID, LAYA_VIRTUAL_MODEL_ID);
			if (!auto || !(await relay.setModel(auto)))
				throw new Error("Laya could not activate provider-scoped routing.");
		}
		const enforce = isSelected(ctx) && settings.toolRouting === "enforce";
		// Enforcement is off or another model is selected: give the user's tools back.
		if (toolBaseline && !enforce) {
			relay.setActiveTools(userTools());
			toolBaseline = undefined;
		}
		if (!isSelected(ctx)) {
			// Lessons help whichever model runs the request.
			const lessons = lessonsFor(event.prompt);
			if (!lessons) return;
			return {
				message: {
					customType: LAYA_LESSONS_MESSAGE,
					content: `[laya:lessons] ${lessons}`,
					display: false,
				},
			};
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
		const limit = settings.toolRetrieval;
		retrievalTelemetry = undefined;
		if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0) {
			const active = relay.getActiveTools();
			const candidates = relay
				.getAllTools()
				.filter((tool) => tool.exposure === "deferred" && !active.includes(tool.name));
			const matches = retrieveTools(event.prompt, candidates, limit);
			if (settings.toolRetrievalTelemetry && settings.telemetry !== false) {
				retrievalTelemetry = { candidateCount: candidates.length, retrievedNames: matches };
			}
			if (matches.length) {
				const applied = [...active, ...matches];
				retrievedTools = { before: active, applied };
				relay.setActiveTools(applied);
			}
		}
		const lessons = lessonsFor(event.prompt);
		const plan = renderPlanMessage(assessment, policy, skills, deactivated);
		const role = loadAgentProfile(assessment.agent, ctx);
		return {
			message: {
				customType: LAYA_PLAN_MESSAGE,
				content: [plan, lessons, role].filter(Boolean).join("\n\n"),
				display: false,
				details: { assessment, policy, skills, deactivated },
			},
		};
	});

	relay.on("session_shutdown", (event) => {
		// The server container keeps running for the next session.
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
		if (retrievalTelemetry && settings.telemetry !== false && settings.toolRetrievalTelemetry) {
			const invokedNames = event.messages.flatMap((message) =>
				message.role === "assistant"
					? message.content.filter((block) => block.type === "toolCall").map((block) => block.name)
					: [],
			);
			const evaluation = evaluateToolRetrieval(
				retrievalTelemetry.candidateCount,
				retrievalTelemetry.retrievedNames,
				invokedNames,
			);
			try {
				store.appendToolRetrieval({
					timestamp: new Date().toISOString(),
					...evaluation,
				});
			} catch (error) {
				ctx.ui.notify(
					`Laya retrieval telemetry not written: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			retrievalTelemetry = undefined;
		}
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
					ctx.ui.notify(`${trainer.activeModel().name} routes requests once the Laya container restarts with it`);
					// Replaces the server container with one serving the selected model.
					await install(ctx, true);
					return;
				}
				case "setup":
				case "start": {
					await install(ctx, true);
					return;
				}
				case "stop": {
					await server.stop();
					ctx.ui.notify("Stopped the Laya container; /laya start or the next Relay start runs it again");
					return;
				}
				case "status": {
					const providers = new Set(candidates(ctx).map((candidate) => candidate.provider));
					const lines = [
						`Profile: ${profile()}${isSelected(ctx) ? "" : " (select laya/auto to route with Laya)"}`,
						`Model scope: ${settings.followProvider ? scopedModelRegistry(settings, selectedModel(ctx)).scope : "all configured providers"}`,
						`Laya container: ${server.describe()}; server ${(await server.isUp()) ? "answering" : "not answering"} at ${baseUrl()}`,
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
						`Memory: ${settings.memory === false ? "off" : `${memory()?.size ?? 0} learned tasks route similar requests and share their lessons`}`,
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
