import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * In-process relay-laya inference on Node (ACI phase 1). It ports the input encoding and answer
 * decoding of laya 0.3.27's `ONNXAgent` and runs the exported `onnx/laya.onnx` graph through
 * `@huggingface/transformers` (tokenizer + ONNX Runtime). It is not wired into routing: the
 * Python runtime stays authoritative until parity with `test/fixtures/aci-laya-parity-reference.json`
 * is proven on the target machine.
 */

type QuestionType = "choice" | "score" | "noul";
const QTYPE_INDEX: Record<QuestionType, number> = { choice: 0, score: 1, noul: 2 };
const QTYPE_NAMES: QuestionType[] = ["choice", "score", "noul"];
const TEMP_MIN = 0.5;
const TEMP_MAX = 5;
const OPTION_TOKEN_CAP = 48;
const DEFAULT_MAX_LEN = 512;
const DEFAULT_HEAD_MAX_LEN = 192;

/** A question as the product sends it. `bool` is converted to `noul`, like the wire request does. */
export interface LayaQuestionDefinition {
	type: QuestionType | "bool";
	instructions: string;
	criteria?: Record<string, unknown> | unknown[];
}

interface InternalQuestion {
	type: QuestionType;
	instructions: string;
	criteria: Record<string, unknown> | unknown[] | undefined;
}

export interface LayaTokenizer {
	encode(text: string): number[];
	maskToken: string;
	maskId: number;
	clsId: number;
	sepId: number;
	padId: number;
}

export interface LayaModelConfig {
	maxLen: number;
	headMaxLen: number;
	/** One temperature per question type (choice, score, noul). */
	temperature: [number, number, number];
	temperatureByOptions: Record<string, number>;
}

export interface EncodedQuestion {
	ids: number[];
	markers: number[];
	qtype: number;
}

export interface LayaBatch {
	inputIds: BigInt64Array;
	attentionMask: BigInt64Array;
	markerPos: BigInt64Array;
	markerMask: Uint8Array;
	qtype: BigInt64Array;
	rows: number;
	length: number;
	options: number;
}

export interface LayaModelOutput {
	/** Row-major `[rows, options]`. */
	logits: ArrayLike<number>;
	options: number;
	/** Row-major `[rows, 2]`. */
	actLogits: ArrayLike<number>;
}

export type LayaAnswer =
	| {
			type: "choice";
			choice: string;
			probabilities: Record<string, number>;
			confidence: number;
			answer_confidence: number;
			action: { act_probability: number };
	  }
	| {
			type: "score";
			score: number;
			legend: Record<string, string>;
			probabilities: Record<string, number>;
			confidence: number;
			answer_confidence: number;
			action: { act_probability: number };
	  }
	| {
			type: "noul";
			noul: number;
			confidence: number;
			answer_confidence: number;
			action: { act_probability: number };
	  };

