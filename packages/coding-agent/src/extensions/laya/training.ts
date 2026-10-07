import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DockerRun, dockerError } from "./docker.ts";
import { layaDecisionsFile } from "./questions.ts";
import {
	LAYA_IMAGE_PATHS,
	LAYA_MODELS_VOLUME,
	LAYA_TRAIN_CONTAINER,
	type LayaModelManifest,
	trainedModelPath,
} from "./runtime.ts";
import { generateSeed } from "./seed.ts";

/**
 * Training of the routing model, in a Docker container. Exercises live in a workspace in the Laya
 * home on the host: the synthetic seed the shipped model was trained on, plus the tasks labeled from
 * sessions (`/laya learn`). The container reads the workspace and writes the new model to the models
 * volume. Training starts from the model that routes today, and the new model replaces it only when
 * it answers the held-out test split about as well.
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

/** Keeps the newest inactive models and the active one; returns the names to delete. */
export function pruneModels(registry: ModelRegistry): { registry: ModelRegistry; removed: string[] } {
	// The registry lists models in the order they were trained.
	const inactive = registry.models.filter((model) => model.name !== registry.active).reverse();
	const removed = inactive.slice(KEEP_INACTIVE_MODELS).map((model) => model.name);
	return {
		registry: { ...registry, models: registry.models.filter((model) => !removed.includes(model.name)) },
		removed,
	};
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
	docker: DockerRun;
	/** Image the training container runs; the server's image. */
	image: () => Promise<string>;
	/** Whether the training container can use an NVIDIA GPU. */
	gpu: () => Promise<boolean>;
}

/** Runs a Python one-liner in the image, with the models volume mounted. */
function inImage(image: string, code: string, extra: string[] = [], gpu = false): string[] {
	return [
		"run",
		"--rm",
		...(gpu ? ["--gpus", "all"] : []),
		"--volume",
		`${LAYA_MODELS_VOLUME}:${LAYA_IMAGE_PATHS.trainedModels}`,
		image,
		"python",
		"-c",
		code,
		...extra,
	];
}

/** Whether a container of the image sees an NVIDIA GPU: needs the CUDA image and Docker GPU support. */
export async function dockerHasGpu(docker: DockerRun, image: string): Promise<boolean> {
	const result = await docker(
		inImage(image, "import sys, torch; sys.exit(0 if torch.cuda.is_available() else 1)", [], true),
		{ timeout: 120_000 },
	);
	return result.code === 0;
}

/**
 * Runs one training at a time. It belongs to the process, not to a session runtime, so training
 * goes on across `/new` and `/resume`; `listener` is the latest runtime that wants its events.
 */
export class LayaTrainer {
	readonly workspace: TrainingWorkspace;
	private readonly options: LayaTrainerOptions;
	private abort: AbortController | undefined;
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

	/** The model that routes requests, with its path inside the containers: the active trained model, or the shipped one. */
	activeModel(): { name: string; dir: string } {
		const registry = readRegistry(this.workspace);
		const active = registry.active;
		if (active && registry.models.some((model) => model.name === active)) {
			return { name: active, dir: trainedModelPath(active) };
		}
		return { name: this.options.manifest.version, dir: LAYA_IMAGE_PATHS.shippedModel };
	}

	/** Selects the model that routes requests; the shipped model's version selects it. */
	use(name: string): void {
		const registry = readRegistry(this.workspace);
		if (name === this.options.manifest.version) {
			writeRegistry(this.workspace, { ...registry, active: undefined });
			return;
		}
		if (!registry.models.some((model) => model.name === name)) {
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
		this.abort = new AbortController();
		this.job = this.run(this.abort.signal)
			.finally(() => {
				this.job = undefined;
				this.abort = undefined;
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

	/** Stops a running training and removes its container. */
	stop(): void {
		if (!this.abort) return;
		this.abort.abort();
		void this.options.docker(["rm", "--force", LAYA_TRAIN_CONTAINER], { timeout: 60_000 });
	}

	private async run(signal: AbortSignal): Promise<TrainingOutcome> {
		ensureWorkspace(this.workspace);
		if (!readRows(this.workspace.dataset).some((row) => row.source === SESSION_SOURCE)) {
			throw new Error("There are no session tasks to learn yet. Run /laya learn in a session first.");
		}
		const image = await this.options.image();
		const gpu = await this.options.gpu();
		const registry = readRegistry(this.workspace);
		const base = this.activeModel();
		const number = Math.max(0, ...registry.models.map((model) => Number(/^local-(\d+)$/.exec(model.name)?.[1] ?? 0)));
		const name = `local-${number + 1}`;
		const out = trainedModelPath(name);
		// A container left by a training that was killed would block the name.
		await this.options.docker(["rm", "--force", LAYA_TRAIN_CONTAINER], { timeout: 60_000 });

		const args = [
			"run",
			"--rm",
			"--name",
			LAYA_TRAIN_CONTAINER,
			...(gpu ? ["--gpus", "all"] : []),
			"--volume",
			`${LAYA_MODELS_VOLUME}:${LAYA_IMAGE_PATHS.trainedModels}`,
			"--mount",
			`type=bind,source=${this.workspace.dir},target=${LAYA_IMAGE_PATHS.workspace},readonly`,
			image,
			"python",
			LAYA_IMAGE_PATHS.trainScript,
			"learn",
			"--workspace",
			LAYA_IMAGE_PATHS.workspace,
			"--init",
			base.dir,
			"--out",
			out,
			"--focus-source",
			SESSION_SOURCE,
		];
		let result = await this.runScript(args, signal);
		if (!result.ok && result.error === "out_of_memory") {
			// The smallest batch that still trains; the GPU may have been shared with another process.
			result = await this.runScript(
				[...args, "--micro-batch", "1", "--grad-accum", "16", "--low-memory", "on"],
				signal,
			);
		}
		if (!result.ok) {
			await this.removeModels(image, [name]);
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
		const pruned = pruneModels({ active: activated ? name : registry.active, models: [...registry.models, model] });
		writeRegistry(this.workspace, pruned.registry);
		await this.removeModels(image, pruned.removed);
		return { model, activated, previous: base.name };
	}

	/** Deletes trained models from the volume. */
	private async removeModels(image: string, names: string[]): Promise<void> {
		if (names.length === 0) return;
		await this.options.docker(
			inImage(
				image,
				"import shutil, sys; [shutil.rmtree(path, ignore_errors=True) for path in sys.argv[1:]]",
				names.map(trainedModelPath),
			),
			{ timeout: 120_000 },
		);
	}

	private async runScript(args: string[], signal: AbortSignal): Promise<ScriptResult> {
		const stderr: string[] = [];
		const result = await this.options.docker(args, {
			signal,
			onLine: (line, stream) => {
				if (stream === "stdout") return;
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
		});
		if (signal.aborted) return { ok: false, message: "Training was stopped" };
		const last = result.stdout.trim().split("\n").at(-1) ?? "";
		try {
			return JSON.parse(last) as ScriptResult;
		} catch {
			const detail = stderr.slice(-4).join(" ").trim() || dockerError(result);
			return { ok: false, message: `The training container exited with code ${result.code}: ${detail}` };
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
