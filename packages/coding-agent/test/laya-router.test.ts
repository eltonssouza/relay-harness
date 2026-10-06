import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@relay-harness/agent-core";
import {
	type AssistantMessage,
	type ClassifierAnswer,
	type ClassifierModel,
	type ClassifierResult,
	createProvider,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	assessmentFromAnswers,
	assessmentFromLabels,
	heuristicAssessment,
	type TaskAssessment,
} from "../src/extensions/laya/assessment.ts";
import layaExtension, { LAYA_PLAN_MESSAGE } from "../src/extensions/laya/index.ts";
import { LAYA_LESSONS_MESSAGE } from "../src/extensions/laya/memory.ts";
import {
	applyPolicy,
	type Candidate,
	PerformanceHistory,
	QuotaManager,
	rankCandidates,
} from "../src/extensions/laya/policy.ts";
import { LAYA_QUESTIONS, layaDecisionsFile } from "../src/extensions/laya/questions.ts";
import { generateSeed } from "../src/extensions/laya/seed.ts";
import { datasetFromTelemetry, historyFromTelemetry, type TelemetryRecord } from "../src/extensions/laya/telemetry.ts";
import { trainingWorkspace, writeRows } from "../src/extensions/laya/training.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface Script {
	type: string;
	complexity: number;
	scope: string;
	risk: number;
	ambiguity: number;
	reasoning: number;
	tier: string;
	effort: string;
	agent: string;
	validation: string;
	/** Required tools, as requirement ids without the `requires_` prefix. */
	tools: string[];
	security: boolean;
	confidence: number;
}

const SIMPLE_FIX: Script = {
	type: "bug_fix",
	complexity: 1,
	scope: "single_file",
	risk: 0,
	ambiguity: 0,
	reasoning: 1,
	tier: "fast",
	effort: "low",
	agent: "software-engineer",
	validation: "unit_test",
	tools: ["write", "tests"],
	security: false,
	confidence: 0.9,
};

/** Classifier answers for `LAYA_QUESTIONS` as the Laya server would return them. */
function answersFor(script: Script): Record<string, ClassifierAnswer> {
	const choice = (id: string, value: string): ClassifierAnswer => {
		const question = LAYA_QUESTIONS[id];
		if (question.type !== "choice") throw new Error(id);
		const options = Object.keys(question.criteria);
		const rest = (1 - script.confidence) / (options.length - 1);
		return {
			type: "choice",
			choice: value,
			probabilities: Object.fromEntries(
				options.map((option) => [option, option === value ? script.confidence : rest]),
			),
			confidence: script.confidence,
		};
	};
	const score = (value: number): ClassifierAnswer => ({ type: "score", score: value, confidence: 0.9 });
	const bool = (value: boolean): ClassifierAnswer => ({ type: "bool", probability: value ? 0.9 : 0.1 });
	return {
		task_type: choice("task_type", script.type),
		complexity: score(script.complexity),
		scope: choice("scope", script.scope),
		risk: score(script.risk),
		ambiguity: score(script.ambiguity),
		reasoning_requirement: score(script.reasoning),
		capability_tier: choice("capability_tier", script.tier),
		reasoning_effort: choice("reasoning_effort", script.effort),
		agent: choice("agent", script.agent),
		validation_level: choice("validation_level", script.validation),
		requires_write: bool(script.tools.includes("write")),
		requires_shell: bool(script.tools.includes("shell")),
		requires_tests: bool(script.tools.includes("tests")),
		requires_web: bool(script.tools.includes("web")),
		requires_browser: bool(script.tools.includes("browser")),
		requires_database: bool(script.tools.includes("database")),
		requires_git: bool(script.tools.includes("git")),
		security_sensitive: bool(script.security),
	};
}

/** Labels of SIMPLE_FIX in the dataset format. */
const assessmentLabels: Record<string, string | number | boolean> = {
	task_type: "bug_fix",
	complexity: 1,
	scope: "single_file",
	risk: 0,
	ambiguity: 0,
	reasoning_requirement: 1,
	capability_tier: "fast",
	reasoning_effort: "low",
	agent: "software-engineer",
	validation_level: "unit_test",
	requires_write: true,
	requires_shell: false,
	requires_tests: true,
	requires_web: false,
	requires_browser: false,
	requires_database: false,
	requires_git: false,
	security_sensitive: false,
};

