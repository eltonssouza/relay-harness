import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@relay-harness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import layaExtension from "../src/extensions/laya/index.ts";
import {
	buildLearnPrompt,
	exercisesToRows,
	LEARN_TOOL_NAME,
	type LearnToolParams,
	sessionTasks,
} from "../src/extensions/laya/learn.ts";
import {
	LESSON_SIMILARITY,
	ROUTE_SIMILARITY,
	renderLessons,
	TaskMemory,
	words,
} from "../src/extensions/laya/memory.ts";
import { LAYA_PLAN_MESSAGE } from "../src/extensions/laya/routers.ts";
import { type LayaModelManifest, layaPaths } from "../src/extensions/laya/runtime.ts";
import { generateSeed } from "../src/extensions/laya/seed.ts";
import { LayaServer } from "../src/extensions/laya/server.ts";
import {
	ensureWorkspace,
	LayaTrainer,
	mergeRows,
	readRegistry,
	readRows,
	type Score,
	SEED_ROWS,
	type SpawnTraining,
	type TrainingProgress,
	type TrainingRow,
	trainingWorkspace,
} from "../src/extensions/laya/training.ts";
import { createHarness, getAssistantTexts, type Harness } from "./suite/harness.ts";

const LABELS = {
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
} as const;

let nextId = 0;
const entry = (fields: Record<string, unknown>): SessionEntry =>
	({ id: `e${++nextId}`, parentId: null, timestamp: new Date(0).toISOString(), ...fields }) as SessionEntry;