/** Python's `json.dumps(value, ensure_ascii=False)` layout, which laya uses to render structured criteria. */
function pythonJson(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
	if (typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`)
			.join(", ")}}`;
	return JSON.stringify(value);
}

function renderCriterion(value: unknown): string {
	return typeof value === "string" ? value : pythonJson(value);
}

function isBlank(value: unknown): boolean {
	return value === undefined || value === null || value === "";
}

export function toInternalQuestion(id: string, definition: LayaQuestionDefinition): InternalQuestion {
	const type = definition.type === "bool" ? "noul" : definition.type;
	if (!QTYPE_NAMES.includes(type)) throw new Error(`Laya question ${id}: unsupported type ${String(definition.type)}`);
	if (typeof definition.instructions !== "string" || definition.instructions === "")
		throw new Error(`Laya question ${id}: instructions must be a non-empty string`);
	let criteria = definition.criteria;
	if (type === "choice" && Array.isArray(criteria))
		criteria = Object.fromEntries(criteria.map((name) => [String(name), null]));
	if (type === "noul" && criteria && !Array.isArray(criteria))
		criteria = Object.fromEntries(Object.entries(criteria).map(([key, value]) => [key.toLowerCase(), value]));
	if (type === "choice" && (!criteria || Array.isArray(criteria) || Object.keys(criteria).length < 2))
		throw new Error(`Laya question ${id}: choice questions need at least two criteria`);
	if (type === "score" && (!Array.isArray(criteria) || criteria.length < 2))
		throw new Error(`Laya question ${id}: score questions need at least two levels`);
	return { type, instructions: definition.instructions, criteria };
}

/** Option texts in label-index order. Noul options are always `[false, true]`. */
export function renderOptions(question: InternalQuestion): string[] {
	const { type, criteria } = question;
	if (type === "choice") {
		return Object.entries(criteria as Record<string, unknown>).map(([key, value]) =>
			isBlank(value) ? key : `${key}: ${renderCriterion(value)}`,
		);
	}
	if (type === "score")
		return (criteria as unknown[]).map((level, index) => `level ${index}: ${renderCriterion(level)}`);
	const byLabel = (criteria ?? {}) as Record<string, unknown>;
	return [
		`false: ${isBlank(byLabel.false) ? "no, the statement does not hold" : renderCriterion(byLabel.false)}`,
		`true: ${isBlank(byLabel.true) ? "yes, the statement holds" : renderCriterion(byLabel.true)}`,
	];
}

function withoutMask(text: string, tokenizer: LayaTokenizer): string {
	return text.split(tokenizer.maskToken).join(" ");
}

function sum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

/** `[CLS] <type> question: instructions [SEP] [MASK] opt0 [MASK] opt1 ... [SEP]` and the `[MASK]` positions. */
export function buildHead(
	tokenizer: LayaTokenizer,
	question: InternalQuestion,
	headMaxLen: number,
): { ids: number[]; markers: number[] } {
	const options = renderOptions(question);
	let optionIds = options.map((option) => [
		tokenizer.maskId,
		...tokenizer.encode(` ${withoutMask(option, tokenizer)}`).slice(0, OPTION_TOKEN_CAP),
	]);
	let headIds = tokenizer.encode(`${question.type} question: ${withoutMask(question.instructions, tokenizer)}`);
	let optionBudget = headMaxLen - sum(optionIds.map((ids) => ids.length));
	if (optionBudget < 16) {
		const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optionIds.length)));
		optionIds = optionIds.map((ids) => ids.slice(0, per));
		optionBudget = headMaxLen - sum(optionIds.map((ids) => ids.length));
	}
	headIds = headIds.slice(0, Math.max(8, optionBudget));
	const ids = [tokenizer.clsId, ...headIds, tokenizer.sepId];
	const markers: number[] = [];
	for (const option of optionIds) {
		markers.push(ids.length);
		ids.push(...option);
	}
	ids.push(tokenizer.sepId);
	return { ids, markers };
}

/** The question rows for one request. The shared state is tokenized once. */
export function encodeRequest(
	tokenizer: LayaTokenizer,
	request: string,
	questions: Record<string, LayaQuestionDefinition>,
	config: Pick<LayaModelConfig, "maxLen" | "headMaxLen">,
): { ids: string[]; internal: Record<string, InternalQuestion>; rows: EncodedQuestion[] } {
	if (typeof request !== "string" || request.trim() === "") throw new Error("Laya request must be a non-empty string");
	const ids = Object.keys(questions);
	if (ids.length === 0) throw new Error("Laya needs at least one question");
	// laya serializes the state dict with `json.dumps(state, ensure_ascii=False)`: `{"request": "..."}`.
	const stateIds = tokenizer.encode(withoutMask(`{"request": ${JSON.stringify(request)}}`, tokenizer));
	const internal: Record<string, InternalQuestion> = {};
	const rows = ids.map((id) => {
		const question = toInternalQuestion(id, questions[id] as LayaQuestionDefinition);
		internal[id] = question;
		const head = buildHead(tokenizer, question, config.headMaxLen);
		const room = Math.max(0, config.maxLen - head.ids.length - 1);
		const sequence = [...head.ids, ...stateIds.slice(0, room), tokenizer.sepId].slice(0, config.maxLen);
		const markers = head.markers.filter((position) => position < config.maxLen);
		if (markers.length !== head.markers.length)
			throw new Error(
				`Laya question ${id}: only ${markers.length} of ${head.markers.length} option markers fit in max_len=${config.maxLen}`,
			);
		return { ids: sequence, markers, qtype: QTYPE_INDEX[question.type] };
	});
	return { ids, internal, rows };
}

