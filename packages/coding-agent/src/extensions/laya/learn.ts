import type { AgentMessage } from "@relay-harness/agent-core";
import { type Static, type TSchema, Type } from "typebox";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { TaskAssessment } from "./assessment.ts";
import type { PolicyDecision } from "./policy.ts";
import { type CapabilityTier, LAYA_QUESTIONS } from "./questions.ts";
import { LAYA_PLAN_MESSAGE } from "./routers.ts";
import { HARNESS_MESSAGE, summarizeRun, truncateRequest } from "./telemetry.ts";
import { SESSION_SOURCE, type TrainingRow } from "./training.ts";

/**
 * `/laya learn`: turns the tasks of a session into training exercises. Relay extracts each request
 * with the evidence of how it went (tools, files, commands, failures, checks, the model that ran
 * it, the user's next message); the agent answers Laya's questions for each one from that evidence
 * and saves them with the `laya_learn` tool.
 */

export const LEARN_TOOL_NAME = "laya_learn";
/** Starts the agent's turn of `/laya learn`. It is harness text, never a task itself. */
export const LEARN_MESSAGE_PREFIX = "[laya:learn]";
/** Newest tasks of a long session that are offered for labeling. */
const MAX_TASKS = 60;
const MAX_FILES = 12;
const MAX_COMMANDS = 8;
const MAX_ERRORS = 3;

export interface SessionTask {
	/** 1-based number the agent refers to. */
	number: number;
	request: string;
	/** Tool name to number of calls. */
	tools: Record<string, number>;
	files: string[];
	commands: string[];
	toolFailures: number;
	/** First line of the first failed tool results. */
	errors: string[];
	/** Outcome of the last test, type check, build or lint run, or null when none ran. */
	testsPassed: boolean | null;
	outcome: "completed" | "error" | "aborted";
	/** `provider/model • thinking`, with the capability tier when the Laya registry lists the model. */
	models: string[];
	/** The laya/auto plan, when it routed the task. */
	planned?: { type: string; tier: string; effort: string; source: string };
	/** The end of the agent's last reply. */
	reply: string;
	/** The user's next request: a correction there means the task was not done right. */
	next?: string;
}

interface PlanDetails {
	assessment?: TaskAssessment;
	policy?: PolicyDecision;
}

function userText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

const clip = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Requests of a session branch and the evidence of how each one went. */
export function sessionTasks(
	entries: readonly SessionEntry[],
	tierOf: (ref: string) => CapabilityTier | undefined = () => undefined,
): SessionTask[] {
	const groups: Array<{ request: string; messages: AgentMessage[]; plan?: PlanDetails; skip?: boolean }> = [];
	for (const entry of entries) {
		if (entry.type === "custom_message" && entry.customType === LAYA_PLAN_MESSAGE) {
			const group = groups.at(-1);
			if (group) group.plan = entry.details as PlanDetails;
			continue;
		}
		if (entry.type !== "message") continue;
		const text = userText(entry.message)?.trim();
		if (text?.startsWith(LEARN_MESSAGE_PREFIX)) {
			// The work of an earlier /laya learn belongs to no task.
			groups.push({ request: text, messages: [], skip: true });
		} else if (text && !HARNESS_MESSAGE.test(text)) {
			groups.push({ request: text, messages: [] });
		} else {
			groups.at(-1)?.messages.push(entry.message);
		}
	}

	const tasks: SessionTask[] = [];
	groups.forEach((group, index) => {
		if (group.skip) return;
		const tools: Record<string, number> = {};
		const files = new Set<string>();
		const commands: string[] = [];
		const models = new Set<string>();
		const errors: string[] = [];
		let reply = "";
		for (const message of group.messages) {
			if (message.role === "toolResult" && message.isError && errors.length < MAX_ERRORS) {
				const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
				const line = text.split("\n").find((candidate) => candidate.trim());
				if (line) errors.push(`${message.toolName}: ${clip(line, 160)}`);
			}
			if (message.role !== "assistant") continue;
			const ref = `${message.provider}/${message.model}`;
			const tier = tierOf(ref);
			models.add(
				`${ref}${tier ? ` (${tier} tier)` : ""}${message.thinkingLevel ? ` • ${message.thinkingLevel}` : ""}`,
			);
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) reply = block.text;
				if (block.type !== "toolCall") continue;
				tools[block.name] = (tools[block.name] ?? 0) + 1;
				const path = block.arguments.path ?? block.arguments.file_path;
				if (typeof path === "string" && /^(edit|write|multi_edit|notebook_edit)$/.test(block.name)) files.add(path);
				if (typeof block.arguments.command === "string") commands.push(clip(block.arguments.command, 200));
			}
		}
		const summary = summarizeRun(group.messages);
		const assessment = group.plan?.assessment;
		const following = groups.slice(index + 1).find((other) => !other.skip);
		tasks.push({
			number: 0,
			request: truncateRequest(group.request),
			tools,
			files: [...files],
			commands,
			toolFailures: summary.toolFailures,
			errors,
			testsPassed: summary.testsPassed,
			outcome: summary.outcome,
			models: [...models],
			planned: assessment && {
				type: assessment.task.type,
				tier: group.plan?.policy?.requiredTier ?? assessment.recommendation.tier,
				effort: assessment.recommendation.effort,
				source: assessment.source,
			},
			reply: clip(reply, 300),
			next: following && clip(following.request, 200),
		});
	});
	return tasks.slice(-MAX_TASKS).map((task, i) => ({ ...task, number: i + 1 }));
}

