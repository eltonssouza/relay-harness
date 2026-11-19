/**
 * The committed WebAssembly module (`@relay-harness/agent-core/harness-wasm`, built from
 * `crates/harness-wasm`) must decide as the TypeScript harness does on every reference case.
 * `golden.test.ts` keeps the reference files equal to the TypeScript results; this test runs the
 * module against them, so a stale module fails here. Rebuild with `npm run build:harness-wasm`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callHarnessWasm, HarnessWasmEngine } from "@relay-harness/agent-core/harness-wasm";
import { describe, expect, it } from "vitest";
import { GOLDEN_CONTEXT, GOLDEN_FILE, type GoldenEntry } from "./golden.ts";
import { PILLARS_FILE } from "./golden-pillars.ts";

const classifications = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as { entries: GoldenEntry[] };
const pillars = JSON.parse(readFileSync(PILLARS_FILE, "utf8")) as {
	texts: Array<{
		text: string;
		constraints: string[];
		questionOnly: boolean;
		requestsAction: boolean;
		correction: boolean;
	}>;
	alignment: Array<{
		request: string;
		answer?: string;
		toolName: string;
		write?: string;
		command?: string;
		first: unknown;
		final: unknown;
		constraints: string[];
	}>;
	completion: Array<{
		name: string;
		steps: Array<{ effect: unknown; isError: boolean; output: string }>;
		finalText: string;
		status: string;
		detail?: string;
		pending: string[] | null;
		gated: boolean;
		verificationRequest: string | null;
	}>;
	context: {
		options: Record<string, unknown>;
		transcript: Array<{ role: string }>;
		requests: string[][];
		stubs: Record<string, string>;
		stats: unknown;
	};
	state: Array<{
		steps: Array<{ request?: string; developer?: string; afterWork?: boolean; edit?: string; check?: string }>;
		state: string | null;
	}>;
};

describe("the harness WebAssembly module", () => {
	it("classifies every reference command as the TypeScript harness does", () => {
		const differences = classifications.entries.flatMap((entry) => {
			const params = { command: entry.command, verifyCommands: entry.verifyCommands ?? [], context: GOLDEN_CONTEXT };
			const effect = callHarnessWasm({ method: "classifyCommand", ...params }) as Record<string, unknown>;
			const actual = {
				command: entry.command,
				...(entry.verifyCommands ? { verifyCommands: entry.verifyCommands } : {}),
				kind: effect.kind,
				...(effect.reason !== undefined ? { reason: effect.reason } : {}),
				...(effect.scope !== undefined ? { scope: effect.scope } : {}),
				...(effect.files !== undefined ? { files: effect.files } : {}),
				...(effect.writes !== undefined ? { writes: effect.writes } : {}),
				operations: [...(callHarnessWasm({ method: "riskyOperations", ...params }) as string[])].sort(),
				deletionTargets: callHarnessWasm({ method: "deletionTargets", command: entry.command }),
			};
			return JSON.stringify(actual) === JSON.stringify(entry) ? [] : [entry.command];
		});
		expect(differences).toEqual([]);
	});

	it("reads texts as the TypeScript harness does", () => {
		const differences = pillars.texts.flatMap((entry) => {
			const actual = {
				text: entry.text,
				constraints: callHarnessWasm({ method: "extractConstraints", text: entry.text }),
				questionOnly: callHarnessWasm({ method: "isQuestionOnly", text: entry.text }),
				requestsAction: callHarnessWasm({ method: "requestsAction", text: entry.text }),
				correction: callHarnessWasm({ method: "isCorrection", text: entry.text }),
			};
			return JSON.stringify(actual) === JSON.stringify(entry) ? [] : [entry.text];
		});
		expect(differences).toEqual([]);
	});

	it("decides alignment cases as the TypeScript harness does", () => {
		const differences = pillars.alignment.flatMap((entry) => {
			const engine = new HarnessWasmEngine({ workspace: GOLDEN_CONTEXT });
			try {
				const toolCall =
					entry.write !== undefined
						? { name: entry.toolName, arguments: { path: entry.write, content: "" } }
						: { name: entry.toolName, arguments: { command: entry.command ?? "" } };
				const effect = engine.call("classify", { toolCall });
				engine.call("observeDeveloperMessage", { text: entry.request, timestamp: 0, afterAgentWork: true });
				const first = engine.call("check", { toolName: entry.toolName, effect }) as { action: string };
				let final = first;
				if (first.action === "block" && entry.answer !== undefined) {
					engine.call("observeDeveloperMessage", { text: entry.answer, timestamp: 1, afterAgentWork: true });
					final = engine.call("check", { toolName: entry.toolName, effect }) as { action: string };
				}
				const constraints = (engine.call("constraints") as Array<{ text: string }>).map((item) => item.text);
				const same =
					JSON.stringify([first, final, constraints]) ===
					JSON.stringify([entry.first, entry.final, entry.constraints]);
				return same ? [] : [`${entry.request} -> ${entry.command ?? entry.write}`];
			} finally {
				engine.dispose();
			}
		});
		expect(differences).toEqual([]);
	});

	it("judges completion scenarios as the TypeScript harness does", () => {
		const differences = pillars.completion.flatMap((entry) => {
			const engine = new HarnessWasmEngine({ workspace: GOLDEN_CONTEXT });
			try {
				engine.call("beginRequest", { text: "Fix it" });
				for (const step of entry.steps) {
					engine.call("recordToolOutcome", { effect: step.effect, isError: step.isError, output: step.output });
				}
				const assessment = engine.call("assessFinalMessage", { text: entry.finalText }) as {
					report: { status: string; detail?: string; gated: boolean };
					verificationRequest: string | null;
				};
				const actual = {
					status: assessment.report.status,
					detail: assessment.report.detail,
					pending: engine.call("pendingChanges"),
					gated: assessment.report.gated,
					verificationRequest: assessment.verificationRequest,
				};
				const expected = {
					status: entry.status,
					detail: entry.detail,
					pending: entry.pending,
					gated: entry.gated,
					verificationRequest: entry.verificationRequest,
				};
				return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [entry.name];
			} finally {
				engine.dispose();
			}
		});
		expect(differences).toEqual([]);
	});

	it("elides context as the TypeScript harness does", () => {
		const { options, transcript } = pillars.context;
		const engine = new HarnessWasmEngine({ context: options });
		try {
			const requests: string[][] = [];
			let stubs: Record<string, string> = {};
			for (let length = 1; length <= transcript.length; length++) {
				const role = transcript[length - 1].role;
				if (role !== "user" && role !== "toolResult") continue;
				const elided = engine.call("transformContext", { messages: transcript.slice(0, length) }) as Array<{
					toolCallId: string;
					stub: string;
				}>;
				stubs = Object.fromEntries(elided.map((item) => [item.toolCallId, item.stub]));
				requests.push(elided.map((item) => item.toolCallId));
			}
			expect(requests).toEqual(pillars.context.requests);
			expect(stubs).toEqual(pillars.context.stubs);
			expect(engine.call("contextStats")).toEqual(pillars.context.stats);
		} finally {
			engine.dispose();
		}
	});

	it("renders the harness state as the TypeScript harness does", () => {
		const differences = pillars.state.flatMap((entry) => {
			const engine = new HarnessWasmEngine({ workspace: { cwd: "/work/app", home: "/home/dev" } });
			try {
				for (const step of entry.steps) {
					if (step.request !== undefined) engine.call("beginRequest", { text: step.request });
					if (step.developer !== undefined) {
						engine.call("observeDeveloperMessage", {
							text: step.developer,
							timestamp: 0,
							afterAgentWork: step.afterWork ?? false,
						});
					}
					if (step.edit !== undefined) {
						const effect = engine.call("classify", {
							toolCall: { name: "edit", arguments: { path: step.edit } },
						});
						engine.call("recordToolOutcome", { effect, isError: false, output: "" });
					}
					if (step.check !== undefined) {
						const effect = engine.call("classify", {
							toolCall: { name: "bash", arguments: { command: step.check } },
						});
						engine.call("recordToolOutcome", { effect, isError: false, output: "ok" });
					}
				}
				return engine.call("renderState") === entry.state ? [] : [JSON.stringify(entry.steps)];
			} finally {
				engine.dispose();
			}
		});
		expect(differences).toEqual([]);
	});
});

/** general-agents' routing catalog and what its `route.py` answered (`npm run harness:route-golden`). */
const ROUTE_FILE = fileURLToPath(new URL("../../../../crates/harness-core/tests/fixtures/route.json", import.meta.url));

