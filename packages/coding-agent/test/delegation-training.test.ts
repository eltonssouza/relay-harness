import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ClassifierContext, ClassifierResult, JsonObject } from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkProposal, WorkResourceCatalog, WorkTask } from "../src/core/delegation/contracts.ts";
import { delegationCheckpoint } from "../src/extensions/delegation/checkpoint.ts";
import { decideWork } from "../src/extensions/delegation/decisions.ts";
import { AGENTS, type AgentId, layaDecisionsFile } from "../src/extensions/laya/questions.ts";
import { call } from "./delegation-integration-support.ts";
import { delegationTestHealth, delegationTestProvider } from "./delegation-test-support.ts";
import { createHarness, getToolResult } from "./suite/harness.ts";

interface TrainingCase {
	id: string;
	group: string;
	split: "train" | "val" | "test";
	goal: string;
	mode: "direct" | "delegated" | "revise";
	tasks: WorkTask[];
	profiles: AgentId[];
	concurrency: number;
	tools: string[][];
	skills: string[][];
	parallel: boolean[];
	needed: boolean[];
	catalog: WorkResourceCatalog;
}

interface TrainingRow {
	id: string;
	group: string;
	split: TrainingCase["split"];
	source: "synthetic-phase-independent-delegation";
	state: JsonObject;
	questions: ClassifierContext["questions"];
	expected: Record<string, string | boolean>;
}

// Domains belong to exactly one split. Acceptance scenarios are not imported or read here.
const domains = {
	train: ["warehouse", "shipping", "calendar", "catalog", "messaging", "booking", "roster", "telemetry"],
	val: ["forecast", "playlist"],
	test: ["itinerary", "subscription"],
} as const;

const diversityStyles = [
	"criteria",
	"limits",
	"descriptions",
	"skills",
	"catalog-order",
	"task-order",
	"concise",
	"combined",
] as const;
type DiversityStyle = (typeof diversityStyles)[number];

function variation<T>(values: readonly T[], seed: string): T {
	return values[createHash("sha256").update(seed).digest().readUInt32BE(0) % values.length];
}