const message = (value: Record<string, unknown>) => entry({ type: "message", message: value as AgentMessage });
const user = (text: string) => message({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
	message({
		role: "assistant",
		content,
		provider: "anthropic",
		model: "claude-haiku-4-5",
		thinkingLevel: "low",
		stopReason: content.some((block) => (block as { type: string }).type === "toolCall") ? "toolUse" : "stop",
		usage: { totalTokens: 10, cost: { total: 0.001 } },
		timestamp: 0,
		...extra,
	});
const call = (id: string, name: string, args: Record<string, unknown>) => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
const result = (id: string, toolName: string, isError = false, text = "") =>
	message({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], isError, timestamp: 0 });

describe("laya learn: session tasks", () => {
	it("extracts each request with the evidence of how it went", () => {
		const entries = [
			user("Fix the off-by-one in the pager."),
			entry({
				type: "custom_message",
				customType: LAYA_PLAN_MESSAGE,
				content: "[laya:plan]",
				display: false,
				details: {
					assessment: {
						source: "laya",
						task: { type: "bug_fix" },
						recommendation: { tier: "fast", effort: "low" },
					},
					policy: { requiredTier: "balanced" },
				},
			}),
			assistant([call("c1", "edit", { path: "src/pager.ts" })]),
			result("c1", "edit", true, "Could not find the exact text in src/pager.ts.\nThe old text must match."),
			assistant([call("c2", "edit", { path: "src/pager.ts" })]),
			result("c2", "edit"),
			assistant([call("c3", "bash", { command: "npm test -- pager" })]),
			result("c3", "bash"),
			user("[harness:evidence] Show the check output."),
			assistant([{ type: "text", text: "Fixed and the tests pass." }]),
			user("No, the last page is still empty."),
			assistant([{ type: "text", text: "Now it works." }], { model: "claude-opus-5-5" }),
			user("[laya:learn] Teach Laya..."),
			assistant([call("c4", LEARN_TOOL_NAME, {})]),
			user("Thanks!"),
		];
		const tiers: Record<string, "fast" | "strong"> = {
			"anthropic/claude-haiku-4-5": "fast",
			"anthropic/claude-opus-5-5": "strong",
		};

		const tasks = sessionTasks(entries, (ref) => tiers[ref]);

		expect(tasks.map((task) => task.request)).toEqual([
			"Fix the off-by-one in the pager.",
			"No, the last page is still empty.",
			"Thanks!",
		]);
		expect(tasks[0]).toMatchObject({
			number: 1,
			tools: { edit: 2, bash: 1 },
			files: ["src/pager.ts"],
			commands: ["npm test -- pager"],
			toolFailures: 1,
			errors: ["edit: Could not find the exact text in src/pager.ts."],
			testsPassed: true,
			outcome: "completed",
			models: ["anthropic/claude-haiku-4-5 (fast tier) • low"],
			planned: { type: "bug_fix", tier: "balanced", effort: "low", source: "laya" },
			reply: "Fixed and the tests pass.",
			next: "No, the last page is still empty.",
		});
		// The work of /laya learn is attributed to no task.
		expect(tasks[1].models).toEqual(["anthropic/claude-opus-5-5 (strong tier) • low"]);
		expect(tasks[1].tools).toEqual({});
		expect(tasks[1].next).toBe("Thanks!");
		expect(tasks[2].models).toEqual([]);

		const prompt = buildLearnPrompt(tasks);
		expect(prompt.startsWith("[laya:learn]")).toBe(true);
		expect(prompt).toContain("### Task 1");
		expect(prompt).toContain("Laya planned: bug_fix, balanced tier, low effort (laya)");
		expect(prompt).toContain("Errors: edit: Could not find the exact text");
		expect(prompt).toContain("also write a lesson");
		expect(prompt).toContain("- capability_tier: What is the cheapest model capability tier");
		expect(prompt).toContain("- complexity: How complex is the task? An integer: 0 trivial;");
	});

	it("turns labeled tasks into session exercises and rejects invalid ones", () => {
		const tasks = sessionTasks([user("Fix the pager."), assistant([{ type: "text", text: "Done." }])]);
		const meta = { session: "s-1", created: "2026-10-06T00:00:00.000Z" };
		const exercises = (task: number, labels: Record<string, unknown>) =>
			[
				{ task, labels, note: "Finished on haiku.", lesson: " Run npm test -- pager. " },
			] as LearnToolParams["exercises"];

		expect(exercisesToRows(tasks, exercises(1, LABELS), meta)).toEqual([
			{
				state: { request: "Fix the pager." },
				expected: LABELS,
				source: "session",
				split: "train",
				session: "s-1",
				label_source: "agent",
				note: "Finished on haiku.",
				lesson: "Run npm test -- pager.",
				created: meta.created,
			},
		]);
		expect(() => exercisesToRows(tasks, exercises(2, LABELS), meta)).toThrow("task 2: there is no such task");
		expect(() => exercisesToRows(tasks, exercises(1, { ...LABELS, capability_tier: "huge" }), meta)).toThrow(
			'capability_tier: "huge" is not a valid answer',
		);
		expect(() => exercisesToRows(tasks, exercises(1, { ...LABELS, complexity: 9 }), meta)).toThrow("complexity");
	});
});

describe("laya memory", () => {
	const learned = [
		{
			id: "s1",
			request: "Fix the off-by-one in the pager: the last page is always empty",
			expected: {},
			lesson: "Pages are 1-based in src/pager.ts; run npm test -- pager.",
		},
		{ id: "s2", request: "rode o npm run check e corrija os erros", expected: {} },
		{ id: "s3", request: "faça o commit das minhas mudanças e abra o PR", expected: {} },
	];
	const memory = new TaskMemory(learned, [
		...generateSeed(1100).map((row) => row.state.request),
		...learned.map((task) => task.request),
	]);
	const best = (request: string) => memory.search(request, 0, 1)[0];

	it("splits identifiers, drops accents and stopwords", () => {
		expect(words("Corrija o cálculo do calculateTotal no PR")).toEqual([
			"corrija",
			"calculo",
			"calculate",
			"total",
			"pr",
		]);
	});

	it("finds a learned task in other words and ignores unrelated requests", () => {
		expect(best("The pager shows an empty last page, fix the off by one")).toMatchObject({ task: { id: "s1" } });
		expect(best("The pager shows an empty last page, fix the off by one").similarity).toBeGreaterThan(
			ROUTE_SIMILARITY,
		);
		expect(best("rode npm run check e conserte os erros que aparecerem").similarity).toBeGreaterThan(
			ROUTE_SIMILARITY,
		);
		expect(best("faça commit e abra um PR").task.id).toBe("s3");
		// Close enough for a lesson, not for routing.
		const near = best("fix the pager").similarity;
		expect(near).toBeGreaterThan(LESSON_SIMILARITY);
		expect(near).toBeLessThan(ROUTE_SIMILARITY);
		for (const unrelated of ["Write the README for the auth module", "Corrija o texto deste botão"]) {
			expect(memory.search(unrelated, LESSON_SIMILARITY)).toEqual([]);
		}
	});

	it("renders the lessons of the matches that have one", () => {
		const matches = memory.search("The pager shows an empty last page, fix the off by one", 0, 3);
		expect(renderLessons(matches)).toMatch(
			/^Lessons from similar tasks done before in this harness \(check they still apply\):\n {2}- "Fix the off-by-one in the pager: the last page is always empty" \(\d+% similar\): Pages are 1-based/,
		);
		expect(renderLessons(memory.search("faça commit e abra um PR", 0, 1))).toBeUndefined();
	});

	it("is built from the session tasks of a dataset", () => {
		const rows: TrainingRow[] = [
			{ id: "r1", state: { request: "Fix the pager" }, expected: {}, source: "synthetic" },
			{
				id: "s1",
				state: { request: "Fix the pager" },
				expected: { capability_tier: "strong" },
				source: "session",
				lesson: "x",
			},
		];
		const fromRows = TaskMemory.fromRows(rows);
		expect(fromRows.size).toBe(1);
		expect(fromRows.search("fix the pager", ROUTE_SIMILARITY)[0]).toMatchObject({
			task: { id: "s1", expected: { capability_tier: "strong" }, lesson: "x" },
		});
	});
});

describe("laya training workspace", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "relay-laya-training-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("seeds the shipped model's exercises once and keeps the questions current", () => {
		const workspace = trainingWorkspace(home);
		ensureWorkspace(workspace);
		const rows = readRows(workspace.dataset);
		expect(rows).toHaveLength(SEED_ROWS);
		expect(rows[0]).toMatchObject({ id: "r00001", source: "synthetic" });
		expect(JSON.parse(readFileSync(workspace.decisions, "utf8")).decisions.requires_git.type).toBe("noul");

		writeFileSync(workspace.dataset, `${JSON.stringify(rows[0])}\n`);
		ensureWorkspace(workspace);
		expect(readRows(workspace.dataset)).toHaveLength(1);
	});

	it("adds new requests and relabels a request it already has", () => {
		const row = (request: string, tier: string) => ({
			state: { request },
			expected: { capability_tier: tier },
			source: "session",
		});
		const first = mergeRows([], [row("Fix the pager", "fast"), row("Add login", "strong")]);
		expect(first.rows.map((r) => r.id)).toEqual(["s00001", "s00002"]);

		const second = mergeRows(first.rows, [row("  fix THE   pager ", "balanced"), row("Write docs", "fast")]);
		expect(second).toMatchObject({ added: 1, updated: 1 });
		expect(second.rows.map((r) => [r.id, r.expected.capability_tier])).toEqual([
			["s00001", "balanced"],
			["s00002", "strong"],
			["s00003", "fast"],
		]);
	});
});

