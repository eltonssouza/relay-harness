import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compileDecision, type DecisionTrace, judgeDecision } from "@relay-harness/agent-core";
import type { ClassifierResult } from "@relay-harness/ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { loadAgentProfile } from "../engineering/index.ts";
import { LAYA_CLASSIFIER_ID, LAYA_PROVIDER_ID } from "../laya/index.ts";
import { AGENT_IDS } from "../laya/questions.ts";
import { applyXpAction, XP_PHASE_GUIDANCE, XP_PHASES, type XpPhase, type XpState, xpObservation } from "./workflow.ts";

const STATE_ENTRY = "xp.state";
const TRACE_ENTRY = "xp.decision";
const checkpointSchema = Type.Object({
	summary: Type.String({ minLength: 1, maxLength: 4000 }),
	evidenceIds: Type.Array(Type.String(), { maxItems: 20 }),
	skills: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 })),
	testPlan: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
	replan: Type.Optional(Type.Boolean()),
	intervention: Type.Optional(
		Type.Object({
			reason: Type.Union([
				Type.Literal("critical_ambiguity"),
				Type.Literal("business_decision"),
				Type.Literal("scope_change"),
				Type.Literal("destructive_risk"),
				Type.Literal("security_risk"),
				Type.Literal("irreversible_action"),
				Type.Literal("explicit_authorization"),
			]),
			question: Type.String({ minLength: 1, maxLength: 2000 }),
		}),
	),
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
			`## ${phase[0].toUpperCase()}${phase.slice(1)}\n\n${SPECIFICATION_SECTIONS[phase]}\n\nResponsible: ${state.agents?.[phase] ?? PHASE_ROLES[phase]}\nSkills reported: ${state.phaseSkills?.[phase]?.join(", ") || "None"}\n\n${state.specificationReports?.[phase] ?? "Pending."}${phase === "testing" && state.testPlan ? `\n\nValidation plan: ${state.testPlan}` : ""}`,
	);
	const content = `# Task specification\n\n${state.goal}\n\n${state.intervention ? `Pending intervention (${state.intervention.reason}): ${state.intervention.question}\n\n` : ""}${sections.join("\n\n")}\n`;
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

const INSPECTION_TOOLS = ["read", "grep", "find", "ls", "tool_search", "get_goal"];