export function renderTask(task: SessionTask): string {
	const lines = [`### Task ${task.number}`, "Request:", "<request>", task.request, "</request>"];
	const checks = task.testsPassed === null ? "no checks ran" : task.testsPassed ? "checks passed" : "checks failed";
	lines.push(
		`Ran on: ${task.models.join(", ") || "no model answered"}; outcome ${task.outcome}; ${task.toolFailures} failed tool calls; ${checks}`,
	);
	if (task.planned) {
		lines.push(
			`Laya planned: ${task.planned.type}, ${task.planned.tier} tier, ${task.planned.effort} effort (${task.planned.source})`,
		);
	}
	const tools = Object.entries(task.tools).map(([name, count]) => `${name}×${count}`);
	lines.push(`Tools: ${tools.join(", ") || "none"}`);
	if (task.files.length > 0) {
		const more = task.files.length > MAX_FILES ? ` and ${task.files.length - MAX_FILES} more` : "";
		lines.push(`Files changed (${task.files.length}): ${task.files.slice(0, MAX_FILES).join(", ")}${more}`);
	}
	if (task.commands.length > 0) {
		lines.push(`Commands: ${task.commands.slice(0, MAX_COMMANDS).join(" | ")}`);
	}
	if (task.errors.length > 0) lines.push(`Errors: ${task.errors.join(" | ")}`);
	if (task.reply) lines.push(`Last reply: ${task.reply}`);
	if (task.next) lines.push(`Next user message: ${task.next}`);
	return lines.join("\n");
}

/** Laya's questions with their answer options, for the agent that labels. */
export function renderQuestions(): string {
	return Object.entries(LAYA_QUESTIONS)
		.map(([id, question]) => {
			if (question.type === "choice") {
				const options = Object.entries(question.criteria).map(([key, text]) => `${key} (${text})`);
				return `- ${id}: ${question.instructions} One of: ${options.join("; ")}.`;
			}
			if (question.type === "score") {
				const levels = question.criteria.map((text, i) => `${i} ${text}`);
				return `- ${id}: ${question.instructions} An integer: ${levels.join("; ")}.`;
			}
			return `- ${id}: ${question.instructions} true or false.`;
		})
		.join("\n");
}

export function buildLearnPrompt(tasks: readonly SessionTask[], options: { source?: string } = {}): string {
	return `${LEARN_MESSAGE_PREFIX} Teach Laya, Relay's routing model, the tasks of ${options.source ? `the session ${options.source}` : "this session"}, so it routes similar requests better. Do not change any file and do not redo the tasks.

Laya reads a request and answers the questions below. Relay uses the answers to pick the model tier, the reasoning effort, the role, the tools and the validation for the request. For each task listed after the questions, decide the right answers from its evidence: what the task needed, not what was planned or what happened to run.

<questions>
${renderQuestions()}
</questions>

How to decide:
- capability_tier and reasoning_effort: the cheapest tier and the lowest effort that would have done the task right. A task that finished cleanly with no failed tool calls may have needed less than the tier that ran it if it was simple. A task that failed, needed many retries, was escalated, or was corrected in the next user message needed at least one tier more than the one that ran it.
- requires_*: what the task needed, with the tools and commands that ran as evidence. Changed files mean requires_write; test, type check, build or lint commands mean requires_tests; git commands mean requires_git; other commands mean requires_shell. A tool that ran without being needed does not count.
- scope: from the files changed and the request: one line or value, one file, one module, several modules, the whole repository, several repositories.
- complexity, risk, ambiguity, reasoning_requirement, validation_level, agent, task_type, security_sensitive: judge the request and what doing it right took.
- Leave out entries that are not tasks for a coding agent: greetings, thanks, or remarks about the conversation itself.

For each task, also write a lesson when the session taught something a model doing a similar task should know: the command that validated the result, where the change belongs, a mistake that cost a retry and how it was fixed, a convention the user asked for. Write it as advice for next time, in one to three sentences, in English, with concrete names (commands, paths, settings). Leave it out when there is nothing beyond the obvious. Never put secrets, tokens or personal data in a lesson.

Relay applies what you save at once: a new request similar to a learned task is routed with its labels, and the model that runs it reads its lesson. Training then teaches the routing model the same tasks.

<tasks>
${tasks.map(renderTask).join("\n\n")}
</tasks>

Then call the \`${LEARN_TOOL_NAME}\` tool once, with one exercise per task you keep. It saves them and starts training. Finally reply, in the language the user writes in, with a short table (task, type, tier, effort, lesson in a few words) and what happens next.`;
}