const manifest: LayaModelManifest = {
	version: "v1",
	layaPackage: "laya[serve]==0.0.0",
	baseUrl: "https://example.test/",
	files: [{ path: "model.safetensors", asset: "model.safetensors", size: 5, sha256: "x" }],
};

const score = (correct: number, n = 100): Score => ({ n, correct, per_question: {} });

/** A training script stand-in: reports progress, writes the model and prints the scores. */
function fakeSpawn(
	scores: { candidate: number; current: number },
	calls: string[][],
	failFirst?: string,
): SpawnTraining {
	return (_command, args, _env, onStderrLine) => {
		calls.push(args);
		const out = args[args.indexOf("--out") + 1];
		onStderrLine('PROGRESS {"phase": "train", "epoch": 1, "epochs": 3, "done": 0.5, "eta_s": 240}');
		onStderrLine("a warning from torch");
		let stdout: string;
		if (failFirst && calls.length === 1) {
			stdout = JSON.stringify({ ok: false, error: failFirst, message: "The GPU ran out of memory while training." });
		} else {
			mkdirSync(out, { recursive: true });
			writeFileSync(join(out, "model.safetensors"), "model");
			stdout = JSON.stringify({
				ok: true,
				seconds: 300,
				device: "cuda",
				rows: { focus: 2 },
				test: { candidate: score(scores.candidate), current: score(scores.current) },
				focus: { candidate: score(34, 36), current: score(20, 36) },
			});
		}
		return { done: Promise.resolve({ code: 0, stdout: `${stdout}\n` }), kill: () => {} };
	};
}