const assessment = (script: Partial<Script> = {}): TaskAssessment =>
	assessmentFromAnswers(answersFor({ ...SIMPLE_FIX, ...script }));

describe("laya policy", () => {
	it("keeps Laya's tier and maps the top effort to xhigh, never max", () => {
		const decision = applyPolicy(
			assessment({ tier: "frontier", effort: "extra_high", type: "feature" }),
			"Build a plugin system",
			{
				minConfidence: 0.5,
			},
		);
		expect(decision).toMatchObject({
			requiredTier: "frontier",
			minTier: "fast",
			thinkingLevel: "xhigh",
			escalations: [],
		});
	});

	it("raises security-sensitive requests to strong with mandatory review", () => {
		const decision = applyPolicy(assessment({ effort: "minimal" }), "Fix the password reset token bug", {
			minConfidence: 0.5,
		});
		expect(decision).toMatchObject({
			recommendedTier: "fast",
			requiredTier: "strong",
			minTier: "strong",
			effort: "medium",
			validation: { required: true, level: "review" },
			rules: ["authentication"],
			escalations: ["security_sensitive"],
		});
	});

	it("raises the tier by one when Laya is unsure", () => {
		const decision = applyPolicy(assessment({ confidence: 0.3 }), "Fix the off-by-one in the pager", {
			minConfidence: 0.5,
		});
		expect(decision).toMatchObject({
			requiredTier: "balanced",
			minTier: "fast",
			escalations: ["insufficient_confidence"],
		});
	});

	const candidates: Candidate[] = [
		{ ref: "anthropic/haiku", provider: "anthropic", tier: "fast", order: 0 },
		{ ref: "openai/luna", provider: "openai", tier: "fast", order: 1 },
		{ ref: "anthropic/sonnet", provider: "anthropic", tier: "balanced", order: 2 },
		{ ref: "openai/terra", provider: "openai", tier: "balanced", order: 3 },
		{ ref: "anthropic/opus", provider: "anthropic", tier: "strong", order: 4 },
		{ ref: "anthropic/fable", provider: "anthropic", tier: "frontier", order: 5 },
	];
	const rank = (input: Partial<Parameters<typeof rankCandidates>[1]>) =>
		rankCandidates(candidates, {
			requiredTier: "balanced",
			minTier: "fast",
			risk: 0.2,
			profile: "balanced",
			taskKey: "bug_fix:2",
			history: new PerformanceHistory(),
			quota: new QuotaManager(),
			...input,
		}).map((candidate) => candidate.ref);

	it("uses the cheapest sufficient model for the profile", () => {
		expect(rank({})[0]).toBe("anthropic/sonnet");
		expect(rank({ requiredTier: "fast", profile: "economy" })[0]).toBe("anthropic/haiku");
		// Critical ignores cost: the most capable model wins.
		expect(rank({ profile: "critical" })[0]).toBe("anthropic/fable");
		// A floor removes every model below it.
		expect(rank({ minTier: "strong" })).toEqual(["anthropic/opus", "anthropic/fable"]);
	});

	it("prefers an equivalent provider when quota is scarce", () => {
		const quota = new QuotaManager(() => 0);
		quota.recordPressure("anthropic");
		expect(rank({ quota })[0]).toBe("openai/terra");
		const configured = new QuotaManager();
		configured.configure({ anthropic: 0.25 });
		expect(rank({ quota: configured })[0]).toBe("openai/terra");
	});

	it("learns from history: a model that keeps failing a task class loses it", () => {
		const history = new PerformanceHistory();
		for (let run = 0; run < 10; run++) history.record("bug_fix:2", "anthropic/sonnet", false);
		expect(rank({ history })[0]).toBe("openai/terra");
	});
});