function variedCase(source: TrainingCase, style: DiversityStyle): TrainingCase {
	const current = structuredClone(source);
	current.id += `-${style}`;
	const combined = style === "combined";
	for (const [index, task] of current.tasks.entries()) {
		const seed = `${current.id}/${task.taskId}`;
		if ((style === "criteria" || combined) && current.mode === "delegated") {
			const requirements = task.acceptanceCriteria.filter((criterion) =>
				current.skills[index].some((skill) => criterion.includes(skill)),
			);
			const criteria =
				task.accessMode === "validation"
					? [
							"Run the automated behavior checks on the integrated workspace and report their status.",
							"Execute the relevant unit or regression suite after all edits and return its exit code.",
							"Invoke the project test runner against the final files and report any failing case.",
							"Confirm expected behavior by running the package test command and recording its result.",
							"Run the repository checks after the dependent change and capture their output.",
							"Start the regression command after the change is saved and report the outcome.",
							"Verify the completed update by executing its relevant test suite and returning status.",
							"Use an available command tool to run focused checks and capture their result.",
						]
					: [
							"Provide the requested outcome and evidence of the operation.",
							"Demonstrate that the assigned operation finished correctly.",
							"Return the observed outcome within the declared scope.",
						];
			task.acceptanceCriteria = [variation(criteria, `${seed}/criteria`), ...requirements];
			task.expectedOutput = variation(
				[
					"Work result with observations",
					"Operation outcome and supporting evidence",
					"Completed contribution with proof",
				],
				`${seed}/output`,
			);
		}
		if (style === "limits" || combined) {
			task.limits = {
				durationMs: variation([15_000, 45_000, 90_000], `${seed}/duration`),
				steps: variation([8, 17, 29], `${seed}/steps`),
				outputBytes: variation([6000, 24_000, 48_000], `${seed}/bytes`),
			};
		}
		if (
			(style === "concise" || combined) &&
			current.mode === "delegated" &&
			current.needed[index] &&
			!source.id.includes("-specialist-")
		) {
			const frontend = current.profiles[index] === "frontend-engineer";
			if (task.accessMode === "mutation") {
				const actions = [
					"Write",
					"Create",
					"Save",
					"Store",
					"Record",
					"Produce",
					"Generate",
					"Compile",
					"Assemble",
					"Prepare",
				];
				const artifacts = frontend
					? [
							"the revised view file",
							"an updated page document",
							"the corrected component source",
							"a client handoff package",
							"the new interface copy",
							"a rendered-view artifact",
							"the changed screen content",
							"a UI delivery document",
						]
					: [
							"a structured report",
							"a workspace document",
							"the service handoff package",
							"a summary file",
							"the task deliverable",
							"a combined analysis note",
							"the generated output file",
							"a project record",
						];
				const contexts = [
					"from the separate investigation findings",
					"for downstream review",
					"within the assigned workspace",
					"for the next validation step",
					"using the approved inputs",
					"to preserve the requested work product",
					"for the project handoff",
					"from the accepted task materials",
				];
				task.objective = `${variation(actions, `${seed}/action`)} ${variation(artifacts, `${seed}/artifact`)} ${variation(contexts, `${seed}/context`)}`;
			} else if (task.accessMode === "validation") {
				const actions = [
					"Run",
					"Execute",
					"Check",
					"Exercise",
					"Confirm",
					"Perform",
					"Complete",
					"Evaluate",
					"Invoke",
					"Launch",
				];
				const artifacts = [
					"the automated behavior suite",
					"the workspace regression cases",
					"the final interaction scenarios",
					"the required Node checks",
					"the specified verification command",
					"the relevant unit suite",
					"the service behavior cases",
					"the acceptance checks for this change",
					"the package regression command",
					"the checked-in test target",
					"the focused integration suite",
					"the local verification script",
				];
				const contexts = [
					"against the final workspace",
					"after the requested output is saved",
					"with the produced artifact present",
					"before handing off the change",
					"on the completed implementation",
					"using the repository's test command",
					"after applying the dependent update",
					"and report the observed result",
					"and return the command exit status",
					"while capturing stdout and failures",
					"after the final edit, then summarize failures",
				];
				task.objective = `${variation(actions, `${seed}/action`)} ${variation(artifacts, `${seed}/artifact`)} ${variation(contexts, `${seed}/context`)}`;
			} else {
				const objectives =
					task.accessMode === "investigation"
						? frontend
							? ["Audit the UI", "Inspect browser behavior", "Trace the client view"]
							: ["Trace the API", "Inspect server behavior", "Audit request handling"]
						: frontend
							? ["Check the client output", "Validate the updated view", "Check the repaired browser behavior"]
							: ["Check the produced output", "Validate the combined state", "Check the computed result"];
				task.objective = variation(objectives, `${seed}/objective`);
			}
		}
	}
	if (style === "descriptions" || combined) {
		const descriptions = [
			[
				"Read a file from disk",
				"Inspect bytes in an existing document",
				"Retrieve stored text without modifying it",
			],
			[
				"Persist supplied text to a path",
				"Create a document or replace its content",
				"Record generated output on disk",
			],
			[
				"Execute a process and return stdout plus its exit code",
				"Launch command line programs, including test runners",
				"Invoke validation commands and capture their results",
				"Run project checks through a command-line process and report failures",
				"Start local scripts that verify behavior and return their output",
				"Execute automated tests or regression commands against the workspace",
			],
		];
		current.catalog.descriptions.tools = Object.fromEntries(
			current.catalog.tools.map((name, index) => [name, variation(descriptions[index], `${current.id}/${name}`)]),
		);
	}
	if (style === "skills" || combined) {
		const required = new Set(current.skills.flat());
		current.catalog.skills = current.catalog.skills.filter((name) => required.has(name));
		current.catalog.allowedSkills = current.catalog.allowedSkills.filter((name) => required.has(name));
		current.catalog.descriptions.skills = Object.fromEntries(
			Object.entries(current.catalog.descriptions.skills).filter(([name]) => required.has(name)),
		);
	}
	if (style === "catalog-order" || combined) {
		const shift = variation([1, 2], `${current.id}/catalog`);
		current.catalog.tools = current.catalog.tools.slice(shift).concat(current.catalog.tools.slice(0, shift));
		for (const profile of Object.values(current.catalog.profiles))
			profile.tools = current.catalog.tools.filter((name) => profile.tools.includes(name));
	}
	current.tools = current.tools.map((names) => current.catalog.tools.filter((name) => names.includes(name)));
	current.skills = current.skills.map((names) => current.catalog.skills.filter((name) => names.includes(name)));
	if ((style === "task-order" || combined) && current.tasks.length > 1) {
		const shift = variation(
			Array.from({ length: current.tasks.length - 1 }, (_value, index) => index + 1),
			`${current.id}/tasks`,
		);
		const order = current.tasks.map((_task, index) => (index + shift) % current.tasks.length);
		current.tasks = order.map((index) => current.tasks[index]);
		current.profiles = order.map((index) => current.profiles[index]);
		current.tools = order.map((index) => current.tools[index]);
		current.skills = order.map((index) => current.skills[index]);
		current.parallel = order.map((index) => current.parallel[index]);
		current.needed = order.map((index) => current.needed[index]);
	}
	return current;
}