describe("laya trainer", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "relay-laya-trainer-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	function setup(spawn: SpawnTraining) {
		const paths = layaPaths(home, manifest);
		mkdirSync(join(paths.venvPython, ".."), { recursive: true });
		writeFileSync(paths.venvPython, "");
		mkdirSync(paths.model, { recursive: true });
		writeFileSync(join(paths.model, "model.safetensors"), "model");
		const trainer = new LayaTrainer({ home, manifest, paths, spawn });
		trainer.addExercises([
			{ state: { request: "Fix the pager" }, expected: { ...LABELS }, source: "session", split: "train" },
		]);
		return { trainer, paths };
	}

	it("starts from the active model and activates the new one when the test score holds", async () => {
		const calls: string[][] = [];
		const { trainer, paths } = setup(fakeSpawn({ candidate: 97, current: 97.5 }, calls));
		const progress: TrainingProgress[] = [];
		const finished: unknown[] = [];
		trainer.listener = { progress: (value) => progress.push(value), finished: (value) => finished.push(value) };

		const outcome = await trainer.train();

		expect(calls[0]).toEqual(expect.arrayContaining(["learn", "--init", paths.model, "--focus-source", "session"]));
		expect(readFileSync(paths.trainScript, "utf8")).toContain("def cmd_learn(a):");
		expect(progress).toEqual([{ phase: "train", epoch: 1, epochs: 3, done: 0.5, eta_s: 240 }]);
		expect(outcome).toMatchObject({ activated: true, previous: "v1", model: { name: "local-1", basedOn: "v1" } });
		expect(finished).toEqual([{ outcome }]);
		expect(trainer.activeModel()).toEqual({ name: "local-1", dir: join(trainer.workspace.models, "local-1") });
		expect(trainer.running).toBe(false);

		// The next training starts from the trained model.
		await trainer.train();
		expect(calls[1][calls[1].indexOf("--init") + 1]).toBe(join(trainer.workspace.models, "local-1"));
		expect(trainer.activeModel().name).toBe("local-2");
	});

	it("keeps the current model when the new one does worse on the test", async () => {
		const { trainer } = setup(fakeSpawn({ candidate: 90, current: 97 }, []));
		const outcome = await trainer.train();
		expect(outcome.activated).toBe(false);
		expect(trainer.activeModel().name).toBe("v1");
		expect(readRegistry(trainer.workspace).models.map((model) => model.name)).toEqual(["local-1"]);

		trainer.use("local-1");
		expect(trainer.activeModel().name).toBe("local-1");
		trainer.use("v1");
		expect(trainer.activeModel().name).toBe("v1");
		expect(() => trainer.use("local-9")).toThrow("No trained model named local-9");
	});

	it("retries with the smallest batch when the GPU runs out of memory", async () => {
		const calls: string[][] = [];
		const { trainer } = setup(fakeSpawn({ candidate: 97, current: 97 }, calls, "out_of_memory"));
		await trainer.train();
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual(expect.arrayContaining(["--micro-batch", "1", "--low-memory", "on"]));
	});

	it("deletes old inactive models and keeps the active one", async () => {
		const { trainer } = setup(fakeSpawn({ candidate: 97, current: 97 }, []));
		for (let i = 0; i < 4; i++) await trainer.train();
		const names = readRegistry(trainer.workspace).models.map((model) => model.name);
		expect(names).toEqual(["local-2", "local-3", "local-4"]);
		expect(existsSync(join(trainer.workspace.models, "local-1"))).toBe(false);
		expect(trainer.activeModel().name).toBe("local-4");
	});

	it("needs the Laya environment and session tasks", async () => {
		const paths = layaPaths(home, manifest);
		const trainer = new LayaTrainer({ home, manifest, paths, spawn: fakeSpawn({ candidate: 1, current: 1 }, []) });
		const finished: unknown[] = [];
		trainer.listener = { progress: () => {}, finished: (value) => finished.push(value) };
		await expect(trainer.train()).rejects.toThrow("Run /laya setup first");
		expect(finished).toHaveLength(1);

		mkdirSync(join(paths.venvPython, ".."), { recursive: true });
		writeFileSync(paths.venvPython, "");
		await expect(trainer.train()).rejects.toThrow("no session tasks to learn yet");
	});

	it("serves the active model", () => {
		const paths = layaPaths(home, manifest);
		let model = join(home, "training", "models", "local-1");
		const server = new LayaServer({ paths, manifest, baseUrl: () => "http://127.0.0.1:1/v1", model: () => model });
		mkdirSync(join(paths.venvPython, ".."), { recursive: true });
		writeFileSync(paths.venvPython, "");
		writeFileSync(paths.serveScript, "");
		expect(server.status()).toBe("missing-model");
		mkdirSync(model, { recursive: true });
		writeFileSync(join(model, "model.safetensors"), "model");
		expect(server.status()).toBe("ready");
		model = paths.model;
		expect(server.status()).toBe("missing-model");
	});
});