/** Pads the question rows into the tensors the ONNX graph takes. */
export function collate(rows: EncodedQuestion[], padId: number): LayaBatch {
	const length = Math.max(...rows.map((row) => row.ids.length));
	const options = Math.max(...rows.map((row) => row.markers.length));
	const inputIds = new BigInt64Array(rows.length * length).fill(BigInt(padId));
	const attentionMask = new BigInt64Array(rows.length * length);
	const markerPos = new BigInt64Array(rows.length * options);
	const markerMask = new Uint8Array(rows.length * options);
	const qtype = new BigInt64Array(rows.length);
	rows.forEach((row, index) => {
		row.ids.forEach((id, position) => {
			inputIds[index * length + position] = BigInt(id);
			attentionMask[index * length + position] = 1n;
		});
		row.markers.forEach((position, slot) => {
			markerPos[index * options + slot] = BigInt(position);
			markerMask[index * options + slot] = 1;
		});
		qtype[index] = BigInt(row.qtype);
	});
	return { inputIds, attentionMask, markerPos, markerMask, qtype, rows: rows.length, length, options };
}

function clampTemperature(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 1;
	return Math.min(TEMP_MAX, Math.max(TEMP_MIN, value));
}

function temperatureBucket(qtype: number, options: number): string {
	const size = options <= 2 ? "2" : options <= 5 ? "3-5" : options <= 10 ? "6-10" : "11+";
	return `${QTYPE_NAMES[qtype]}:${size}`;
}

function round4(value: number): number {
	return Math.round(value * 1e4) / 1e4;
}

function softmax(values: number[]): number[] {
	const max = Math.max(...values);
	const exps = values.map((value) => Math.exp(value - max));
	const total = sum(exps);
	return exps.map((value) => value / total);
}

/** Normalized Shannon entropy confidence: `1 - H(p) / log(k)`. */
function entropyConfidence(p: number[], k: number): number {
	if (k < 2) return 1;
	const entropy = -sum(p.slice(0, k).map((value) => value * Math.log(Math.min(1, Math.max(1e-12, value)))));
	return Math.min(1, Math.max(0, 1 - entropy / Math.log(k)));
}

/** Turns the graph outputs back into laya answers, one per question. */
export function decodeAnswers(
	output: LayaModelOutput,
	ids: string[],
	internal: Record<string, InternalQuestion>,
	rows: EncodedQuestion[],
	config: Pick<LayaModelConfig, "temperature" | "temperatureByOptions">,
): Record<string, LayaAnswer> {
	const answers: Record<string, LayaAnswer> = {};
	ids.forEach((id, row) => {
		const question = internal[id] as InternalQuestion;
		const encoded = rows[row] as EncodedQuestion;
		const k = encoded.markers.length;
		const scale = clampTemperature(
			config.temperatureByOptions[temperatureBucket(encoded.qtype, k)] ?? config.temperature[encoded.qtype],
		);
		const logits = Array.from({ length: k }, (_, slot) => Number(output.logits[row * output.options + slot]) / scale);
		const p = softmax(logits);
		const confidence = round4(entropyConfidence(p, k));
		const answerConfidence = round4(Math.min(1, Math.max(0, Math.max(...p))));
		const act = softmax([Number(output.actLogits[row * 2]), Number(output.actLogits[row * 2 + 1])]);
		const action = { act_probability: round4(act[0] as number) };
		if (question.type === "choice") {
			const keys = Object.keys(question.criteria as Record<string, unknown>);
			answers[id] = {
				type: "choice",
				choice: keys[p.indexOf(Math.max(...p))] as string,
				probabilities: Object.fromEntries(keys.map((key, index) => [key, round4(p[index] as number)])),
				confidence,
				answer_confidence: answerConfidence,
				action,
			};
		} else if (question.type === "score") {
			const levels = question.criteria as unknown[];
			answers[id] = {
				type: "score",
				score: round4(sum(p.map((value, level) => value * level))),
				legend: Object.fromEntries(levels.map((level, index) => [String(index), renderCriterion(level)])),
				probabilities: Object.fromEntries(p.map((value, index) => [String(index), round4(value)])),
				confidence,
				answer_confidence: answerConfidence,
				action,
			};
		} else {
			const yes = p[1] as number;
			answers[id] = {
				type: "noul",
				noul: round4(yes),
				confidence: round4(Math.max(yes, 1 - yes)),
				answer_confidence: answerConfidence,
				action,
			};
		}
	});
	return answers;
}

interface TransformersTokenizer {
	encode(text: string, options: { add_special_tokens: boolean }): number[];
	convert_tokens_to_ids(token: string): number;
}

interface TransformersSession {
	run(feeds: Record<string, unknown>): Promise<{
		logits: { data: ArrayLike<number>; dims: number[] };
		act_logits: { data: ArrayLike<number> };
	}>;
}

type TensorConstructor = new (type: string, data: ArrayLike<number | bigint>, dims: number[]) => unknown;