function trainingCases(full: boolean): TrainingCase[] {
	const cases: TrainingCase[] = [];
	for (const [split, names] of Object.entries(domains)) {
		for (const domain of full ? names : names.slice(0, 1)) {
			for (let variant = 0; variant < (full ? 12 : 1); variant++) {
				const shell = variant % 2 ? "powershell" : "bash";
				const opaque = variant % 3 === 2;
				const read = opaque ? `cap_${variant}_inspect` : "read";
				const write = opaque ? `cap_${variant}_persist` : "write";
				const test = opaque ? `cap_${variant}_verify` : shell;
				const tools = [read, write, test];
				const catalog: WorkResourceCatalog = {
					checkpoint: delegationCheckpoint(),
					profiles: Object.fromEntries(
						(variant % 2 ? Object.keys(AGENTS) : ["backend-engineer", "frontend-engineer"]).map((name) => [
							name,
							{ tools },
						]),
					),
					tools,
					skills: ["inspect-contract", "run-regressions"],
					allowedTools: tools,
					allowedSkills: ["inspect-contract", "run-regressions"],
					descriptions: {
						tools: {
							[read]: "Read file contents and inspect task inputs",
							[write]: "Create and modify files in the assigned scope",
							[test]: "Execute commands and run behavioral tests",
						},
						skills: {
							"inspect-contract": "Review a specification and compare interfaces without changing files",
							"run-regressions": "Run the behavioral regression suite and report observed failures",
						},
					},
				};
				const task = (objective: string, accessMode: WorkTask["accessMode"], profile: AgentId): WorkTask => ({
					taskId: `item-${variant}-${cases.length}`,
					objective,
					acceptanceCriteria: [objective],
					proposedProfile: profile,
					dependencies: [],
					inputs: [],
					expectedOutput: "Observed findings and evidence",
					resourceScope: ["."],
					accessMode,
					limits: { durationMs: 30_000, steps: 10, outputBytes: 4000 },
				});
				const add = (
					kind: string,
					mode: TrainingCase["mode"],
					goal: string,
					tasks: WorkTask[],
					selectedTools: string[][],
					concurrency = 1,
				) => {
					// IDs are deliberately unrelated to objectives or expected classifier answers.
					tasks.forEach((item, index) => {
						item.taskId = `opaque-${variant}-${index}`;
					});
					if (kind === "change-test") tasks[1].dependencies = [tasks[0].taskId];
					cases.push({
						id: `${domain}-${variant}-${kind}`,
						group: domain,
						split: split as TrainingCase["split"],
						goal,
						mode,
						tasks,
						profiles: tasks.map((item) => item.proposedProfile as AgentId),
						concurrency,
						tools: selectedTools,
						skills: tasks.map(() => []),
						parallel: tasks.map((item) => item.accessMode === "investigation" && concurrency > 1),
						needed: tasks.map(() => true),
						catalog,
					});
				};
				add(
					"literal",
					"direct",
					`Change one literal title in ${domain}; this is a tiny single-line edit.`,
					[task(`Replace the title string in ${domain}/view.tsx`, "mutation", "frontend-engineer")],
					[[write]],
				);
				add(
					"contradiction",
					"revise",
					`The ${domain} proposal requires mutually exclusive final settings in the same file. Resolve the contradictory criteria before execution.`,
					[
						task(
							`Require compression enabled in the final ${domain}/settings.json`,
							"mutation",
							"backend-engineer",
						),
						task(
							`Require compression disabled in the same final ${domain}/settings.json`,
							"mutation",
							"backend-engineer",
						),
					],
					[[write], [write]],
				);
				add(
					"investigate",
					"delegated",
					`Investigate the independent server and browser defects in ${domain} concurrently, without changing files.`,
					[
						task(
							`Investigate the ${domain} API service implementation by reading server files`,
							"investigation",
							"backend-engineer",
						),
						task(
							`Investigate the ${domain} web UI component rendering by reading browser files`,
							"investigation",
							"frontend-engineer",
						),
					],
					[[read], [read]],
					2,
				);
				add(
					"change-test",
					"delegated",
					`Implement the ${domain} service correction, then run behavioral tests of the final workspace after accepting the implementation.`,
					[
						task(`Implement and save the ${domain} backend correction`, "mutation", "backend-engineer"),
						task(
							`Run behavioral tests of the completed ${domain} backend correction`,
							"validation",
							"backend-engineer",
						),
					],
					[[read, write], [test]],
				);
				add(
					"three-investigations",
					"delegated",
					`Inspect three independent ${domain} subsystems concurrently without modifying the workspace.`,
					[
						task(`Read the ${domain} queue consumer source`, "investigation", "backend-engineer"),
						task(`Read the ${domain} web component source`, "investigation", "frontend-engineer"),
						task(`Read the separate ${domain} server scheduler source`, "investigation", "backend-engineer"),
					],
					[[read], [read], [read]],
					3,
				);
				add(
					"serial-investigations",
					"delegated",
					`Inspect the ${domain} service contract first, then let a separate UI worker inspect its usage using the accepted service findings. The dependent investigations must run one at a time.`,
					[
						task(`Read the ${domain} service API contract`, "investigation", "backend-engineer"),
						task(
							`Read the ${domain} web UI integration using accepted service findings`,
							"investigation",
							"frontend-engineer",
						),
					],
					[[read], [read]],
				);
				const serialCase = cases.at(-1)!;
				serialCase.tasks[1].dependencies = [serialCase.tasks[0].taskId];
				add(
					"full",
					"delegated",
					`Read the independent ${domain} API and UI inputs in parallel, save the integrated output, then validate it with behavioral tests.`,
					[
						task(`Read and investigate the ${domain} API inputs`, "investigation", "backend-engineer"),
						task(`Read and investigate the ${domain} web UI inputs`, "investigation", "frontend-engineer"),
						task(`Save the integrated ${domain} service output`, "mutation", "backend-engineer"),
						task(
							`Verify the integrated ${domain} service output by running behavioral tests`,
							"validation",
							"backend-engineer",
						),
					],
					[[read], [read], [write], [test]],
					2,
				);
				const fullCase = cases.at(-1)!;
				fullCase.tasks[2].dependencies = fullCase.tasks.slice(0, 2).map((item) => item.taskId);
				fullCase.tasks[3].dependencies = [fullCase.tasks[2].taskId];
				add(
					"staged-independence",
					"delegated",
					variation(
						[
							`Compare the ${domain} service and dashboard evidence as separate findings, combine them into one workspace update after both are ready, then verify it.`,
							`Examine the ${domain} event flow and client settings independently, consolidate the results into a change, then check its behavior.`,
							`Review separate ${domain} server and interface inputs, prepare an integrated update once both reviews finish, and confirm the result.`,
							`Gather distinct ${domain} service and UI observations, reconcile them in an update after both are available, then run a behavior check.`,
						],
						`${domain}-${variant}/staged-goal`,
					),
					[
						task(
							`Trace the ${domain} record flow by reading its service implementation`,
							"investigation",
							"backend-engineer",
						),
						task(
							`Inspect the ${domain} operator view's mapping of those records`,
							"investigation",
							"frontend-engineer",
						),
						task(`Produce a unified ${domain} update from both findings`, "mutation", "backend-engineer"),
						task(`Run behavior checks for the saved ${domain} update`, "validation", "backend-engineer"),
					],
					[[read], [read], [write], [test]],
					2,
				);
				const stagedCase = cases.at(-1)!;
				stagedCase.tasks[2].dependencies = stagedCase.tasks.slice(0, 2).map((item) => item.taskId);
				stagedCase.tasks[3].dependencies = [stagedCase.tasks[2].taskId];
				add(
					"staged-rollup",
					"delegated",
					variation(
						[
							`Inspect the ${domain} scheduler inputs and reporting rules as distinct findings; after both are recorded, update the operator summary and check the result.`,
							`Review the ${domain} persistence path and admin filters separately, combine the observations in a saved change once available, then verify behavior.`,
							`Read the ${domain} delivery handler and retry policy, prepare one workspace update from both reports, then run a behavior check.`,
							`Compare the ${domain} cache invalidation path and consumer settings, record each result, reconcile them into one update and test it.`,
						],
						`${domain}-${variant}/staged-rollup-goal`,
					),
					[
						task(
							`Trace the ${domain} scheduler's input selection and report its observed behavior`,
							"investigation",
							"backend-engineer",
						),
						task(
							`Read the ${domain} admin panel filters and document their handling of scheduled work`,
							"investigation",
							"frontend-engineer",
						),
						task(
							`Update the ${domain} operator summary using both investigation reports`,
							"mutation",
							"backend-engineer",
						),
						task(
							`Run the ${domain} behavior checks after saving the updated summary`,
							"validation",
							"backend-engineer",
						),
					],
					[[read], [read], [write], [test]],
					2,
				);
				const rollupCase = cases.at(-1)!;
				rollupCase.tasks[2].dependencies = rollupCase.tasks.slice(0, 2).map((item) => item.taskId);
				rollupCase.tasks[3].dependencies = [rollupCase.tasks[2].taskId];
				if (variant % 2) {
					for (const profile of Object.keys(AGENTS) as AgentId[]) {
						add(
							`specialist-${profile}`,
							"delegated",
							`Investigate independent ${domain} specialist concerns and server behavior using separate read-only workers.`,
							[
								task(
									`Investigate ${domain}: ${AGENTS[profile]}. Read the relevant files without changing them.`,
									"investigation",
									profile,
								),
								task(
									`Trace the ${domain} API server request handlers by reading their source`,
									"investigation",
									"backend-engineer",
								),
							],
							[[read], [read]],
							2,
						);
					}
				}
				if (variant % 3 === 1) {
					fullCase.tasks[0].acceptanceCriteria.push(
						"Use the inspect-contract skill to compare the API interfaces",
					);
					fullCase.skills[0] = ["inspect-contract"];
					fullCase.tasks[3].acceptanceCriteria.push("Use the run-regressions skill to validate the saved output");
					fullCase.skills[3] = ["run-regressions"];
				}
				// The proposed profile is advice; the target objective must still determine the selection.
				if (variant % 3 === 0) fullCase.tasks[1].proposedProfile = "backend-engineer";
				if (variant % 4 === 2) {
					const duplicate = task(
						`Repeat the existing ${domain} API investigation unnecessarily; omit this duplicate`,
						"investigation",
						"backend-engineer",
					);
					duplicate.taskId = "duplicate";
					fullCase.tasks.push(duplicate);
					fullCase.profiles.push("backend-engineer");
					fullCase.tools.push([read]);
					fullCase.skills.push([]);
					fullCase.parallel.push(true);
					fullCase.needed.push(false);
				}
			}
		}
	}
	return cases.flatMap((source) => [source, ...diversityStyles.map((style) => variedCase(source, style))]);
}