describe("laya assessment", () => {
	it("reads classifier answers and rejects unknown options", () => {
		expect(assessment()).toMatchObject({
			source: "laya",
			task: { type: "bug_fix", complexity: 0.25, scope: "single_file", risk: 0 },
			recommendation: { tier: "fast", effort: "low" },
			tools: { requires_write: true, requires_tests: true, requires_web: false },
			confidence: 0.9,
		});
		const answers = answersFor(SIMPLE_FIX);
		answers.capability_tier = { type: "choice", choice: "huge", probabilities: { huge: 1 }, confidence: 1 };
		expect(() => assessmentFromAnswers(answers)).toThrow(/capability_tier/);
	});

	it("reads learned labels as a certain assessment", () => {
		expect(assessmentFromLabels(assessmentLabels)).toEqual({ ...assessment(), confidence: 1 });
		expect(() => assessmentFromLabels({ ...assessmentLabels, capability_tier: "huge" })).toThrow("capability_tier");
	});

	it("falls back to keyword rules in English and Portuguese", () => {
		expect(heuristicAssessment("Corrija o texto deste botão para 'Salvar'.")).toMatchObject({
			source: "heuristic",
			task: { type: "bug_fix" },
			recommendation: { tier: "fast" },
			agent: "frontend-engineer",
		});
		expect(heuristicAssessment("Fix the SQL injection in the search endpoint")).toMatchObject({
			task: { type: "security" },
			recommendation: { tier: "strong" },
			securitySensitive: true,
		});
		expect(heuristicAssessment("Onde fica definida a função parseDate?")).toMatchObject({
			task: { type: "question" },
			tools: { requires_write: false },
			validation: "none",
		});
	});
});

describe("laya training data", () => {
	it("exports the questions in laya-trainer format", () => {
		const file = layaDecisionsFile();
		expect(file.decisions.requires_git).toMatchObject({ type: "noul", criteria: { true: expect.any(String) } });
		expect(file.decisions.complexity).toMatchObject({ type: "score" });
	});

	it("generates deterministic seed exercises whose labels are valid options", () => {
		const rows = generateSeed(300);
		expect(rows).toHaveLength(300);
		expect(generateSeed(300)).toEqual(rows);
		expect(new Set(rows.map((row) => row.state.request)).size).toBe(300);
		for (const row of rows) {
			for (const [id, value] of Object.entries(row.expected)) {
				const question = LAYA_QUESTIONS[id];
				if (question.type === "choice") expect(Object.keys(question.criteria)).toContain(value);
				else if (question.type === "score") expect(value).toBeLessThan(question.criteria.length);
				else expect(typeof value).toBe("boolean");
			}
		}
	});

	it("turns telemetry into history and evidence-labeled exercises", () => {
		const record = (success: boolean, outcome: TelemetryRecord["result"]["outcome"]): TelemetryRecord =>
			({
				request: "Fix the pager",
				classification: { type: "bug_fix", complexity: 0.5 },
				selected: { provider: "anthropic", model: "sonnet", tier: "balanced" },
				result: { success, outcome },
			}) as TelemetryRecord;
		const records = [record(true, "completed"), record(false, "error"), record(false, "aborted")];
		expect(historyFromTelemetry(records).get("bug_fix:2", "anthropic/sonnet")).toEqual({ runs: 2, successes: 1 });
		expect(datasetFromTelemetry(records)).toEqual([
			{ state: { request: "Fix the pager" }, expected: { capability_tier: "balanced" }, source: "harness" },
		]);
	});
});

const layaModel: ClassifierModel<string> = {
	type: "classifier",
	id: "execution-intelligence",
	name: "Laya",
	api: "typesafe-system-one",
	provider: "laya",
	baseUrl: "",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
};

