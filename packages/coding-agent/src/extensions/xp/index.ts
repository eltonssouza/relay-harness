import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compileDecision, type DecisionTrace, judgeDecision } from "@relay-harness/agent-core";
import type { ClassifierResult } from "@relay-harness/ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { loadAgentProfile } from "../engineering/index.ts";
import { readGoal } from "../goal/state.ts";
import { LAYA_CLASSIFIER_ID, LAYA_PROVIDER_ID } from "../laya/index.ts";
import { applyXpAction, XP_PHASE_GUIDANCE, XP_PHASES, type XpPhase, type XpState, xpObservation } from "./workflow.ts";

const STATE_ENTRY = "xp.state";
const TRACE_ENTRY = "xp.decision";
const checkpointSchema = Type.Object({
	summary: Type.String({ minLength: 1, maxLength: 4000 }),
	evidenceIds: Type.Array(Type.String(), { maxItems: 20 }),
});

const SPECIFICATION_SECTIONS: Record<XpPhase, string> = {
	planning: "Problem, requirements, constraints, risks and acceptance criteria",
	design: "Technical decisions, alternatives and trade-offs",
	testing: "Test cases derived from acceptance criteria and observed validation",
	coding: "Implementation and verification against the specification",
	listening: "Outcome, validation, feedback and follow-up",
};

/** Resolve only the workflow's own artifact; never trust a model-supplied path. */
function specificationFile(ctx: ExtensionContext, state: XpState): string {
	if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(state.id))
		throw new Error("Invalid XP workflow ID");
	const relayDir = join(ctx.cwd, ".relay");
	const dir = join(relayDir, "specs");
	for (const path of [relayDir, dir]) {
		if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
			throw new Error(`XP specification directory must not be a symlink: ${path}`);
	}
	const path = join(dir, `${state.id}.md`);
	if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
		throw new Error("XP specification must not be a symlink");
	return path;
}

/** Store the task's phase reports in one project-local specification. */
function writeSpecification(ctx: ExtensionContext, state: XpState): void {
	if (!state.automatic) return;
	const path = specificationFile(ctx, state);
	const sections = XP_PHASES.map(
		(phase) =>
			`## ${phase[0].toUpperCase()}${phase.slice(1)}\n\n${SPECIFICATION_SECTIONS[phase]}\n\n${state.specificationReports?.[phase] ?? "Pending."}`,
	);
	const content = `# Task specification\n\n${state.goal}\n\n${sections.join("\n\n")}\n`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
	state.specificationPath = `.relay/specs/${state.id}.md`;
	state.specificationDigest = createHash("sha256").update(content).digest("hex");
}

function specificationMatches(ctx: ExtensionContext, state: XpState): boolean {
	try {
		return (
			createHash("sha256")
				.update(readFileSync(specificationFile(ctx, state)))
				.digest("hex") === state.specificationDigest
		);
	} catch {
		return false;
	}
}

const PHASE_ROLES = {
	planning: "product-owner",
	design: "software-architect",
	testing: "quality-assurance",
	coding: "software-engineer",
	listening: "product-owner",
} as const;