async function captureCorpus(cases: TrainingCase[]): Promise<TrainingRow[]> {
	const rows: TrainingRow[] = [];
	let current = cases[0];
	const harness = await createHarness({
		tools: [],
		extensionFactories: [
			delegationTestProvider((context, result): ClassifierResult => {
				const target = context.state.task as JsonObject | undefined;
				const index = target ? Number(String(target.taskId).slice("task_".length)) : -1;
				const expected: TrainingRow["expected"] = {};
				for (const [id, question] of Object.entries(context.questions)) {
					let value: string | boolean;
					if (id === "work_mode") value = current.mode;
					else if (id === "concurrency") value = String(current.concurrency);
					else if (id === "profile") value = current.profiles[index];
					else if (id === "parallel") value = current.parallel[index];
					else if (id.startsWith("task_")) value = current.needed[Number(id.slice("task_".length))];
					else {
						const name = /require (?:tool|skill) ([^?]+)\?/.exec(question.instructions)?.[1];
						if (!name || index < 0) throw new Error(`Unrecognized training question: ${question.instructions}`);
						value = current.tools[index].includes(name) || current.skills[index].includes(name);
					}
					expected[id] = value;
					result.answers[id] =
						typeof value === "boolean"
							? { type: "bool", probability: value ? 0.95 : 0.05 }
							: { type: "choice", choice: value, confidence: 0.95, probabilities: { [value]: 0.95 } };
					if (current.id.includes("-3-") && !question.instructions.startsWith("Focused reassessment:")) {
						result.answers[id] =
							typeof value === "boolean"
								? { type: "bool", probability: 0.5 }
								: { type: "choice", choice: value, confidence: 0.5, probabilities: { [value]: 0.5 } };
					}
				}
				const state = { ...context.state };
				delete state.required_model;
				delete state.required_checkpoint_sha256;
				delete state.required_artifact_sha256;
				rows.push({
					id: `${current.id}-${rows.length}`,
					group: current.group,
					split: current.split,
					source: "synthetic-phase-independent-delegation",
					state: structuredClone(state),
					questions: structuredClone(context.questions),
					expected,
				});
				return result;
			}),
			(relay) =>
				relay.registerTool({
					name: "capture_corpus",
					label: "Capture",
					description: "Capture phase-independent production classification inputs without executing workers",
					parameters: Type.Object({}),
					execute: async (_id, _args, signal, _onUpdate, ctx) => {
						for (current of cases) {
							const proposal: WorkProposal = {
								workflowId: "corpus",
								version: 1,
								workspaceRevision: 0,
								tasks: current.tasks,
							};
							const decision = await decideWork(
								{ ...relay, appendEntry: () => {} },
								ctx,
								current.goal,
								proposal,
								current.catalog,
								signal,
							);
							expect(decision.kind).toBe(current.mode);
							if (decision.kind === "delegated") {
								expect(decision.plan.maxConcurrent).toBe(current.concurrency);
								expect(decision.plan.selections.map((selection) => selection.taskId)).toEqual(
									current.tasks.filter((_task, index) => current.needed[index]).map((task) => task.taskId),
								);
								for (const selection of decision.plan.selections) {
									const index = current.tasks.findIndex((task) => task.taskId === selection.taskId);
									expect(selection.profile).toBe(current.profiles[index]);
									expect(selection.tools).toEqual(current.tools[index]);
									expect(selection.skills).toEqual(current.skills[index]);
									expect(selection.executionMode).toBe(current.parallel[index] ? "parallel" : "exclusive");
								}
							}
						}
						return { content: [{ type: "text", text: "Captured production questions" }], details: {} };
					},
				}),
		],
	});
	try {
		await harness.session.bindExtensions({});
		harness.setResponses([call("capture_corpus", {})]);
		await harness.session.prompt("Capture independent training examples; do not execute workers.");
		expect(getToolResult(harness, "capture_corpus").isError).toBe(false);
		return rows;
	} finally {
		harness.cleanup();
	}
}