function labelSchema(): TSchema {
	const properties: Record<string, TSchema> = {};
	for (const [id, question] of Object.entries(LAYA_QUESTIONS)) {
		if (question.type === "choice") {
			properties[id] = Type.Union(
				Object.keys(question.criteria).map((key) => Type.Literal(key)),
				{ description: question.instructions },
			);
		} else if (question.type === "score") {
			properties[id] = Type.Integer({
				minimum: 0,
				maximum: question.criteria.length - 1,
				description: question.instructions,
			});
		} else {
			properties[id] = Type.Boolean({ description: question.instructions });
		}
	}
	return Type.Object(properties, { additionalProperties: false });
}

export const learnToolSchema = Type.Object({
	exercises: Type.Array(
		Type.Object({
			task: Type.Integer({ minimum: 1, description: "Task number from the /laya learn list." }),
			labels: labelSchema(),
			note: Type.Optional(
				Type.String({ description: "One sentence: the evidence behind the tier and the effort." }),
			),
			lesson: Type.Optional(
				Type.String({
					maxLength: 600,
					description:
						"Advice for a model doing a similar task: how to validate, where the change belongs, a mistake to avoid. One to three sentences, no secrets.",
				}),
			),
		}),
		{ minItems: 1, description: "One exercise per task worth learning." },
	),
	train: Type.Optional(Type.Boolean({ description: "Start training after saving. Default: true." })),
});

export type LearnToolParams = Static<typeof learnToolSchema>;

/** Checks that every question has a valid answer; the schema already does, this guards raw calls. */
export function labelProblems(labels: Record<string, unknown>): string[] {
	const problems: string[] = [];
	for (const [id, question] of Object.entries(LAYA_QUESTIONS)) {
		const value = labels[id];
		const valid =
			question.type === "choice"
				? typeof value === "string" && value in question.criteria
				: question.type === "score"
					? Number.isInteger(value) && (value as number) >= 0 && (value as number) < question.criteria.length
					: typeof value === "boolean";
		if (!valid) problems.push(`${id}: ${JSON.stringify(value)} is not a valid answer`);
	}
	return problems;
}

/** Training rows for the labeled tasks. Unknown task numbers and invalid labels are errors. */
export function exercisesToRows(
	tasks: readonly SessionTask[],
	exercises: LearnToolParams["exercises"],
	meta: { session: string; created: string },
): Array<Omit<TrainingRow, "id">> {
	const problems: string[] = [];
	const rows: Array<Omit<TrainingRow, "id">> = [];
	for (const exercise of exercises) {
		const task = tasks.find((candidate) => candidate.number === exercise.task);
		const labels = exercise.labels as Record<string, string | number | boolean>;
		if (!task) {
			problems.push(`task ${exercise.task}: there is no such task (1 to ${tasks.length})`);
			continue;
		}
		const invalid = labelProblems(labels);
		if (invalid.length > 0) {
			problems.push(...invalid.map((problem) => `task ${exercise.task}: ${problem}`));
			continue;
		}
		rows.push({
			state: { request: task.request },
			expected: Object.fromEntries(Object.keys(LAYA_QUESTIONS).map((id) => [id, labels[id]])),
			source: SESSION_SOURCE,
			// Every session task is studied: the user asked for these tasks to be learned.
			split: "train",
			session: meta.session,
			label_source: "agent",
			...(exercise.note ? { note: exercise.note } : {}),
			...(exercise.lesson?.trim() ? { lesson: exercise.lesson.trim() } : {}),
			created: meta.created,
		});
	}
	if (problems.length > 0) {
		throw new Error(
			`Nothing was saved. Fix these exercises and call ${LEARN_TOOL_NAME} again:\n- ${problems.join("\n- ")}`,
		);
	}
	return rows;
}
