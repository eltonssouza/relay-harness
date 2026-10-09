import { randomUUID } from "node:crypto";
import { compileDecision, type DecisionTrace, judgeDecision } from "@relay-harness/agent-core";
import type { ClassifierResult } from "@relay-harness/ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { loadAgentProfile } from "../engineering/index.ts";
import { LAYA_CLASSIFIER_ID, LAYA_PROVIDER_ID } from "../laya/index.ts";
import { applyXpAction, XP_PHASE_GUIDANCE, type XpState, xpObservation } from "./workflow.ts";

const STATE_ENTRY = "xp.state";
const TRACE_ENTRY = "xp.decision";
const checkpointSchema = Type.Object({
	summary: Type.String({ minLength: 1, maxLength: 4000 }),
	evidenceIds: Type.Array(Type.String(), { maxItems: 20 }),
});

const PHASE_ROLES = {
	planning: "product-owner",
	design: "software-architect",
	testing: "quality-assurance",
	coding: "software-engineer",
	listening: "product-owner",
} as const;

export default function xpExtension(relay: ExtensionAPI): void {
	let state: XpState | undefined;
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
	const hint = () =>
		state
			? `[harness:xp] ${state.phase}: ${XP_PHASE_GUIDANCE[state.phase]}\nGoal: ${state.goal}\nCall xp_checkpoint with the phase report and actual tool call IDs. Laya selects the transition; do not skip phases or claim completion before user acceptance.`
			: "";
	relay.on("session_start", (_event, ctx) => restore(ctx));
	relay.on("session_tree", (_event, ctx) => restore(ctx));
	relay.on("before_agent_start", (_event, ctx) => {
		if (state?.status !== "active") return;
		const role = loadAgentProfile(PHASE_ROLES[state.phase], ctx);
		return {
			message: { customType: "xp.plan", content: [hint(), role].filter(Boolean).join("\n\n"), display: false },
		};
	});
	relay.on("tool_call", (event) => {
		if (state?.status !== "active" || event.toolName === "xp_checkpoint") return;
		// Shell and unknown tools can mutate too. Conservatively invalidate prior green evidence.
		if (!["read", "grep", "find", "ls", "tool_search"].includes(event.toolName)) {
			state.revision++;
			state.accepted = false;
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
		name: "xp_checkpoint",
		label: "XP checkpoint",
		description:
			"Report phase work and observed tool call IDs; Laya gates the next XP transition. Only available after /xp start.",
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
			const observation = xpObservation(current, params.summary, params.evidenceIds);
			const questions = compileDecision(observation);
			const classifier = ctx.modelRegistry.findOfType("classifier", LAYA_PROVIDER_ID, LAYA_CLASSIFIER_ID);
			let result: ClassifierResult;
			try {
				if (!classifier) throw new Error("Laya classifier unavailable. Enable Laya and run /laya setup.");
				result = await ctx.modelRegistry.classify(
					classifier,
					{ state: observation.state, questions },
					{ signal, timeoutMs: 5000, maxRetries: 0 },
				);
			} catch (error) {
				result = {
					api: "typesafe-system-one",
					provider: LAYA_PROVIDER_ID,
					model: LAYA_CLASSIFIER_ID,
					answers: {},
					stopReason: signal?.aborted ? "aborted" : "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				};
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
			const verdict = judgeDecision(observation, result.answers);
			const trace: DecisionTrace = { observation, questions, answers: result.answers, verdict };
			current.steps++;
			if (signal?.aborted || result.stopReason !== "stop") {
				trace.error = result.errorMessage ?? result.stopReason;
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
				} else applyXpAction(current, verdict.action);
			}
			trace.result = { phase: current.phase, status: current.status, revision: current.revision };
			relay.appendEntry(TRACE_ENTRY, {
				version: 1,
				workflow: current.id,
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
		description: "XP workflow controlled by Laya: start <goal>, status, accept, resume, stop",
		handler: async (args, ctx) => {
			const [command = "status", ...rest] = args.trim().split(/\s+/);
			if (["start", "accept", "resume"].includes(command) && !ctx.isIdle()) {
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
					revision: 0,
					accepted: false,
					testsRequired: !noTests,
					evidence: [],
				};
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
					"Usage: /xp [start <goal>|status|accept (in listening)|resume (after handoff)|stop]",
					"warning",
				);
				return;
			}
			const tools = relay.getActiveTools();
			if (!tools.includes("xp_checkpoint")) relay.setActiveTools([...tools, "xp_checkpoint"]);
			relay.sendUserMessage(hint(), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});
}