describe("/laya learn", () => {
	let harness: Harness | undefined;
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "relay-laya-learn-"));
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	const editTool: AgentTool = {
		name: "edit",
		label: "edit",
		description: "Fake edit tool",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "edited" }], details: {} }),
	};

	it("sends the session's tasks for labeling and saves the exercises the agent labels", async () => {
		harness = await createHarness({
			tools: [editTool],
			settings: { harnessCore: { evidence: false } },
			extensionFactories: [layaExtension],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { path: "src/pager.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Fixed."),
			fauxAssistantMessage(fauxToolCall(LEARN_TOOL_NAME, { exercises: [{ task: 1, labels: LABELS }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Saved 1 task."),
		]);

		await harness.session.prompt("Fix the off-by-one in the pager.");
		expect(harness.session.getActiveToolNames()).not.toContain(LEARN_TOOL_NAME);
		await harness.session.prompt("/laya learn");
		// The command starts the turn without waiting for it.
		await vi.waitFor(() => expect(getAssistantTexts(harness!).at(-1)).toBe("Saved 1 task."));
		await harness.session.waitForIdle();

		expect(harness.session.getActiveToolNames()).toContain(LEARN_TOOL_NAME);
		const prompt = harness.session.messages.findLast((m) => m.role === "user");
		expect(JSON.stringify(prompt?.content)).toContain("Fix the off-by-one in the pager.");
		const toolResult = harness.session.messages.findLast((m) => m.role === "toolResult");
		expect(toolResult).toMatchObject({ toolName: LEARN_TOOL_NAME, isError: false });
		// No Laya environment in the test: the exercises are saved and training waits for /laya setup.
		expect(JSON.stringify(toolResult?.content)).toContain("Run /laya setup, then /laya train");

		const rows = readRows(trainingWorkspace(join(agentDir, "laya")).dataset);
		expect(rows).toHaveLength(SEED_ROWS + 1);
		expect(rows.at(-1)).toMatchObject({
			id: "s00001",
			state: { request: "Fix the off-by-one in the pager." },
			expected: LABELS,
			source: "session",
			split: "train",
			session: harness.sessionManager.getSessionId(),
		});
	});
});