describe("the router in the harness WebAssembly module", () => {
	it("routes every general-agents case as route.py does", () => {
		const route = JSON.parse(readFileSync(ROUTE_FILE, "utf8")) as {
			agents: Array<Record<string, unknown>>;
			vocabulary: { words: Array<[string, string]>; phrases: Array<[string, string]> };
			cases: Array<{
				query: string;
				top: number;
				domain?: string;
				expected: { candidates: Array<{ name: string }> };
			}>;
		};
		const byName = new Map(route.agents.map((agent) => [agent.name, agent]));
		const differences = route.cases.flatMap((entry) => {
			const actual = callHarnessWasm({
				method: "routeAgents",
				agents: route.agents,
				vocabulary: route.vocabulary,
				query: entry.query,
				top: entry.top,
				...(entry.domain ? { domain: entry.domain } : {}),
			}) as { candidates: Array<Record<string, unknown>> };
			// route.py --json copies these fields of the catalog entry into each candidate.
			const expected = {
				...entry.expected,
				candidates: entry.expected.candidates.map((candidate) => {
					const agent = byName.get(candidate.name) ?? {};
					return {
						...candidate,
						domain: agent.domain,
						kind: agent.kind,
						model: agent.model ?? {},
						path: agent.path,
						can_edit: agent.can_edit,
					};
				}),
			};
			const sorted = (value: unknown) =>
				JSON.stringify(value, (_key, item) =>
					item && typeof item === "object" && !Array.isArray(item)
						? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
						: item,
				);
			return sorted(actual) === sorted(expected) ? [] : [entry.query];
		});
		expect(route.cases.length).toBeGreaterThanOrEqual(160);
		expect(differences).toEqual([]);
	});
});