function createTool(name: string, fails = false): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name} tool`,
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => {
			if (fails) throw new Error(`${name} failed`);
			return { content: [{ type: "text", text: `${name} ok` }], details: {} };
		},
	};
}

describe("laya/auto router", () => {
	const harnesses: Harness[] = [];
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "relay-laya-"));
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	/** Faux Anthropic models for every tier and a scripted Laya classifier (undefined = server down). */
	async function setup(script: Script | undefined, tools: AgentTool[], settings: Record<string, unknown> = {}) {
		const anthropic = fauxProvider({
			provider: "anthropic",
			models: ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"].map((id) => ({
				id,
				reasoning: true,
			})),
		});
		const requests: string[] = [];
		const laya = createProvider({
			id: "laya",
			auth: { apiKey: { name: "Laya", resolve: async () => ({ auth: { apiKey: "local" } }) } },
			models: [layaModel],
			classifiers: {
				"typesafe-system-one": {
					classify: async (model, context): Promise<ClassifierResult> => {
						requests.push(String(context.state.request));
						return {
							api: model.api,
							provider: model.provider,
							model: model.id,
							answers: script ? answersFor(script) : {},
							stopReason: script ? "stop" : "error",
							errorMessage: script ? undefined : "connect ECONNREFUSED 127.0.0.1:8000",
							timestamp: Date.now(),
						};
					},
				},
			},
		});
		const harness = await createHarness({
			tools,
			// Scenarios end with an unverified "done"; the evidence pillar's extra turn is not under test.
			settings: { harnessCore: { evidence: false }, laya: settings },
			extensionFactories: [
				(relay) => relay.registerProvider(anthropic.provider),
				layaExtension,
				// Replaces the built-in Laya provider with the scripted classifier.
				(relay) => relay.registerProvider(laya),
			],
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		await runtime.refresh({ allowNetwork: false });
		await harness.session.setModel(runtime.getModel("laya", "auto")!);

		const respond = (...messages: AssistantMessage[]) => anthropic.appendResponses(messages);
		const dispatched = () =>
			harness.session.messages.flatMap((m) =>
				m.role === "assistant" ? [`${m.model.replace("claude-", "")}:${m.thinkingLevel}`] : [],
			);
		const plan = () =>
			harness.session.messages.flatMap((m) =>
				m.role === "custom" && m.customType === LAYA_PLAN_MESSAGE ? [String(m.content)] : [],
			);
		const telemetry = (): TelemetryRecord[] =>
			readFileSync(join(agentDir, "laya", "telemetry.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as TelemetryRecord);
		return { harness, respond, dispatched, plan, telemetry, requests };
	}

	const call = (tool: string) => fauxAssistantMessage(fauxToolCall(tool, { path: "a.ts" }), { stopReason: "toolUse" });

	it("routes a simple fix to the fast tier, sends the plan and records telemetry", async () => {
		const { harness, respond, dispatched, plan, telemetry, requests } = await setup(SIMPLE_FIX, [createTool("edit")]);

		respond(call("edit"), fauxAssistantMessage("done"));
		await harness.session.prompt("Fix the off-by-one in the pager.");

		expect(requests).toEqual(["Fix the off-by-one in the pager."]);
		expect(dispatched()).toEqual(["haiku-4-5:low", "haiku-4-5:low"]);
		expect(plan()[0]).toContain("Role: act as software-engineer");
		expect(plan()[0]).toContain("Validation (required): run the unit tests");
		expect(telemetry()).toMatchObject([
			{
				classification: { source: "laya", type: "bug_fix" },
				selected: { provider: "anthropic", model: "claude-haiku-4-5", tier: "fast", thinking_level: "low" },
				result: { success: true, outcome: "completed", attempts: 1, escalations: [] },
			},
		]);
	});

	it("overrides Laya for authentication work", async () => {
		const { harness, respond, dispatched, plan } = await setup({ ...SIMPLE_FIX, effort: "minimal" }, []);

		respond(fauxAssistantMessage("done"));
		await harness.session.prompt("Fix the login form: the password reset token never expires.");

		expect(dispatched()).toEqual(["opus-5-5:medium"]);
		expect(plan()[0]).toContain("Sensitive area: authentication");
	});

	it("escalates one tier after repeated tool failures in a turn", async () => {
		const { harness, respond, dispatched, telemetry } = await setup(SIMPLE_FIX, [createTool("edit", true)], {
			escalateAfterFailures: 2,
		});

		respond(call("edit"), call("edit"), fauxAssistantMessage("done"));
		await harness.session.prompt("Fix the off-by-one in the pager.");

		expect(dispatched()).toEqual(["haiku-4-5:low", "haiku-4-5:low", "sonnet-5-5:low"]);
		expect(telemetry()[0].result).toMatchObject({
			attempts: 2,
			escalations: [{ reason: "repeated_failure", from: "fast", to: "balanced" }],
		});
		expect(telemetry()[0].selected).toMatchObject({ tier: "balanced", model: "claude-sonnet-5-5" });
	});

	it("deactivates unneeded tools when enforcing and restores them for another model", async () => {
		const question: Script = { ...SIMPLE_FIX, type: "question", tools: [], validation: "none" };
		const { harness, respond, plan } = await setup(question, [createTool("read"), createTool("edit")], {
			toolRouting: "enforce",
		});
		harness.session.setActiveToolsByName(["read", "edit"]);

		respond(fauxAssistantMessage("It returns a Date."));
		await harness.session.prompt("What does parseDate return?");
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		expect(plan()[0]).toContain("Deactivated for this request: edit");

		await harness.session.setModel(harness.session.modelRuntime.getModel("anthropic", "claude-haiku-4-5")!);
		respond(fauxAssistantMessage("done"));
		await harness.session.prompt("Now rename it.");
		expect(harness.session.getActiveToolNames()).toEqual(["read", "edit"]);
	});

	it("keeps routing with keyword rules when the Laya server is down", async () => {
		const { harness, respond, dispatched, telemetry } = await setup(undefined, []);

		respond(fauxAssistantMessage("done"), fauxAssistantMessage("ok"));
		await harness.session.prompt("Corrija o texto deste botão para 'Salvar'.");
		await harness.session.prompt("Corrija o texto deste botão para 'Enviar'.");

		expect(dispatched()).toEqual(["haiku-4-5:minimal", "haiku-4-5:minimal"]);
		expect(telemetry().map((record) => record.classification.source)).toEqual(["heuristic", "heuristic"]);
	});

	/** A task learned with /laya learn: the button text lives in a translation file the rules cannot know. */
	function learnTask() {
		writeRows(trainingWorkspace(join(agentDir, "laya")).dataset, [
			...generateSeed(50).map((row, i) => ({ id: `r${i}`, ...row })),
			{
				id: "s00001",
				state: { request: "Corrija o texto do botão Salvar na tela de pedidos" },
				expected: {
					...assessmentLabels,
					task_type: "bug_fix",
					capability_tier: "strong",
					reasoning_effort: "high",
					scope: "multi_module",
				},
				source: "session",
				split: "train",
				lesson: "The label comes from locales/pt-BR/orders.json, not the component; run npm run i18n:check.",
			},
		]);
	}

	it("routes a request like a learned task by its labels, at once and without the Laya server", async () => {
		learnTask();
		const { harness, respond, dispatched, plan, telemetry } = await setup(undefined, []);

		respond(fauxAssistantMessage("done"));
		await harness.session.prompt("Corrija o texto do botão Salvar na tela de pedidos, está cortado");

		// Keyword rules would route this text fix to haiku with minimal effort.
		expect(dispatched()).toEqual(["opus-5-5:high"]);
		expect(plan()[0]).toContain("Lessons from similar tasks done before");
		expect(plan()[0]).toContain("locales/pt-BR/orders.json");
		expect(telemetry()[0].classification.source).toBe("memory");
	});

	it("gives the lessons of similar tasks to a model laya/auto does not route", async () => {
		learnTask();
		const { harness, respond } = await setup(undefined, []);
		await harness.session.setModel(harness.session.modelRuntime.getModel("anthropic", "claude-haiku-4-5")!);

		respond(fauxAssistantMessage("done"), fauxAssistantMessage("ok"));
		await harness.session.prompt("Corrija o texto do botão Salvar na tela de pedidos");
		await harness.session.prompt("Write the README for the auth module");

		const lessons = harness.session.messages.flatMap((m) =>
			m.role === "custom" && m.customType === LAYA_LESSONS_MESSAGE ? [String(m.content)] : [],
		);
		expect(lessons).toHaveLength(1);
		expect(lessons[0]).toMatch(/^\[laya:lessons\] Lessons from similar tasks/);
		expect(lessons[0]).toContain("npm run i18n:check");
	});
});