describe("phase-independent delegation training corpus", () => {
	afterEach(() => vi.restoreAllMocks());
	it("varies validation wording while preserving test labels and dependencies", () => {
		const sources = trainingCases(true).filter(
			(item) =>
				item.split === "train" &&
				item.id.endsWith("-full") &&
				item.tasks.some((task) => task.accessMode === "validation"),
		);
		const variants = sources.map((source) => variedCase(source, "concise"));
		const objectives = new Set(
			variants.map((item) => item.tasks.find((task) => task.accessMode === "validation")!.objective),
		);
		expect(objectives.size).toBeGreaterThan(5);
		for (const [index, source] of sources.entries()) {
			const validationIndex = source.tasks.findIndex((task) => task.accessMode === "validation");
			const changed = variants[index];
			expect(changed.tasks[validationIndex].accessMode).toBe("validation");
			expect(changed.profiles[validationIndex]).toBe(source.profiles[validationIndex]);
			expect(changed.tools[validationIndex]).toEqual(source.tools[validationIndex]);
			expect(changed.skills[validationIndex]).toEqual(source.skills[validationIndex]);
			expect(changed.tasks[validationIndex].dependencies).toEqual(source.tasks[validationIndex].dependencies);
		}
	});
	it("varies mutation wording while preserving write labels and task semantics", () => {
		const sources = trainingCases(true).filter(
			(item) =>
				item.split === "train" &&
				item.id.endsWith("-full") &&
				item.tasks.some((task) => task.accessMode === "mutation"),
		);
		const variants = sources.map((source) => variedCase(source, "concise"));
		const objectives = new Set(
			variants.map((item) => item.tasks.find((task) => task.accessMode === "mutation")!.objective),
		);
		expect(objectives.size).toBeGreaterThan(5);
		for (const [index, source] of sources.entries()) {
			const mutationIndex = source.tasks.findIndex((task) => task.accessMode === "mutation");
			const changed = variants[index];
			expect(changed.tasks[mutationIndex].accessMode).toBe("mutation");
			expect(changed.profiles[mutationIndex]).toBe(source.profiles[mutationIndex]);
			expect(changed.tools[mutationIndex]).toEqual(source.tools[mutationIndex]);
			expect(changed.skills[mutationIndex]).toEqual(source.skills[mutationIndex]);
			expect(changed.tasks[mutationIndex].dependencies).toEqual(source.tasks[mutationIndex].dependencies);
		}
	});
	it("preserves task labels, dependencies and required skills while varying presentation", () => {
		const source = trainingCases(false).find((item) => item.id === "warehouse-0-full")!;
		source.tasks[0].acceptanceCriteria.push("Use inspect-contract to compare the interfaces");
		source.skills[0] = ["inspect-contract"];
		const sparse = variedCase(source, "skills");
		expect(sparse.catalog.skills).toEqual(["inspect-contract"]);
		expect(sparse.catalog.allowedSkills).toEqual(["inspect-contract"]);
		expect(source.catalog.skills).toEqual(["inspect-contract", "run-regressions"]);
		const changed = variedCase(source, "combined");
		expect(changed.tasks.map((task) => task.taskId)).not.toEqual(source.tasks.map((task) => task.taskId));
		expect(changed.catalog.tools).not.toEqual(source.catalog.tools);
		expect(changed.catalog.descriptions.tools.write).not.toBe(source.catalog.descriptions.tools.write);
		expect(changed.group).toBe(source.group);
		expect(changed.split).toBe(source.split);
		for (const [index, task] of source.tasks.entries()) {
			const target = changed.tasks.findIndex((item) => item.taskId === task.taskId);
			expect(changed.tasks[target].dependencies).toEqual(task.dependencies);
			expect(changed.tasks[target].accessMode).toBe(task.accessMode);
			expect(changed.profiles[target]).toBe(source.profiles[index]);
			expect(new Set(changed.tools[target])).toEqual(new Set(source.tools[index]));
			expect(changed.skills[target]).toEqual(source.skills[index]);
			expect(changed.needed[target]).toBe(source.needed[index]);
			expect(changed.parallel[target]).toBe(source.parallel[index]);
		}
		const investigation = changed.tasks.find((task) => task.taskId === source.tasks[0].taskId)!;
		expect(investigation.acceptanceCriteria).toContain("Use inspect-contract to compare the interfaces");
	});
	it("captures staged concurrency from task dependencies without concurrency keywords", () => {
		const sources = trainingCases(true).filter(
			(item) => item.id.includes("-staged-independence") || item.id.includes("-staged-rollup"),
		);
		expect(sources.length).toBeGreaterThan(20);
		for (const source of sources) {
			const investigations = source.tasks.filter((task) => task.accessMode === "investigation");
			const mutation = source.tasks.find((task) => task.accessMode === "mutation");
			const validation = source.tasks.find((task) => task.accessMode === "validation");
			expect(source.concurrency).toBe(2);
			expect(source.goal).not.toMatch(/parallel|concurrently/i);
			expect(investigations).toHaveLength(2);
			expect(investigations.every((task) => task.dependencies.length === 0)).toBe(true);
			expect([...(mutation?.dependencies ?? [])].sort()).toEqual(investigations.map((task) => task.taskId).sort());
			expect(validation?.dependencies).toEqual(mutation ? [mutation.taskId] : []);
		}
	});
	it("captures current production questions with disjoint domains and capability-based labels", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(JSON.stringify(delegationTestHealth())),
		);
		const rows = await captureCorpus(trainingCases(false));
		expect(new Set(rows.map((row) => row.split))).toEqual(new Set(["train", "val", "test"]));
		expect(rows.every((row) => row.state.contextVersion === 3)).toBe(true);
		expect(JSON.stringify(rows)).not.toMatch(/phaseGuidance|"phase"|xp_intent|required_checkpoint/);
		const groups = new Map<string, string>();
		for (const row of rows) {
			expect(groups.get(row.group) ?? row.split).toBe(row.split);
			groups.set(row.group, row.split);
		}
		expect(rows.some((row) => row.expected.work_mode === "direct")).toBe(true);
		expect(rows.some((row) => row.expected.work_mode === "revise")).toBe(true);
		expect(rows.some((row) => row.expected.profile === "frontend-engineer")).toBe(true);
		expect(rows.some((row) => Object.values(row.expected).includes(false))).toBe(true);
	}, 60_000);

	it.skipIf(!process.env.RELAY_DELEGATION_CORPUS_OUTPUT)(
		"exports a fingerprinted corpus separately from acceptance data",
		async () => {
			vi.spyOn(globalThis, "fetch").mockImplementation(
				async () => new Response(JSON.stringify(delegationTestHealth())),
			);
			const destination = resolve(process.env.RELAY_DELEGATION_CORPUS_OUTPUT!);
			if (existsSync(destination))
				throw new Error("Use a new corpus destination to preserve previous training inputs");
			const rows = await captureCorpus(trainingCases(true));
			const sources = [
				"test/delegation-training.test.ts",
				"src/extensions/delegation/decisions.ts",
				"src/core/delegation/contracts.ts",
			];
			mkdirSync(destination, { recursive: true });
			const digest = createHash("sha256");
			const output = openSync(resolve(destination, "dataset.jsonl"), "wx");
			try {
				for (const row of rows) {
					const line = `${JSON.stringify(row)}\n`;
					writeFileSync(output, line);
					digest.update(line);
				}
			} finally {
				closeSync(output);
			}
			writeFileSync(resolve(destination, "decisions.json"), JSON.stringify(layaDecisionsFile(), null, 2));
			writeFileSync(
				resolve(destination, "manifest.json"),
				JSON.stringify(
					{
						version: 1,
						contract: "phase-independent-delegation-v3",
						rows: rows.length,
						splits: Object.fromEntries(
							["train", "val", "test"].map((split) => [split, rows.filter((row) => row.split === split).length]),
						),
						sha256: digest.digest("hex"),
						sourceSha256: Object.fromEntries(
							sources.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
						),
						acceptanceDataUsed: false,
					},
					null,
					2,
				),
			);
		},
		600_000,
	);
});
