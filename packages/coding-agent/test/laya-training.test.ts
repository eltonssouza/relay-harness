import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@relay-harness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import type { DockerRun } from "../src/extensions/laya/docker.ts";
import { DOCKER_MISSING } from "../src/extensions/laya/docker.ts";
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
import { LAYA_QUESTIONS } from "../src/extensions/laya/questions.ts";
import { LAYA_PLAN_MESSAGE } from "../src/extensions/laya/routers.ts";
import { LAYA_IMAGE_PATHS, type LayaModelManifest } from "../src/extensions/laya/runtime.ts";
import { generateSeed } from "../src/extensions/laya/seed.ts";
import { TRAIN_SCRIPT } from "../src/extensions/laya/train-script.ts";
import {
	ensureWorkspace,
	LayaTrainer,
	libraryTrainingRows,
	mergeRows,
	readRegistry,
	readRows,
	type Score,
	SEED_ROWS,
	type TrainingProgress,
	type TrainingRow,
	trainingWorkspace,
	writeRegistry,
} from "../src/extensions/laya/training.ts";
import { createHarness, getAssistantTexts, type Harness } from "./suite/harness.ts";

const LABELS = {
	library_category: "engineering",
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
		expect(rows).toHaveLength(SEED_ROWS + libraryTrainingRows().length);
		expect(rows[0]).toMatchObject({ id: "r00001", source: "synthetic" });
		expect(JSON.parse(readFileSync(workspace.decisions, "utf8")).decisions.requires_git.type).toBe("noul");
		expect(readFileSync(workspace.script, "utf8")).toBe(TRAIN_SCRIPT);
		expect(readRows(workspace.boundaries)).toHaveLength(6);

		writeFileSync(workspace.dataset, `${JSON.stringify(rows[0])}\n`);
		writeFileSync(workspace.script, "outdated training script");
		ensureWorkspace(workspace);
		expect(readRows(workspace.dataset)).toHaveLength(1 + libraryTrainingRows().length);
		expect(readFileSync(workspace.script, "utf8")).toBe(TRAIN_SCRIPT);
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

const score = (correct: number, n = 100): Score => ({
	n,
	correct,
	per_question: Object.fromEntries(Object.keys(LAYA_QUESTIONS).map((id) => [id, { n, correct }])),
	library: {
		accuracy: correct / n,
		ece: 0.05,
		portuguese: { n, correct },
		boundary: { n, correct: n },
		acceptance_boundary: { n: 6, correct: 6 },
	},
});

/**
 * Docker stand-in for training: the training container reports progress and prints the scores,
 * and the cleanup container records which model paths it deletes.
 */
function fakeDocker(
	scores: { candidate: number; current: number },
	calls: string[][],
	options: { failFirst?: string; removed?: string[] } = {},
): DockerRun {
	return async (args, runOptions) => {
		if (args[0] === "rm") return { code: 0, stdout: "", stderr: "" };
		if (args.includes("-c")) {
			options.removed?.push(...args.slice(args.indexOf("-c") + 2));
			return { code: 0, stdout: "", stderr: "" };
		}
		calls.push(args);
		runOptions?.onLine?.('PROGRESS {"phase": "train", "epoch": 1, "epochs": 3, "done": 0.5, "eta_s": 240}', "stderr");
		runOptions?.onLine?.("a warning from torch", "stderr");
		const stdout =
			options.failFirst && calls.length === 1
				? JSON.stringify({
						ok: false,
						error: options.failFirst,
						message: "The GPU ran out of memory while training.",
					})
				: JSON.stringify({
						ok: true,
						seconds: 300,
						device: "cuda",
						rows: { focus: 2 },
						test: { candidate: score(scores.candidate), current: score(scores.current) },
						focus: { candidate: score(34, 36), current: score(20, 36) },
						library_min_confidence: 0.91,
					});
		return { code: 0, stdout: `${stdout}\n`, stderr: "" };
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

	function setup(docker: DockerRun, gpu = true) {
		const trainer = new LayaTrainer({
			home,
			manifest,
			docker,
			image: async () => "relay-laya:test",
			gpu: async () => gpu,
		});
		trainer.addExercises([
			{ state: { request: "Fix the pager" }, expected: { ...LABELS }, source: "session", split: "train" },
		]);
		return trainer;
	}

	it("trains in a container from the active model and activates the new one when the test score holds", async () => {
		const calls: string[][] = [];
		const trainer = setup(fakeDocker({ candidate: 97, current: 97 }, calls));
		const progress: TrainingProgress[] = [];
		const finished: unknown[] = [];
		trainer.listener = { progress: (value) => progress.push(value), finished: (value) => finished.push(value) };

		const outcome = await trainer.train();

		expect(calls[0]).toEqual(
			expect.arrayContaining([
				"--gpus",
				"all",
				`type=bind,source=${trainer.workspace.dir},target=${LAYA_IMAGE_PATHS.workspace},readonly`,
				"relay-laya:test",
				`${LAYA_IMAGE_PATHS.workspace}/train.py`,
				"learn",
				"--init",
				LAYA_IMAGE_PATHS.shippedModel,
				"--out",
				"/data/models/local-1",
				"--focus-source",
				"session",
			]),
		);
		expect(progress).toEqual([{ phase: "train", epoch: 1, epochs: 3, done: 0.5, eta_s: 240 }]);
		expect(outcome).toMatchObject({ activated: true, previous: "v1", model: { name: "local-1", basedOn: "v1" } });
		expect(finished).toEqual([{ outcome }]);
		expect(trainer.activeModel()).toEqual({ name: "local-1", dir: "/data/models/local-1" });
		expect(trainer.activeLibraryThreshold()).toBe(0.91);
		expect(trainer.running).toBe(false);

		// The next training starts from the trained model.
		await trainer.train();
		expect(calls[1][calls[1].indexOf("--init") + 1]).toBe("/data/models/local-1");
		expect(trainer.activeModel().name).toBe("local-2");
	});

	it("trains on the CPU when Docker gives the container no GPU", async () => {
		const calls: string[][] = [];
		await setup(fakeDocker({ candidate: 97, current: 97 }, calls), false).train();
		expect(calls[0]).not.toContain("--gpus");
	});

	it("keeps the current model when the new one does worse on the test", async () => {
		const trainer = setup(fakeDocker({ candidate: 90, current: 97 }, []));
		const outcome = await trainer.train();
		expect(outcome.activated).toBe(false);
		expect(trainer.activeModel().name).toBe("v1");
		expect(readRegistry(trainer.workspace).models.map((model) => model.name)).toEqual(["local-1"]);

		trainer.use("local-1");
		expect(trainer.activeModel().name).toBe("local-1");
		trainer.use("v1");
		expect(trainer.activeModel().name).toBe("v1");
		expect(trainer.activeLibraryThreshold()).toBeUndefined();
		expect(() => trainer.use("local-9")).toThrow("No trained model named local-9");
	});

	it("retries with the smallest batch when the GPU runs out of memory", async () => {
		const calls: string[][] = [];
		await setup(fakeDocker({ candidate: 97, current: 97 }, calls, { failFirst: "out_of_memory" })).train();
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual(expect.arrayContaining(["--micro-batch", "1", "--low-memory", "on"]));
	});
	it("selects a registered checkpoint when its name also matches the shipped version", async () => {
		const trainer = setup(fakeDocker({ candidate: 97, current: 97 }, []));
		const outcome = await trainer.train();
		writeRegistry(trainer.workspace, { active: "v1", models: [{ ...outcome.model, name: "v1" }] });
		trainer.use("v1");
		expect(trainer.activeModel()).toEqual({ name: "v1", dir: "/data/models/v1" });
		trainer.use("shipped");
		expect(trainer.activeModel()).toEqual({ name: "v1", dir: LAYA_IMAGE_PATHS.shippedModel });
		expect(trainer.activeLibraryThreshold()).toBeUndefined();
		trainer.use("v1");
		expect(trainer.activeModel().dir).toBe("/data/models/v1");
	});

	it("deletes old inactive models from the volume and keeps the active one", async () => {
		const removed: string[] = [];
		const trainer = setup(fakeDocker({ candidate: 97, current: 97 }, [], { removed }));
		for (let i = 0; i < 4; i++) await trainer.train();
		expect(readRegistry(trainer.workspace).models.map((model) => model.name)).toEqual([
			"local-2",
			"local-3",
			"local-4",
		]);
		expect(removed).toEqual(["/data/models/local-1"]);
		expect(trainer.activeModel().name).toBe("local-4");
	});

	it("needs session tasks", async () => {
		const trainer = new LayaTrainer({
			home,
			manifest,
			docker: fakeDocker({ candidate: 1, current: 1 }, []),
			image: async () => "relay-laya:test",
			gpu: async () => true,
		});
		const finished: unknown[] = [];
		trainer.listener = { progress: () => {}, finished: (value) => finished.push(value) };
		await expect(trainer.train()).rejects.toThrow("no session tasks to learn yet");
		expect(finished).toHaveLength(1);
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

	const withoutDocker: DockerRun = async () => ({ code: DOCKER_MISSING, stdout: "", stderr: "not found" });

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
			// No Docker in the test: the exercises are saved and training waits for /laya setup.
			extensionFactories: [(relay) => layaExtension(relay, { docker: withoutDocker })],
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
		expect(JSON.stringify(toolResult?.content)).toContain("Run /laya setup, then /laya train");

		const rows = readRows(trainingWorkspace(join(agentDir, "laya")).dataset);
		expect(rows).toHaveLength(SEED_ROWS + libraryTrainingRows().length + 1);
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
