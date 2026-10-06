import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { layaDecisionsFile } from "./questions.ts";
import type { ExecFunction, LayaModelManifest, LayaPaths } from "./runtime.ts";
import { generateSeed } from "./seed.ts";
import { TRAIN_SCRIPT } from "./train-script.ts";

/**
 * Native training of the routing model. Exercises live in a workspace in the Laya home: the
 * synthetic seed the shipped model was trained on, plus the tasks labeled from sessions
 * (`/laya learn`). Training starts from the model that routes today, and the new model replaces it
 * only when it answers the held-out test split about as well.
 */

/** One exercise in laya-trainer's dataset format. */
export interface TrainingRow {
	id: string;
	state: { request: string };
	expected: Record<string, string | number | boolean>;
	source: string;
	split?: "train" | "val" | "test";
	/** Session the task came from. */
	session?: string;
	label_source?: string;
	note?: string;
	/** What to know when doing a similar task. Shown to the model, never trained on. */
	lesson?: string;
	created?: string;
}

export interface TrainingWorkspace {
	dir: string;
	decisions: string;
	dataset: string;
	models: string;
	registry: string;
}

/** Exercises labeled from sessions. Training focuses on them; the rest is replayed. */
export const SESSION_SOURCE = "session";
/** The seed size of the shipped model: the same rows, so the same held-out test split. */
export const SEED_ROWS = 1100;
/** A new model is activated unless it answers more than this fraction fewer test questions. */
export const REGRESSION_TOLERANCE = 0.01;
/** Trained models kept besides the active one, newest first. Older ones are deleted. */
const KEEP_INACTIVE_MODELS = 2;

export function trainingWorkspace(home: string): TrainingWorkspace {
	const dir = join(home, "training");
	return {
		dir,
		decisions: join(dir, "decisions.json"),
		dataset: join(dir, "data", "dataset.jsonl"),
		models: join(dir, "models"),
		registry: join(dir, "models.json"),
	};
}

/** Writes the current questions and, on first use, the seed exercises. */
export function ensureWorkspace(workspace: TrainingWorkspace): void {
	mkdirSync(dirname(workspace.dataset), { recursive: true });
	writeFileSync(workspace.decisions, `${JSON.stringify(layaDecisionsFile(), null, 2)}\n`, "utf8");
	if (!existsSync(workspace.dataset)) {
		const rows = generateSeed(SEED_ROWS).map((row, i) => ({ id: `r${String(i + 1).padStart(5, "0")}`, ...row }));
		writeRows(workspace.dataset, rows);
	}
}

export function readRows(path: string): TrainingRow[] {
	if (!existsSync(path)) return [];
	const rows: TrainingRow[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as TrainingRow);
		} catch {
			// A line broken by hand; the training script skips it too.
		}
	}
	return rows;
}

