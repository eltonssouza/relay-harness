import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildHead,
	collate,
	decodeAnswers,
	encodeRequest,
	type LayaAnswer,
	LayaOnnxClassifier,
	type LayaQuestionDefinition,
	type LayaTokenizer,
	renderOptions,
	toInternalQuestion,
} from "../src/extensions/laya/native-onnx.ts";

const fixtures = join(__dirname, "fixtures");
const questions = JSON.parse(readFileSync(join(fixtures, "aci-laya-questions.json"), "utf8")) as Record<
	string,
	LayaQuestionDefinition
>;

/** One token per character; ids are small and stable so the layout can be asserted exactly. */
const charTokenizer: LayaTokenizer = {
	encode: (text) => Array.from(text, (char) => 10 + (char.codePointAt(0) ?? 0)),
	maskToken: "<mask>",
	maskId: 4,
	clsId: 2,
	sepId: 1,
	padId: 0,
};

describe("laya native ONNX: input encoding", () => {
	it("renders options like laya for choice, score and noul questions", () => {
		expect(
			renderOptions(
				toInternalQuestion("a", { type: "choice", instructions: "x", criteria: { red: "warm", blue: "" } }),
			),
		).toEqual(["red: warm", "blue"]);
		expect(
			renderOptions(toInternalQuestion("b", { type: "score", instructions: "x", criteria: ["low", { n: 1 }] })),
		).toEqual(["level 0: low", 'level 1: {"n": 1}']);
		expect(renderOptions(toInternalQuestion("c", { type: "bool", instructions: "x" }))).toEqual([
			"false: no, the statement does not hold",
			"true: yes, the statement holds",
		]);
	});

	it("lays out [CLS] head [SEP] then one [MASK] span per option and returns their positions", () => {
		const question = toInternalQuestion("a", {
			type: "noul",
			instructions: "ok?",
			criteria: { true: "y", false: "n" },
		});
		const { ids, markers } = buildHead(charTokenizer, question, 768);
		expect(ids[0]).toBe(2);
		expect(ids.at(-1)).toBe(1);
		expect(markers).toHaveLength(2);
		expect(markers.map((position) => ids[position])).toEqual([4, 4]);
	});

	it("truncates a long Unicode request to max_len and keeps every option marker", () => {
		const request = "Corrija o cálculo de ação 你好 ".repeat(200);
		const { rows } = encodeRequest(charTokenizer, request, questions, { maxLen: 400, headMaxLen: 300 });
		for (const row of rows) {
			expect(row.ids.length).toBeLessThanOrEqual(400);
			expect(row.ids.at(-1)).toBe(1);
			expect(row.markers.every((position) => row.ids[position] === 4)).toBe(true);
		}
		expect(() => encodeRequest(charTokenizer, "   ", questions, { maxLen: 400, headMaxLen: 300 })).toThrow(
			/non-empty/,
		);
	});

	it("rejects malformed questions and empty requests", () => {
		expect(() => toInternalQuestion("a", { type: "choice", instructions: "x", criteria: { only: "one" } })).toThrow(
			/at least two/,
		);
		expect(() => toInternalQuestion("a", { type: "score", instructions: "", criteria: ["a", "b"] })).toThrow(
			/instructions/,
		);
		expect(() => toInternalQuestion("a", { type: "nope" as never, instructions: "x" })).toThrow(/unsupported type/);
	});

	it("pads rows into aligned tensors with a marker mask", () => {
		const batch = collate(
			[
				{ ids: [2, 7, 1], markers: [1], qtype: 0 },
				{ ids: [2, 7, 8, 9, 1], markers: [1, 3], qtype: 2 },
			],
			0,
		);
		expect([batch.rows, batch.length, batch.options]).toEqual([2, 5, 2]);
		expect(Array.from(batch.inputIds.slice(0, 5), Number)).toEqual([2, 7, 1, 0, 0]);
		expect(Array.from(batch.attentionMask.slice(0, 5), Number)).toEqual([1, 1, 1, 0, 0]);
		expect(Array.from(batch.markerMask)).toEqual([1, 0, 1, 1]);
		expect(Array.from(batch.qtype, Number)).toEqual([0, 2]);
	});
});