interface TransformersModel {
	sessions: { model: TransformersSession };
	dispose?: () => Promise<unknown>;
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Layout of `dir` (a snapshot of `eltonssouza/relay-laya` limited to what inference needs):
 * `config.json` (encoder config), `tokenizer.json`, `tokenizer_config.json`, `rl_agent_config.json`
 * and `onnx/laya.onnx`.
 */
export class LayaOnnxClassifier {
	private readonly tokenizer: LayaTokenizer;
	private readonly config: LayaModelConfig;
	private readonly model: TransformersModel;
	private readonly Tensor: TensorConstructor;

	private constructor(
		tokenizer: LayaTokenizer,
		config: LayaModelConfig,
		model: TransformersModel,
		Tensor: TensorConstructor,
	) {
		this.tokenizer = tokenizer;
		this.config = config;
		this.model = model;
		this.Tensor = Tensor;
	}

	static async load(dir: string): Promise<LayaOnnxClassifier> {
		const posixDir = dir.split("\\").join("/");
		const agent = readJson<{
			max_len?: number;
			head_max_len?: number;
			temperature?: number[];
			temperature_by_options?: Record<string, number>;
		}>(join(dir, "rl_agent_config.json"));
		const tokenizerConfig = readJson<Record<string, string>>(join(dir, "tokenizer_config.json"));
		const transformers = await import("@huggingface/transformers");
		const hf = (await transformers.AutoTokenizer.from_pretrained(posixDir, {
			local_files_only: true,
		})) as unknown as TransformersTokenizer;
		const idOf = (key: string): number => {
			const token = tokenizerConfig[key];
			const id = token === undefined ? undefined : hf.convert_tokens_to_ids(token);
			if (typeof id !== "number") throw new Error(`Laya tokenizer has no ${key} in ${dir}`);
			return id;
		};
		const maskToken = tokenizerConfig.mask_token;
		if (!maskToken) throw new Error(`Laya tokenizer_config.json in ${dir} has no mask_token`);
		const tokenizer: LayaTokenizer = {
			encode: (text) => hf.encode(text, { add_special_tokens: false }),
			maskToken,
			maskId: idOf("mask_token"),
			clsId: idOf("cls_token"),
			sepId: idOf("sep_token"),
			padId: idOf("pad_token"),
		};
		const temperature = (agent.temperature ?? [1, 1, 1]).map(clampTemperature);
		const model = (await transformers.AutoModel.from_pretrained(posixDir, {
			local_files_only: true,
			subfolder: "onnx",
			model_file_name: "laya",
			dtype: "fp32",
		})) as unknown as TransformersModel;
		if (typeof model.sessions?.model?.run !== "function")
			throw new Error(`Laya ONNX model in ${dir} did not expose an inference session`);
		return new LayaOnnxClassifier(
			tokenizer,
			{
				maxLen: agent.max_len ?? DEFAULT_MAX_LEN,
				headMaxLen: agent.head_max_len ?? DEFAULT_HEAD_MAX_LEN,
				temperature: [temperature[0] ?? 1, temperature[1] ?? 1, temperature[2] ?? 1],
				temperatureByOptions: Object.fromEntries(
					Object.entries(agent.temperature_by_options ?? {}).map(([key, value]) => [key, clampTemperature(value)]),
				),
			},
			model,
			transformers.Tensor as unknown as TensorConstructor,
		);
	}

	/** Answers every question for one request, in a single session run. */
	async classify(
		request: string,
		questions: Record<string, LayaQuestionDefinition>,
	): Promise<Record<string, LayaAnswer>> {
		const { ids, internal, rows } = encodeRequest(this.tokenizer, request, questions, this.config);
		const batch = collate(rows, this.tokenizer.padId);
		const tensor = (type: string, data: ArrayLike<number | bigint>, dims: number[]) =>
			new this.Tensor(type, data, dims);
		const result = await this.model.sessions.model.run({
			input_ids: tensor("int64", batch.inputIds, [batch.rows, batch.length]),
			attention_mask: tensor("int64", batch.attentionMask, [batch.rows, batch.length]),
			marker_pos: tensor("int64", batch.markerPos, [batch.rows, batch.options]),
			marker_mask: tensor("bool", batch.markerMask, [batch.rows, batch.options]),
			qtype: tensor("int64", batch.qtype, [batch.rows]),
		});
		return decodeAnswers(
			{ logits: result.logits.data, options: batch.options, actLogits: result.act_logits.data },
			ids,
			internal,
			rows,
			this.config,
		);
	}

	async close(): Promise<void> {
		await this.model.dispose?.();
	}
}