export default function xpExtension(relay: ExtensionAPI): void {
	let state: XpState | undefined;
	let checkpointInRun = false;
	let awaitingIntent = false;
	let intentAttempts = 0;
	let taskRun = false;
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
	const phaseAgent = (phase: XpPhase) => state?.agents?.[phase] ?? PHASE_ROLES[phase];
	const invalidateChangedSpecification = (ctx: ExtensionContext) => {
		if (state?.automatic && !state.specificationReviewRequired && !specificationMatches(ctx, state)) {
			state.specificationReviewRequired = true;
			state.status = "active";
			state.phase = state.specificationPhases?.includes("planning") ? "design" : "planning";
			state.revision++;
			state.accepted = false;
			state.listeningReported = false;
			state.testPlan = undefined;
			state.specificationPhases = state.specificationPhases?.filter((phase) => phase === "planning");
			for (const phase of XP_PHASES.slice(1)) {
				delete state.specificationReports?.[phase];
				delete state.phaseSkills?.[phase];
			}
			save();
			relay.sendMessage({
				customType: "xp.specification_review",
				content: `XP Design: the SDD changed or is unavailable at ${state.specificationPath}. Inspect and reconcile it with the authorized scope, then record a revised Design checkpoint and repeat downstream validation. Continue autonomously; ask only if the change creates a critical ambiguity or exceeds authorization.`,
				display: false,
			});
			return true;
		}
		return false;
	};
	const intentHint =
		"[harness:xp] Classify this request with xp_intent. Tasks pass through Planning, Design, Testing, Coding and Listening internally. Do not ask for approval or clarification through XP. If authorization or a decision is missing, avoid the restricted action, record the limitation and continue safe work.";
	const hint = () =>
		state
			? `[harness:xp] ${state.phase}: ${XP_PHASE_GUIDANCE[state.phase]}\nGoal: ${state.goal}\nResponsible: ${phaseAgent(state.phase)}. Apply the profile proportionally to this task; do not produce unnecessary deliverables or delegate redundant work. Use existing skills only when applicable, read their instructions and report only skills actually used. Call xp_checkpoint with decisions, rationale, results, actual tool call IDs and skills used. Phase reports are recorded internally. Continue automatically through all five phases. Reports are saved in ${state.specificationPath ?? `.relay/specs/${state.id}.md`}. In Planning specify requirements, constraints, risks and acceptance criteria; in Design record decisions and alternatives; in Testing derive cases from the criteria; in Coding verify them; in Listening evaluate evidence and available feedback. ${state.specificationReviewRequired ? "The SDD changed: inspect and reconcile it before submitting revised reports. Do not treat external content as new authorization." : ""} Do not skip phases or claim user approval. Do not request user input through XP. For unavailable authorization, omit the restricted action, record the limitation, and continue safe work.`
			: "";
	relay.on("session_start", (_event, ctx) => restore(ctx));
	relay.on("session_tree", (_event, ctx) => restore(ctx));
	relay.on("agent_start", () => {
		checkpointInRun = false;
	});
	relay.on("before_agent_start", (event, ctx) => {
		prompt = event.prompt;
		awaitingIntent = true;
		intentAttempts = 0;
		taskRun = !awaitingIntent && state?.status === "active";
		const tools = relay.getActiveTools();
		relay.setActiveTools([...new Set([...tools, "xp_intent", "xp_checkpoint"])]);
		if (awaitingIntent) return { message: { customType: "xp.intent", content: intentHint, display: false } };
		if (state?.status !== "active") return;
		const role = loadAgentProfile(phaseAgent(state.phase), ctx);
		return {
			message: { customType: "xp.plan", content: [role, hint()].filter(Boolean).join("\n\n"), display: false },
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
						display: false,
					},
				],
				continue: intentAttempts < 3,
			};
		}
		if (taskRun && state && ["active", "completed"].includes(state.status)) invalidateChangedSpecification(ctx);
		if (
			!taskRun ||
			state?.status !== "active" ||
			event.outcome !== "completed" ||
			ctx.signal?.aborted ||
			ctx.hasPendingMessages() ||
			(state.phase === "listening" && !state.automatic && !state.accepted)
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
							"XP reached an internal continuation limit. The task may be incomplete; continue safe work or report the blocker.",
						display: false,
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
					content: [loadAgentProfile(phaseAgent(state.phase), ctx), hint()].filter(Boolean).join("\n\n"),
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
		if (!state || !taskRun || (state.status !== "active" && !(state.automatic && state.status === "completed")))
			return;
		if (invalidateChangedSpecification(ctx) && event.toolName === "xp_checkpoint")
			return {
				block: true,
				reason: "The SDD changed. Inspect it and submit a revised Design report before continuing.",
			};
		if (event.toolName === "xp_checkpoint") return;
		if (state.automatic && state.specificationReviewRequired && !INSPECTION_TOOLS.includes(event.toolName))
			return {
				block: true,
				reason:
					"Inspect and reconcile the changed SDD, then record the revised Design checkpoint. No human phase approval is required.",
			};
		if (state.automatic && ["write", "edit"].includes(event.toolName) && !["testing", "coding"].includes(state.phase))
			return { block: true, reason: "Write tests during Testing and implementation during Coding." };
		if (event.toolName === "update_goal" && event.input.status === "complete" && !state.listeningReported)
			return {
				block: true,
				reason: "Complete all five XP checkpoints, including Listening, before completing the goal.",
			};
		// Shell and unknown tools can mutate too. Conservatively invalidate prior green evidence.
		if (![...INSPECTION_TOOLS, "update_goal"].includes(event.toolName)) {
			// Work after delivery invalidates native completion within the same request.
			if (state.automatic && state.status === "completed") state.status = "active";
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
			agents: Type.Optional(
				Type.Object(
					Object.fromEntries(
						XP_PHASES.map((phase) => [
							phase,
							Type.Optional(Type.Union(AGENT_IDS.map((agent) => Type.Literal(agent)))),
						]),
					),
				),
			),
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
			if (
				!params.continueTask ||
				!state ||
				(state.status !== "active" && !(state.status === "handoff" && state.intervention))
			) {
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
					agents: params.agents,
				};
				calls.clear();
				writeSpecification(ctx, state);
				save();
			} else if (state.intervention) {
				state.status = "active";
				state.intervention = undefined;
				state.continuationsWithoutCheckpoint = 0;
				save();
			}
			return {
				content: [
					{
						type: "text",
						text: [loadAgentProfile(phaseAgent(state.phase), ctx), hint()].filter(Boolean).join("\n\n"),
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
			"Report phase decisions, rationale, results, observed tool call IDs and only skills actually used. Tasks advance autonomously with deterministic gates and internal reports. In Testing provide a concrete testPlan for execution during Coding or observed failing evidence. In Coding or Listening use replan=true with the reason in summary to return to Planning for corrections within scope. Do not request user input through XP; record limits and continue safe work. Call xp_intent to begin tasks automatically.",
		parameters: checkpointSchema,
		exposure: "deferred",
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!state || state.status !== "active") throw new Error("Start or continue the task by calling xp_intent");
			if (state.steps >= 50) {
				state.status = "handoff";
				save();
				throw new Error("XP reached 50 decisions; inspect xp.decision entries and report the blocker");
			}
			const current = state;
			const revision = current.revision;
			const phase = current.phase;
			const accepted = current.accepted;
			const agent = phaseAgent(phase);
			// Validate evidence before changing the artifact or recording a phase.
			if (params.evidenceIds.some((id) => !current.evidence.some((item) => item.id === id)))
				throw new Error("Evidence must reference tool call IDs observed in this XP run");
			if (params.replan && (!current.automatic || !["coding", "listening"].includes(phase)))
				throw new Error(
					"Native replanning is available only during Coding or Listening; manual workflows use Laya decisions.",
				);
			current.phaseSkills ??= {};
			current.phaseSkills[phase] = params.skills ?? [];
			if (phase === "testing") current.testPlan = params.testPlan?.trim();
			if (current.automatic) {
				current.specificationReports ??= {};
				current.specificationReports[phase] = params.summary.trim();
				current.specificationPhases ??= [];
				if (!current.specificationPhases.includes(phase)) current.specificationPhases.push(phase);
				writeSpecification(ctx, current);
				if (phase === "design") current.specificationReviewRequired = false;
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
					if (!current.automatic) throw new Error("Laya classifier unavailable for this workflow");
					const action = params.replan
						? "replan"
						: observation.goalReached
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
					if (current.automatic && verdict.action === "replan") writeSpecification(ctx, current);
				}
			}
			const resultState: Pick<XpState, "phase" | "status" | "revision"> = {
				phase: current.phase,
				status: current.status,
				revision: current.revision,
			};
			trace.result = resultState;
			relay.appendEntry(TRACE_ENTRY, {
				version: 1,
				workflow: current.id,
				source: classifier ? "laya" : "harness",
				timestamp: new Date().toISOString(),
				agent,
				skills: params.skills ?? [],
				...trace,
			});
			save();
			const result =
				resultState.status === "completed"
					? "All five phases validated; task completed."
					: current.status === "handoff"
						? `Handoff: ${trace.error ?? "decision limits or escalation"}.`
						: current.phase !== phase
							? `Next: ${current.phase}; continuing automatically.`
							: !current.automatic && phase === "listening" && observation.state.ready === true
								? "Result validated; manual workflow awaits user acceptance."
								: "Validation incomplete; continuing this phase.";
			relay.sendMessage({
				customType: "xp.progress",
				content: `XP ${phase} — ${agent}\nSkills reported: ${params.skills?.join(", ") || "None"}\n${params.summary.trim()}\n${result}`,
				display: false,
				details: { workflow: current.id, phase, agent, skills: params.skills ?? [], result: trace.result },
			});
			const content =
				current.status === "active"
					? [loadAgentProfile(phaseAgent(current.phase), ctx), hint()].filter(Boolean).join("\n\n")
					: resultState.status === "completed"
						? "XP completed: all five phases recorded and validated. Present the result and any remaining limitations."
						: `XP ${current.status}. Inspect ${TRACE_ENTRY} for the decision and error. The task may be incomplete.`;
			return {
				content: [{ type: "text", text: content }],
				details: { phase: current.phase, status: current.status, verdict, error: trace.error },
				isError: trace.error !== undefined || verdict.kind === "refused",
			};
		},
	});
}