describe("laya native ONNX: answer decoding", () => {
	const config = { temperature: [1, 1, 1] as [number, number, number], temperatureByOptions: {} };

	it("decodes a choice with probabilities that sum to one and the argmax as the choice", () => {
		const question = toInternalQuestion("q", { type: "choice", instructions: "x", criteria: { a: null, b: null } });
		const answers = decodeAnswers(
			{ logits: [0, 3], options: 2, actLogits: [1, 1] },
			["q"],
			{ q: question },
			[{ ids: [], markers: [0, 1], qtype: 0 }],
			config,
		);
		const answer = answers.q as Extract<LayaAnswer, { type: "choice" }>;
		expect(answer.choice).toBe("b");
		expect(answer.probabilities.a + answer.probabilities.b).toBeCloseTo(1, 3);
		expect(answer.action.act_probability).toBe(0.5);
	});

	it("ignores padded option slots when a batch is wider than the question", () => {
		const question = toInternalQuestion("q", { type: "score", instructions: "x", criteria: ["a", "b"] });
		const answers = decodeAnswers(
			{ logits: [5, 5, -1e4], options: 3, actLogits: [0, 0] },
			["q"],
			{ q: question },
			[{ ids: [], markers: [0, 1], qtype: 1 }],
			{ ...config, temperature: [1, 1, 1] },
		);
		const answer = answers.q as Extract<LayaAnswer, { type: "score" }>;
		expect(Object.keys(answer.probabilities)).toEqual(["0", "1"]);
		expect(answer.score).toBe(0.5);
	});
});

// Needs the 1.3 GB snapshot of eltonssouza/relay-laya (config.json, tokenizer.json,
// tokenizer_config.json, rl_agent_config.json, onnx/laya.onnx), so it is opt-in.
const parityDir = process.env.RELAY_LAYA_PARITY_DIR;

describe.skipIf(!parityDir)("laya native ONNX: parity with the Python runtime", () => {
	interface ReferenceCase {
		id: string;
		request: string;
		answers: Record<string, LayaAnswer>;
	}
	const reference = JSON.parse(readFileSync(join(fixtures, "aci-laya-parity-reference.json"), "utf8")) as {
		cases: ReferenceCase[];
	};

	it("matches laya 0.3.27 on every reference request", { timeout: 600_000 }, async () => {
		const classifier = await LayaOnnxClassifier.load(parityDir as string);
		try {
			const failures: string[] = [];
			for (const item of reference.cases) {
				const actual = await classifier.classify(item.request, questions);
				for (const [id, expected] of Object.entries(item.answers)) {
					const got = actual[id];
					if (!got) {
						failures.push(`${item.id}.${id}: missing`);
						continue;
					}
					if (got.type === "choice" && expected.type === "choice" && got.choice !== expected.choice)
						failures.push(`${item.id}.${id}: ${got.choice} != ${expected.choice}`);
					for (const key of ["confidence", "answer_confidence"] as const)
						if (Math.abs(got[key] - expected[key]) > 2e-3)
							failures.push(`${item.id}.${id}.${key}: ${got[key]} != ${expected[key]}`);
					if (got.type === "noul" && expected.type === "noul" && Math.abs(got.noul - expected.noul) > 2e-3)
						failures.push(`${item.id}.${id}.noul: ${got.noul} != ${expected.noul}`);
					if (got.type === "score" && expected.type === "score" && Math.abs(got.score - expected.score) > 2e-3)
						failures.push(`${item.id}.${id}.score: ${got.score} != ${expected.score}`);
					if (Math.abs(got.action.act_probability - expected.action.act_probability) > 2e-3)
						failures.push(
							`${item.id}.${id}.act: ${got.action.act_probability} != ${expected.action.act_probability}`,
						);
				}
			}
			expect(failures).toEqual([]);
		} finally {
			await classifier.close();
		}
	});
});