export function writeRows(path: string, rows: readonly TrainingRow[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
}

/** Requests that differ only in case and spacing are the same exercise. */
export function requestKey(request: string): string {
	return request.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Adds rows, replacing the labels of an exercise with the same request: a later session labels it
 * with newer evidence.
 */
export function mergeRows(
	existing: readonly TrainingRow[],
	incoming: ReadonlyArray<Omit<TrainingRow, "id">>,
): { rows: TrainingRow[]; added: number; updated: number } {
	const rows = [...existing];
	const byKey = new Map(rows.map((row, index) => [requestKey(row.state.request), index]));
	let next = Math.max(0, ...rows.map((row) => Number(/^s(\d+)$/.exec(row.id)?.[1] ?? 0))) + 1;
	let added = 0;
	let updated = 0;
	for (const row of incoming) {
		const key = requestKey(row.state.request);
		const index = byKey.get(key);
		if (index === undefined) {
			byKey.set(key, rows.length);
			rows.push({ id: `s${String(next++).padStart(5, "0")}`, ...row });
			added++;
		} else {
			rows[index] = { id: rows[index].id, ...row };
			updated++;
		}
	}
	return { rows, added, updated };
}

/** Correct answers on a set of exercises, as the training script reports them. */
export interface Score {
	n: number;
	correct: number;
	per_question: Record<string, { n: number; correct: number }>;
}

export interface TrainedModel {
	name: string;
	createdAt: string;
	/** Model the training started from. */
	basedOn: string;
	sessionTasks: number;
	/** Test split: the new model and the one it started from. */
	test: { candidate: Score; current: Score };
	/** Session exercises: answers the new model and the one it started from get right. */
	session: { candidate: Score; current: Score };
	seconds: number;
	device: string;
}

export interface ModelRegistry {
	/** Trained model that routes requests. Absent: the shipped model. */
	active?: string;
	models: TrainedModel[];
}

export function readRegistry(workspace: TrainingWorkspace): ModelRegistry {
	try {
		const registry = JSON.parse(readFileSync(workspace.registry, "utf8")) as ModelRegistry;
		return { active: registry.active, models: Array.isArray(registry.models) ? registry.models : [] };
	} catch {
		return { models: [] };
	}
}

export function writeRegistry(workspace: TrainingWorkspace, registry: ModelRegistry): void {
	mkdirSync(workspace.dir, { recursive: true });
	writeFileSync(workspace.registry, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

export const accuracy = (score: Score): number => (score.n > 0 ? score.correct / score.n : 0);

/** Whether the new model answers the test split well enough to replace the current one. */
export function passesGate(test: TrainedModel["test"]): boolean {
	return accuracy(test.candidate) >= accuracy(test.current) - REGRESSION_TOLERANCE;
}

/** Removes trained models beyond the newest inactive ones, never the active one. */
export function pruneModels(workspace: TrainingWorkspace, registry: ModelRegistry): ModelRegistry {
	// The registry lists models in the order they were trained.
	const inactive = registry.models.filter((model) => model.name !== registry.active).reverse();
	const removed = new Set(inactive.slice(KEEP_INACTIVE_MODELS).map((model) => model.name));
	for (const name of removed) rmSync(join(workspace.models, name), { recursive: true, force: true });
	return { ...registry, models: registry.models.filter((model) => !removed.has(model.name)) };
}

export interface TrainingProgress {
	phase: "train" | "evaluate";
	epoch?: number;
	epochs?: number;
	done?: number;
	eta_s?: number;
	device?: string;
	model?: "new" | "current";
}

export function describeProgress(progress: TrainingProgress): string {
	if (progress.phase === "evaluate") {
		return progress.model === "current" ? "comparing with the current model" : "testing the new model";
	}
	if (!progress.epoch) return `starting on ${progress.device ?? "the device"}`;
	const minutes = progress.eta_s === undefined ? undefined : Math.max(1, Math.round(progress.eta_s / 60));
	return `round ${progress.epoch}/${progress.epochs} ${Math.round((progress.done ?? 0) * 100)}%${
		minutes && progress.done !== 1 ? `, about ${minutes} min left` : ""
	}`;
}

/** A running training process: its stderr lines as they come, and its exit. */
export interface TrainingProcess {
	done: Promise<{ code: number; stdout: string }>;
	kill(): void;
}

export type SpawnTraining = (
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	onStderrLine: (line: string) => void,
) => TrainingProcess;

const spawnTraining: SpawnTraining = (command, args, env, onStderrLine) => {
	const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let pending = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		const lines = (pending + chunk).split(/\r?\n/);
		pending = lines.pop() ?? "";
		for (const line of lines) onStderrLine(line);
	});
	return {
		done: new Promise((resolve) => {
			child.once("error", (error) =>
				resolve({ code: 1, stdout: JSON.stringify({ ok: false, message: error.message }) }),
			);
			child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
		}),
		kill: () => {
			if (!child.pid || child.exitCode !== null) return;
			if (process.platform === "win32") {
				spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
			} else {
				child.kill();
			}
		},
	};
};

type ScriptResult =
	| {
			ok: true;
			seconds: number;
			device: string;
			rows: { focus: number };
			test: TrainedModel["test"];
			focus: TrainedModel["session"];
	  }
	| { ok: false; error?: string; message: string };

export interface TrainingOutcome {
	model: TrainedModel;
	/** Whether the new model now routes requests. */
	activated: boolean;
	/** Model that routed before. */
	previous: string;
}

export interface TrainingListener {
	progress(progress: TrainingProgress): void;
	finished(result: { outcome: TrainingOutcome } | { error: Error }): void;
}

export interface LayaTrainerOptions {
	home: string;
	manifest: LayaModelManifest;
	paths: LayaPaths;
	spawn?: SpawnTraining;
}

/**
 * Runs one training at a time. It belongs to the process, not to a session runtime, so training
 * goes on across `/new` and `/resume`; `listener` is the latest runtime that wants its events.
 */
export class LayaTrainer {
	readonly workspace: TrainingWorkspace;
	private readonly options: LayaTrainerOptions;
	private child: TrainingProcess | undefined;
	private job: Promise<TrainingOutcome> | undefined;
	/** Latest progress of the running training. */
	progress: TrainingProgress | undefined;
	listener: TrainingListener | undefined;

	constructor(options: LayaTrainerOptions) {
		this.options = options;
		this.workspace = trainingWorkspace(options.home);
	}

	get running(): boolean {
		return this.job !== undefined;
	}

	/** The model that routes requests: the active trained model, or the shipped one. */
	activeModel(): { name: string; dir: string } {
		const active = readRegistry(this.workspace).active;
		const dir = active ? join(this.workspace.models, active) : undefined;
		if (active && dir && existsSync(join(dir, "model.safetensors"))) return { name: active, dir };
		return { name: this.options.manifest.version, dir: this.options.paths.model };
	}

	/** Selects the model that routes requests; the shipped model's version selects it. */
	use(name: string): void {
		const registry = readRegistry(this.workspace);
		if (name === this.options.manifest.version) {
			writeRegistry(this.workspace, { ...registry, active: undefined });
			return;
		}
		if (!registry.models.some((model) => model.name === name) || !existsSync(join(this.workspace.models, name))) {
			throw new Error(
				`No trained model named ${name}. Models: ${[this.options.manifest.version, ...registry.models.map((model) => model.name)].join(", ")}`,
			);
		}
		writeRegistry(this.workspace, { ...registry, active: name });
	}

	/** Exercises in the workspace, by source. */
	counts(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const row of readRows(this.workspace.dataset)) counts[row.source] = (counts[row.source] ?? 0) + 1;
		return counts;
	}

	/** Adds labeled session tasks to the workspace. */
	addExercises(rows: ReadonlyArray<Omit<TrainingRow, "id">>): { added: number; updated: number } {
		ensureWorkspace(this.workspace);
		const merged = mergeRows(readRows(this.workspace.dataset), rows);
		writeRows(this.workspace.dataset, merged.rows);
		return { added: merged.added, updated: merged.updated };
	}

	/**
	 * Trains a new model from the active one and activates it when it passes the test gate. The
	 * listener hears the result too, so a caller that does not wait only needs to catch.
	 */
	train(): Promise<TrainingOutcome> {
		if (this.job) return Promise.reject(new Error("Laya is already training"));
		this.job = this.run()
			.finally(() => {
				this.job = undefined;
				this.child = undefined;
				this.progress = undefined;
			})
			.then(
				(outcome) => {
					this.listener?.finished({ outcome });
					return outcome;
				},
				(error: unknown) => {
					const failure = error instanceof Error ? error : new Error(String(error));
					this.listener?.finished({ error: failure });
					throw failure;
				},
			);
		return this.job;
	}

	stop(): void {
		this.child?.kill();
	}

	private async run(): Promise<TrainingOutcome> {
		const { paths } = this.options;
		if (!existsSync(paths.venvPython)) throw new Error("Laya is not installed. Run /laya setup first.");
		ensureWorkspace(this.workspace);
		if (!readRows(this.workspace.dataset).some((row) => row.source === SESSION_SOURCE)) {
			throw new Error("There are no session tasks to learn yet. Run /laya learn in a session first.");
		}
		writeFileSync(paths.trainScript, TRAIN_SCRIPT, "utf8");
		const registry = readRegistry(this.workspace);
		const base = this.activeModel();
		if (!existsSync(join(base.dir, "model.safetensors"))) {
			throw new Error(`The ${base.name} model is not downloaded. Run /laya setup first.`);
		}
		const number = Math.max(0, ...registry.models.map((model) => Number(/^local-(\d+)$/.exec(model.name)?.[1] ?? 0)));
		const name = `local-${number + 1}`;
		const out = join(this.workspace.models, name);
		rmSync(out, { recursive: true, force: true });

		const args = [
			paths.trainScript,
			"learn",
			"--workspace",
			this.workspace.dir,
			"--init",
			base.dir,
			"--out",
			out,
			"--focus-source",
			SESSION_SOURCE,
		];
		let result = await this.runScript(args);
		if (!result.ok && result.error === "out_of_memory") {
			// The smallest batch that still trains; the GPU may have been shared with another process.
			result = await this.runScript([...args, "--micro-batch", "1", "--grad-accum", "16", "--low-memory", "on"]);
		}
		if (!result.ok) {
			rmSync(out, { recursive: true, force: true });
			throw new Error(result.message);
		}

		const model: TrainedModel = {
			name,
			createdAt: new Date().toISOString(),
			basedOn: base.name,
			sessionTasks: result.rows.focus,
			test: result.test,
			session: result.focus,
			seconds: result.seconds,
			device: result.device,
		};
		const activated = passesGate(model.test);
		const updated = { active: activated ? name : registry.active, models: [...registry.models, model] };
		writeRegistry(this.workspace, pruneModels(this.workspace, updated));
		return { model, activated, previous: base.name };
	}

	private async runScript(args: string[]): Promise<ScriptResult> {
		const stderr: string[] = [];
		const child = (this.options.spawn ?? spawnTraining)(
			this.options.paths.venvPython,
			args,
			{
				...process.env,
				USE_TF: "0",
				HF_HUB_OFFLINE: "1",
				TRANSFORMERS_OFFLINE: "1",
				TOKENIZERS_PARALLELISM: "false",
				PYTHONIOENCODING: "utf-8",
			},
			(line) => {
				if (line.startsWith("PROGRESS ")) {
					try {
						this.progress = JSON.parse(line.slice("PROGRESS ".length)) as TrainingProgress;
						this.listener?.progress(this.progress);
					} catch {
						// Not a progress line after all.
					}
				} else if (line.trim()) {
					stderr.push(line);
					if (stderr.length > 20) stderr.shift();
				}
			},
		);
		this.child = child;
		const { code, stdout } = await child.done;
		const last = stdout.trim().split("\n").at(-1) ?? "";
		try {
			return JSON.parse(last) as ScriptResult;
		} catch {
			const detail = stderr.slice(-4).join(" ").trim();
			return { ok: false, message: `The training script exited with code ${code}${detail ? `: ${detail}` : ""}` };
		}
	}
}

const trainers = new Map<string, LayaTrainer>();

/** The trainer of a Laya home, shared by every session runtime of the process. */
export function sharedTrainer(options: LayaTrainerOptions): LayaTrainer {
	let trainer = trainers.get(options.home);
	if (!trainer) {
		trainer = new LayaTrainer(options);
		trainers.set(options.home, trainer);
	}
	return trainer;
}

/** Whether training can use a GPU. Without one it still works, slowly. */
export async function hasAccelerator(exec: ExecFunction): Promise<boolean> {
	if (process.platform === "darwin" && process.arch === "arm64") return true;
	try {
		return (await exec("nvidia-smi", ["-L"], { timeout: 10_000 })).code === 0;
	} catch {
		return false;
	}
}
