import { SESSION_SOURCE, type TrainingRow } from "./training.ts";

/**
 * Memory of the tasks taught with `/laya learn`. Training takes minutes on a GPU and needs the Laya
 * environment; the memory works from the next request. A request close to a learned task is routed
 * with that task's labels, and the model that runs it gets the lessons of similar tasks.
 *
 * Similarity is the cosine of TF-IDF word vectors. Word weights come from every exercise of the
 * workspace, so words common to all coding requests ("fix", "add", "file") count little and the
 * specific ones ("pager", "off-by-one", "token expiry") decide.
 */

/** A learned task close enough for its labels to route a new request. */
export const ROUTE_SIMILARITY = 0.6;
/** A learned task close enough for its lesson to be worth reading. */
export const LESSON_SIMILARITY = 0.45;

export interface LearnedTask {
	id: string;
	request: string;
	expected: TrainingRow["expected"];
	lesson?: string;
}

export interface MemoryMatch {
	task: LearnedTask;
	similarity: number;
}

const STOPWORDS = new Set(
	(
		"the a an and or of to in on at for with from by is are be it this that these those i you we me my our your " +
		"please can could would should will do does did not no so as if then than into about all any some " +
		"o a os as um uma uns umas de do da dos das no na nos nas em para por com sem e ou que se nao isso este esta " +
		"esse essa ele ela eu voce meu minha seu sua pelo pela ao aos mais mas como ja tambem favor"
	).split(" "),
);

/** Words of a request: identifiers split at case changes, accents removed, stopwords dropped. */
export function words(text: string): string[] {
	return text
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

type Vector = Map<string, number>;

export class TaskMemory {
	readonly tasks: readonly LearnedTask[];
	private readonly idf: Map<string, number>;
	private readonly defaultIdf: number;
	private readonly vectors: Vector[];

	/** `corpus` is every request the word weights are counted over; it includes the tasks. */
	constructor(tasks: readonly LearnedTask[], corpus: readonly string[]) {
		this.tasks = tasks;
		const documents = corpus.length;
		const frequency = new Map<string, number>();
		for (const request of corpus) {
			for (const word of new Set(words(request))) frequency.set(word, (frequency.get(word) ?? 0) + 1);
		}
		this.idf = new Map([...frequency].map(([word, count]) => [word, Math.log((documents + 1) / (count + 1)) + 1]));
		this.defaultIdf = Math.log(documents + 1) + 1;
		this.vectors = tasks.map((task) => this.vector(task.request));
	}

	/** Session tasks of a training dataset, weighted over all of its exercises. */
	static fromRows(rows: readonly TrainingRow[]): TaskMemory {
		const tasks = rows
			.filter((row) => row.source === SESSION_SOURCE && row.state?.request)
			.map((row) => ({ id: row.id, request: row.state.request, expected: row.expected, lesson: row.lesson }));
		return new TaskMemory(
			tasks,
			rows.flatMap((row) => (row.state?.request ? [row.state.request] : [])),
		);
	}

	get size(): number {
		return this.tasks.length;
	}

	private vector(text: string): Vector {
		const counts = new Map<string, number>();
		for (const word of words(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
		const vector: Vector = new Map();
		let norm = 0;
		for (const [word, count] of counts) {
			const weight = (1 + Math.log(count)) * (this.idf.get(word) ?? this.defaultIdf);
			vector.set(word, weight);
			norm += weight * weight;
		}
		norm = Math.sqrt(norm);
		for (const [word, weight] of vector) vector.set(word, weight / norm);
		return vector;
	}

	/** Learned tasks at least `minSimilarity` close to the request, closest first. */
	search(request: string, minSimilarity: number, limit = 3): MemoryMatch[] {
		if (this.tasks.length === 0) return [];
		const query = this.vector(request);
		const matches: MemoryMatch[] = [];
		this.vectors.forEach((vector, index) => {
			let similarity = 0;
			for (const [word, weight] of query) similarity += weight * (vector.get(word) ?? 0);
			if (similarity >= minSimilarity) matches.push({ task: this.tasks[index], similarity });
		});
		return matches.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
	}
}

/** Custom message with the lessons, sent next to the request when laya/auto does not route it. */
export const LAYA_LESSONS_MESSAGE = "laya.lessons";

/**
 * Lessons of similar tasks for the model that runs the request, or undefined when none has one.
 * The plan message includes the text as one item; other models get it with the `[laya:lessons]` prefix.
 */
export function renderLessons(matches: readonly MemoryMatch[]): string | undefined {
	const clip = (text: string) => {
		const flat = text.replace(/\s+/g, " ").trim();
		return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat;
	};
	const lines = matches.flatMap((match) =>
		match.task.lesson
			? [`  - "${clip(match.task.request)}" (${Math.round(match.similarity * 100)}% similar): ${match.task.lesson}`]
			: [],
	);
	if (lines.length === 0) return undefined;
	return ["Lessons from similar tasks done before in this harness (check they still apply):", ...lines].join("\n");
}