export default function xpExtension(relay: ExtensionAPI): void {
	let state: XpState | undefined;
	let checkpointInRun = false;
	let awaitingIntent = false;
	let intentAttempts = 0;
	let taskRun = false;
	let explicitIntent = false;
	let prompt = "";
	const calls = new Map<string, { workflow: string; revision: number }>();
	const restore = (ctx: ExtensionContext) => {
		state = undefined;
		calls.clear();
		for (const entry of ctx.sessionManager.getBranch().toReversed()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const saved = entry.data as XpState | undefined;
			if (saved?.version === 1) state = structuredClone(saved);
			break;
		}
		if (state?.status === "active") {
			const tools = relay.getActiveTools();
			if (!tools.includes("xp_checkpoint")) relay.setActiveTools([...tools, "xp_checkpoint"]);
		}
	};
	const save = () => {
		if (state) relay.appendEntry(STATE_ENTRY, structuredClone(state));
	};
	const invalidateChangedSpecification = (ctx: ExtensionContext) => {
		if (state?.automatic && state.specificationApproved && !specificationMatches(ctx, state)) {
			state.specificationApproved = false;
			state.phase = "design";
			state.revision++;
			state.accepted = false;
			state.listeningReported = false;
			save();
		}
	};
	const intentHint =
		"[harness:xp] Before answering or using other tools, call xp_intent to identify whether this request is a task or only a question. Every task must pass Planning, Design, Testing, Coding and Listening, in order. Questions do not start XP. Use testsRequired=false only for tasks with no executable behavior; Testing still requires a concrete review. Tasks start automatically. When a /goal is active, continue all five phases autonomously without human approval; otherwise pause after Design for human review and /xp approve-spec. Never claim or execute user approval on the user's behalf.";
	const hint = () =>
		state
			? `[harness:xp] ${state.phase}: ${XP_PHASE_GUIDANCE[state.phase]}\nGoal: ${state.goal}\nCall xp_checkpoint with the phase report and actual tool call IDs. Your report is saved in the single SDD at ${state.specificationPath ?? `.relay/specs/${state.id}.md`}. In Planning specify requirements, constraints, risks and acceptance criteria; in Design record decisions and alternatives; in Testing derive cases from the acceptance criteria; in Coding verify against them; in Listening record feedback. ${state.goalDriven ? "This /goal task proceeds autonomously through all phases; do not wait for /xp approve-spec." : "After Design wait for /xp approve-spec from the user."} Do not skip phases or claim user acceptance.`
			: "";
	relay.on("session_start", (_event, ctx) => restore(ctx));
	relay.on("session_tree", (_event, ctx) => restore(ctx));
	relay.on("agent_start", () => {
		checkpointInRun = false;
	});
	relay.on("before_agent_start", (event, ctx) => {
		prompt = event.prompt;
		// Only locally dispatched /xp controls establish intent, not user-supplied text.
		awaitingIntent = !explicitIntent;
		explicitIntent = false;
		intentAttempts = 0;
		taskRun = !awaitingIntent && state?.status === "active";
		const tools = relay.getActiveTools();
		relay.setActiveTools([...new Set([...tools, "xp_intent", "xp_checkpoint"])]);
		if (awaitingIntent) return { message: { customType: "xp.intent", content: intentHint, display: false } };
		if (state?.status !== "active") return;
		const role = loadAgentProfile(PHASE_ROLES[state.phase], ctx);
		return {
			message: { customType: "xp.plan", content: [hint(), role].filter(Boolean).join("\n\n"), display: false },
		};
	});
	relay.on("agent_before_settle", (event, ctx) => {
		if (awaitingIntent && event.outcome === "completed" && !ctx.signal?.aborted && !ctx.hasPendingMessages()) {
			intentAttempts++;
			return {
				entries: [
					{
						type: "custom_message",
						customType: intentAttempts >= 3 ? "xp.handoff" : "xp.intent",
						content:
							intentAttempts >= 3
								? "XP incomplete: the agent did not identify the request intent. No task completion was verified."
								: intentHint,
						display: intentAttempts >= 3,
					},
				],
				continue: intentAttempts < 3,
			};
		}
		if (taskRun && state?.status === "active") invalidateChangedSpecification(ctx);
		if (
			event.outcome === "completed" &&
			!ctx.signal?.aborted &&
			!ctx.hasPendingMessages() &&
			taskRun &&
			state?.automatic &&
			state.status === "active" &&
			state.phase === "design" &&
			!state.goalDriven &&
			state.specificationReports?.design &&
			!state.specificationApproved
		) {
			save();
			return {
				entries: [
					{
						type: "custom_message",
						customType: "xp.specification_review",
						content: `SDD ready for review: ${state.specificationPath}. Review it, then run /xp approve-spec to begin Testing.`,
						display: true,
					},
				],
				continue: false,
			};
		}
		if (
			!taskRun ||
			state?.status !== "active" ||
			event.outcome !== "completed" ||
			ctx.signal?.aborted ||
			ctx.hasPendingMessages() ||
			(state.phase === "listening" && !state.accepted && (!state.automatic || state.listeningReported))
		)
			return;
		state.continuationsWithoutCheckpoint = checkpointInRun ? 0 : (state.continuationsWithoutCheckpoint ?? 0) + 1;
		if (state.steps >= 50 || state.continuationsWithoutCheckpoint >= 3) {
			state.status = "handoff";
			save();
			return {
				entries: [
					{
						type: "custom_message",
						customType: "xp.handoff",
						content:
							"XP paused: the decision limit was reached or the agent ended three runs without a checkpoint. Inspect xp.state and xp.decision; /xp resume continues the workflow.",
						display: true,
					},
				],
			};
		}
		save();
		return {
			entries: [
				{
					type: "custom_message",
					customType: "xp.plan",
					content: [hint(), loadAgentProfile(PHASE_ROLES[state.phase], ctx)].filter(Boolean).join("\n\n"),
					display: false,
				},
			],
			continue: true,
		};
	});
	relay.on("tool_call", (event, ctx) => {
		if (event.toolName === "xp_intent") return;
		if (awaitingIntent) return { block: true, reason: "Call xp_intent before using tools for this request." };
		if (!taskRun && ["write", "edit"].includes(event.toolName))
			return { block: true, reason: "A mutation is a task. Call xp_intent with kind=task first." };
		if (state?.status !== "active" || !taskRun) return;
		invalidateChangedSpecification(ctx);
		if (event.toolName === "xp_checkpoint") return;
		if (
			state.automatic &&
			!state.goalDriven &&
			state.phase === "design" &&
			state.specificationReports?.design &&
			!state.specificationApproved &&
			!["read", "grep", "find", "ls", "tool_search", "get_goal"].includes(event.toolName)
		)
			return { block: true, reason: "Review the SDD and run /xp approve-spec before Testing or Coding." };
		if (state.automatic && ["write", "edit"].includes(event.toolName) && !["testing", "coding"].includes(state.phase))
			return { block: true, reason: "Write tests during Testing and implementation during Coding." };
		if (event.toolName === "update_goal" && event.input.status === "complete" && !state.listeningReported)
			return {
				block: true,
				reason: "Complete all five XP checkpoints, including Listening, before completing the goal.",
			};
		// Shell and unknown tools can mutate too. Conservatively invalidate prior green evidence.
		if (!["read", "grep", "find", "ls", "tool_search", "get_goal", "update_goal"].includes(event.toolName)) {
			state.revision++;
			state.accepted = false;
			state.listeningReported = false;
			save();
		}
		calls.set(event.toolCallId, { workflow: state.id, revision: state.revision });
	});
	relay.on("tool_result", (event) => {
		if (state?.status !== "active" || event.toolName === "xp_checkpoint") return;
		const started = calls.get(event.toolCallId);
		calls.delete(event.toolCallId);
		if (!started || started.workflow !== state.id) return;
		state.evidence.push({
			id: event.toolCallId,
			tool: event.toolName,
			command: typeof event.input.command === "string" ? event.input.command : undefined,
			isError: event.isError,
			text: event.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.slice(-4000),
			revision: started.revision,
		});
		state.evidence = state.evidence.slice(-100);
		save();
	});
	relay.registerTool({
		name: "xp_intent",
		label: "XP request intent",
		description:
			"Required at the start of each user request: identify a task or a question. Tasks automatically enter the five-stage XP workflow. Set continueTask=true only to continue an existing task. Non-executable tasks use testsRequired=false but still perform Testing as a concrete review.",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("task"), Type.Literal("question")]),
			testsRequired: Type.Optional(Type.Boolean()),
			continueTask: Type.Optional(Type.Boolean()),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!awaitingIntent && taskRun)
				throw new Error("This request already has task intent; complete its XP phases before reclassifying.");
			awaitingIntent = false;
			taskRun = params.kind === "task";
			if (!taskRun)
				return {
					content: [{ type: "text", text: "Question: answer directly; no XP task workflow started." }],
					details: { kind: params.kind },
				};
			if (!params.continueTask || state?.status !== "active") {
				if (state?.status === "active") {
					state.status = "stopped";
					save();
				}
				state = {
					version: 1,
					id: randomUUID(),
					goal: prompt,
					phase: "planning",
					status: "active",
					steps: 0,
					refusals: 0,
					continuationsWithoutCheckpoint: 0,
					revision: 0,
					accepted: false,
					testsRequired: params.testsRequired ?? true,
					evidence: [],
					automatic: true,
					goalDriven: readGoal(ctx.sessionManager)?.status === "active",
				};
				calls.clear();
				writeSpecification(ctx, state);
				save();
			}
			return {
				content: [
					{
						type: "text",
						text: [hint(), loadAgentProfile(PHASE_ROLES[state.phase], ctx)].filter(Boolean).join("\n\n"),
					},
				],
				details: { kind: params.kind, phase: state.phase },
			};
		},
	});
	relay.registerTool({
		name: "xp_checkpoint",
		label: "XP checkpoint",
		description:
			"Report completed XP phase work and observed tool call IDs. The harness enforces all five ordered phases; Laya reviews transitions when available. Call xp_intent to begin tasks automatically.",
		parameters: checkpointSchema,
		exposure: "deferred",
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!state || state.status !== "active")
				throw new Error("Start or resume a workflow with /xp start or /xp resume");
			if (state.steps >= 50) {
				state.status = "handoff";
				save();
				throw new Error("XP reached 50 decisions; inspect xp.decision entries before /xp resume");
			}
			const current = state;
			const revision = current.revision;
			const phase = current.phase;
			const accepted = current.accepted;
			if (current.automatic) {
				if (["planning", "design"].includes(phase)) current.specificationApproved = false;
				current.specificationReports ??= {};
				current.specificationReports[phase] = params.summary.trim();
				current.specificationPhases ??= [];
				if (!current.specificationPhases.includes(phase)) current.specificationPhases.push(phase);
				writeSpecification(ctx, current);
			}
			if (current.automatic && !current.goalDriven && phase === "design" && !current.specificationApproved) {
				checkpointInRun = true;
				save();
				return {
					content: [
						{
							type: "text",
							text: `Design recorded in ${current.specificationPath}. Pause for user review; only /xp approve-spec can unlock Testing.`,
						},
					],
					details: { phase: "design", status: "awaiting-spec-approval" },
				};
			}
			const observation = xpObservation(current, params.summary, params.evidenceIds);
			const questions = compileDecision(observation);
			// Native tasks use deterministic gates and must not depend on a separate Laya service.
			const classifier = current.automatic
				? undefined
				: ctx.modelRegistry.findOfType("classifier", LAYA_PROVIDER_ID, LAYA_CLASSIFIER_ID);
			let answers: ClassifierResult["answers"] = {};
			let decisionError: string | undefined;
			try {
				if (!classifier) {
					if (!current.automatic)
						throw new Error("Laya classifier unavailable. Use /laya setup for manual /xp workflows.");
					const action = observation.goalReached
						? "finish"
						: observation.actions.advance
							? "advance"
							: "continue_phase";
					answers = {
						next_action: { type: "choice", choice: action, confidence: 1, probabilities: { [action]: 1 } },
						goal_reached: { type: "bool", probability: observation.goalReached ? 1 : 0 },
					};
				} else {
					const result = await ctx.modelRegistry.classify(
						classifier,
						{ state: observation.state, questions },
						{ signal, timeoutMs: 5000, maxRetries: 0 },
					);
					answers = result.answers;
					if (result.stopReason !== "stop") decisionError = result.errorMessage ?? result.stopReason;
				}
			} catch (error) {
				decisionError = error instanceof Error ? error.message : String(error);
			}
			// Session navigation or a concurrent user command must not mutate an obsolete workflow.
			if (
				state !== current ||
				current.status !== "active" ||
				current.revision !== revision ||
				current.phase !== phase ||
				current.accepted !== accepted
			)
				throw new Error("XP workflow changed while Laya was deciding");
			const verdict = judgeDecision(observation, answers);
			checkpointInRun = true;
			current.continuationsWithoutCheckpoint = 0;
			const trace: DecisionTrace = { observation, questions, answers, verdict };
			current.steps++;
			if (signal?.aborted || decisionError) {
				trace.error = decisionError ?? "aborted";
				current.status = "handoff";
			} else if (verdict.kind === "refused") {
				if (++current.refusals >= 3) current.status = "handoff";
			} else {
				current.refusals = 0;
				const signature = JSON.stringify([observation.state, verdict.action]);
				current.repeats = current.lastDecision === signature ? (current.repeats ?? 0) + 1 : 1;
				current.lastDecision = signature;
				if (current.repeats >= 3) {
					current.status = "handoff";
					trace.error = "Repeated decision on unchanged state";
				} else {
					if (phase === "listening" && observation.state.ready === true) current.listeningReported = true;
					applyXpAction(current, verdict.action);
				}
			}
			trace.result = { phase: current.phase, status: current.status, revision: current.revision };
			relay.appendEntry(TRACE_ENTRY, {
				version: 1,
				workflow: current.id,
				source: classifier ? "laya" : "harness",
				timestamp: new Date().toISOString(),
				...trace,
			});
			save();
			const content =
				current.status === "active"
					? [hint(), loadAgentProfile(PHASE_ROLES[current.phase], ctx)].filter(Boolean).join("\n\n")
					: `XP ${current.status}. Inspect ${TRACE_ENTRY} for the observation, questions, answers and confidence threshold. /xp resume continues a handoff.`;
			return {
				content: [{ type: "text", text: content }],
				details: { phase: current.phase, status: current.status, verdict, error: trace.error },
				isError: trace.error !== undefined || verdict.kind === "refused",
			};
		},
	});
	relay.registerCommand("xp", {
		description: "XP workflow: start <goal>, approve-spec, status, accept, resume, stop",
		handler: async (args, ctx) => {
			const [command = "status", ...rest] = args.trim().split(/\s+/);
			if (["start", "accept", "approve-spec", "resume"].includes(command) && !ctx.isIdle()) {
				ctx.ui.notify("Wait for the current agent run to finish before changing the XP workflow.", "warning");
				return;
			}
			if (command === "start") {
				if (state?.status === "active") {
					ctx.ui.notify("An XP workflow is active. Use /xp stop before starting another.", "warning");
					return;
				}
				const noTests = rest[0] === "--no-tests";
				const goal = (noTests ? rest.slice(1) : rest).join(" ");
				if (!goal) {
					ctx.ui.notify(
						"Usage: /xp start [--no-tests] <goal>; --no-tests is for tasks without executable behavior.",
						"warning",
					);
					return;
				}
				state = {
					version: 1,
					id: randomUUID(),
					goal,
					phase: "planning",
					status: "active",
					steps: 0,
					refusals: 0,
					continuationsWithoutCheckpoint: 0,
					revision: 0,
					accepted: false,
					testsRequired: !noTests,
					evidence: [],
				};
				save();
			} else if (
				command === "approve-spec" &&
				state?.automatic &&
				["active", "handoff"].includes(state.status) &&
				state.phase === "design"
			) {
				if (
					!state.specificationPath ||
					!state.specificationReports?.planning ||
					!state.specificationReports.design
				) {
					ctx.ui.notify("The SDD needs Planning and Design reports before approval.", "warning");
					return;
				}
				if (!specificationMatches(ctx, state)) {
					state.specificationApproved = false;
					save();
					ctx.ui.notify(
						"The SDD changed or is unavailable. Record the updated Design checkpoint before approving it.",
						"warning",
					);
					return;
				}
				state.specificationApproved = true;
				state.status = "active";
				const observation = xpObservation(state, state.specificationReports.design, []);
				const questions = compileDecision(observation);
				const answers: ClassifierResult["answers"] = {
					next_action: { type: "choice", choice: "advance", confidence: 1, probabilities: { advance: 1 } },
					goal_reached: { type: "bool", probability: 0 },
				};
				const verdict = judgeDecision(observation, answers);
				if (verdict.kind === "refused") {
					state.specificationApproved = false;
					save();
					ctx.ui.notify("The SDD is not ready for approval; complete Planning and Design first.", "warning");
					return;
				}
				applyXpAction(state, verdict.action);
				state.steps++;
				const trace: DecisionTrace = {
					observation,
					questions,
					answers,
					verdict,
					result: { phase: state.phase, status: state.status, revision: state.revision },
				};
				relay.appendEntry(TRACE_ENTRY, {
					version: 1,
					workflow: state.id,
					source: "user",
					timestamp: new Date().toISOString(),
					specificationPath: state.specificationPath,
					...trace,
				});
				state.continuationsWithoutCheckpoint = 0;
				state.lastDecision = undefined;
				state.repeats = 0;
				save();
			} else if (command === "stop" && state) {
				state.status = "stopped";
				save();
				ctx.ui.notify("XP workflow stopped.");
				return;
			} else if (command === "accept" && state?.status === "active" && state.phase === "listening") {
				state.accepted = true;
				save();
			} else if (command === "resume" && state?.status === "handoff") {
				state.status = "active";
				state.steps = 0;
				state.refusals = 0;
				state.continuationsWithoutCheckpoint = 0;
				state.lastDecision = undefined;
				state.repeats = 0;
				save();
			} else if (command === "status") {
				ctx.ui.notify(
					state
						? `XP ${state.status}: ${state.phase}, ${state.steps}/50 decisions, goal: ${state.goal}`
						: "No XP workflow. /xp start <goal>",
				);
				return;
			} else {
				ctx.ui.notify(
					"Usage: /xp [start <goal>|approve-spec (after Design)|status|accept (in Listening)|resume (after handoff)|stop]",
					"warning",
				);
				return;
			}
			const tools = relay.getActiveTools();
			if (!tools.includes("xp_checkpoint")) relay.setActiveTools([...tools, "xp_checkpoint"]);
			explicitIntent = true;
			relay.sendUserMessage(hint(), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});
}
