/**
 * Pillar 1: alignment with the developer.
 *
 * Problem: in 20,574 real sessions the most frequent failure was violating an explicit developer
 * constraint (38%), and the agent self-corrected without pushback in only 3% of resolved cases
 * (Tang et al., 2026). Constraints live as prose in an earlier message, so they fade as context
 * grows or is compacted; questions get treated as permission to edit; CLI agents run destructive
 * or external operations without asking.
 *
 * Solution, independent of the model:
 * - `ConstraintLedger` keeps developer constraints as state, outside the transcript, and the
 *   harness restates them next to the latest message on every request.
 * - `AuthorizationGate` blocks destructive and external effects until the developer authorizes
 *   them: by naming the operation in their request, by answering "yes" after the agent asks, or
 *   through an interactive `authorize` callback.
 * - The scope guard stops the first mutation in a turn where the developer only asked a question.
 */

import type { BeforeToolCallResult } from "../types.ts";
import { requiresAuthorization, type ToolEffect } from "./effects.ts";
import { clip, developerProse, phrasePattern, wordsPattern } from "./text.ts";

// ============================================================================
// Constraint ledger
// ============================================================================

export interface DeveloperConstraint {
	id: string;
	text: string;
	/** `message` when extracted from a developer message, `api` when added programmatically. */
	source: "message" | "api";
	timestamp: number;
}

/** Sentences that begin with a standing directive. */
const DIRECTIVE_START = new RegExp(
	`^(?:please\\s+|por favor,?\\s+)?${
		wordsPattern([
			"never",
			"always",
			"only",
			"avoid",
			"keep",
			"prefer",
			"stick to",
			"nunca",
			"sempre",
			"apenas",
			"somente",
			"jamais",
			"evite",
			"mantenha",
			"prefira",
		]).source
	}`,
	"iu",
);

const CONSTRAINED_VERBS = [
	"use",
	"change",
	"modify",
	"touch",
	"edit",
	"commit",
	"push",
	"run",
	"add",
	"remove",
	"delete",
	"create",
	"install",
	"rename",
	"refactor",
	"call",
	"write",
	"break",
	"import",
	"update",
	"upgrade",
	"downgrade",
	"mock",
	"skip",
	"disable",
	"usar?",
	"altere",
	"alterar",
	"mude",
	"mudar",
	"mexa",
	"mexer",
	"toque",
	"tocar",
	"edite",
	"editar",
	"commite",
	"commitar",
	"faça",
	"fazer",
	"rode",
	"rodar",
	"execute",
	"executar",
	"adicione",
	"adicionar",
	"remova",
	"remover",
	"apague",
	"apagar",
	"deletar",
	"crie",
	"criar",
	"instale",
	"instalar",
	"renomeie",
	"renomear",
	"refatore",
	"refatorar",
	"chame",
	"chamar",
	"escreva",
	"escrever",
	"quebre",
	"quebrar",
	"importe",
	"importar",
	"atualize",
	"atualizar",
	"pule",
	"pular",
	"desative",
	"desativar",
];

/** A negated or restricting modal followed by an action verb anywhere in the sentence. */
const DIRECTIVE_INNER = phrasePattern(
	[
		"do not",
		"don't",
		"dont",
		"never",
		"must not",
		"mustn't",
		"should not",
		"shouldn't",
		"only",
		"always",
		"não",
		"nao",
		"nunca",
		"jamais",
		"sempre",
		"apenas",
		"somente",
		"só",
	],
	CONSTRAINED_VERBS,
);

/** "use X instead of Y". */
const DIRECTIVE_PREFERENCE =
	/\buse\s+.{1,60}\s+(?:instead of|rather than|em vez de|ao invés de|no lugar de)(?![\p{L}])/iu;

/**
 * Extract standing constraints from developer prose. Deterministic and conservative: a missed
 * constraint degrades to today's behavior, while a false one adds a stray reminder line.
 */
export function extractConstraints(text: string): string[] {
	const sentences = developerProse(text)
		.split(/\n+|(?<=[.!;])\s+/)
		.map((sentence) => sentence.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
		.filter((sentence) => sentence.length >= 8 && sentence.length <= 240 && !sentence.endsWith("?"));
	return sentences.filter(
		(sentence) =>
			DIRECTIVE_START.test(sentence) || DIRECTIVE_INNER.test(sentence) || DIRECTIVE_PREFERENCE.test(sentence),
	);
}

export interface ConstraintLedgerOptions {
	/** Most constraints kept; the oldest are dropped first. Default: 12. */
	maxConstraints?: number;
}

/** Developer constraints kept as state, independent of the transcript and of compaction. */
export class ConstraintLedger {
	private constraints: DeveloperConstraint[] = [];
	private nextId = 1;
	private readonly maxConstraints: number;
	/** Called after every change with the current list. */
	onChange?: (constraints: readonly DeveloperConstraint[]) => void;

	constructor(options: ConstraintLedgerOptions = {}) {
		this.maxConstraints = options.maxConstraints ?? 12;
	}

	/** Extract and record the constraints stated in a developer message. Returns the new ones. */
	observeDeveloperText(text: string, timestamp = Date.now()): DeveloperConstraint[] {
		const added = extractConstraints(text).flatMap((sentence) => {
			const constraint = this.insert(sentence, "message", timestamp);
			return constraint ? [constraint] : [];
		});
		if (added.length > 0) this.onChange?.(this.constraints);
		return added;
	}

	/** Record a constraint directly, e.g. from configuration or a slash command. */
	add(text: string, timestamp = Date.now()): DeveloperConstraint | undefined {
		const constraint = this.insert(text, "api", timestamp);
		if (constraint) this.onChange?.(this.constraints);
		return constraint;
	}

	remove(id: string): boolean {
		const before = this.constraints.length;
		this.constraints = this.constraints.filter((constraint) => constraint.id !== id);
		if (this.constraints.length === before) return false;
		this.onChange?.(this.constraints);
		return true;
	}

	clear(): void {
		if (this.constraints.length === 0) return;
		this.constraints = [];
		this.onChange?.(this.constraints);
	}

	/** Replace the ledger with persisted constraints, without notifying `onChange`. */
	restore(constraints: readonly DeveloperConstraint[]): void {
		this.constraints = constraints.slice(-this.maxConstraints).map((constraint) => ({ ...constraint }));
		const ids = this.constraints.map((constraint) => Number.parseInt(constraint.id.replace(/^c/, ""), 10));
		this.nextId = Math.max(0, ...ids.filter(Number.isFinite)) + 1;
	}

	list(): readonly DeveloperConstraint[] {
		return this.constraints;
	}

	private insert(
		text: string,
		source: DeveloperConstraint["source"],
		timestamp: number,
	): DeveloperConstraint | undefined {
		const normalized = clip(text, 240);
		const key = normalized.toLowerCase();
		if (!normalized || this.constraints.some((constraint) => constraint.text.toLowerCase() === key)) return undefined;
		const constraint: DeveloperConstraint = { id: `c${this.nextId++}`, text: normalized, source, timestamp };
		this.constraints.push(constraint);
		if (this.constraints.length > this.maxConstraints) this.constraints.shift();
		return constraint;
	}
}

// ============================================================================
// Intent: questions versus requests
// ============================================================================

/**
 * Openings of explanatory questions. Auxiliaries ("do", "is") are left out: "Do the migration"
 * is an imperative; a question with an auxiliary still ends with "?".
 */
const INTERROGATIVE_START = new RegExp(
	`^${
		wordsPattern([
			"why",
			"how",
			"what",
			"where",
			"which",
			"who",
			"when",
			"could you explain",
			"can you explain",
			"explain",
			"por que",
			"porque",
			"por quê",
			"como",
			"qual",
			"quais",
			"onde",
			"quando",
			"quem",
			"o que",
			"existe",
			"será",
			"sera",
			"explique",
			"me explique",
		]).source
	}`,
	"iu",
);

const ACTION_REQUEST = wordsPattern([
	"fix",
	"implement",
	"add",
	"change",
	"update",
	"refactor",
	"create",
	"write",
	"remove",
	"delete",
	"rename",
	"make",
	"build",
	"run",
	"apply",
	"edit",
	"move",
	"replace",
	"upgrade",
	"install",
	"migrate",
	"commit",
	"push",
	"corrija",
	"conserte",
	"corrigir",
	"implemente",
	"implementar",
	"adicione",
	"adicionar",
	"altere",
	"alterar",
	"mude",
	"mudar",
	"atualize",
	"atualizar",
	"refatore",
	"refatorar",
	"crie",
	"criar",
	"escreva",
	"escrever",
	"remova",
	"remover",
	"apague",
	"apagar",
	"renomeie",
	"renomear",
	"faça",
	"fazer",
	"aplique",
	"aplicar",
	"rode",
	"rodar",
	"execute",
	"executar",
	"edite",
	"editar",
	"mova",
	"mover",
	"substitua",
	"substituir",
	"instale",
	"instalar",
	"migre",
	"migrar",
	"commite",
	"commitar",
	"melhore",
	"melhorar",
	"improve",
]);

/** Explicit request markers that turn a question into a request: "can you fix", "pode corrigir". */
const REQUEST_MARKER = wordsPattern([
	"can you",
	"could you",
	"would you",
	"please",
	"let's",
	"lets",
	"pode",
	"poderia",
	"consegue",
	"por favor",
	"vamos",
]);

/**
 * Whether a developer message asks only a question, without requesting a change.
 *
 * "Why does the build fail?" is a question even though "build" is an action verb: an
 * explanatory opening counts as a request only with an explicit marker ("Why does it fail?
 * Please fix it."). Other questions are requests when they contain an action verb
 * ("Can you fix the test?").
 */
export function isQuestionOnly(text: string): boolean {
	const prose = developerProse(text);
	if (!prose) return false;
	const explanatory = INTERROGATIVE_START.test(prose);
	if (!explanatory && !prose.endsWith("?")) return false;
	if (explanatory && !REQUEST_MARKER.test(prose)) return true;
	return !ACTION_REQUEST.test(prose);
}

/** Whether a developer message requests a change. */
export function requestsAction(text: string): boolean {
	return ACTION_REQUEST.test(developerProse(text));
}

// ============================================================================
// Pair programming: corrections
// ============================================================================

/**
 * Collaboration rules for the system prompt. The developer brings the what and the why; the
 * agent brings the how. The how without the what produces correct code for the wrong problem.
 */
export const PAIR_PROGRAMMING_GUIDELINES: readonly string[] = [
	"The developer owns the what and the why; you own the how. If the goal or the reason behind a request is unclear, ask before building",
	"Prefer the simplest design that meets the stated requirements; propose a more complex one only by naming the requirement that needs it",
	"Treat context the developer gives about their environment, services, or domain as authoritative over your assumptions, even when it contradicts common practice",
];

/**
 * Openings of a message that pushes back on the agent's approach. Words that also open ordinary
 * sentences ("Não sei", "Para o módulo X", "No changes needed") count only when followed by
 * punctuation: "Não, ...", "Para!", "No.".
 */
const CORRECTION_START = new RegExp(
	[
		String.raw`^(?:no|nope|não|nao|para|pare|espera|wait|stop|hold on)\s*[,.!;:—]`,
		String.raw`^(?:wrong|that's wrong|not that|actually|instead|undo|revert|simplify|errado|errada|não é isso|na verdade|em vez disso|ao invés disso|desfaz|desfaça|volta|simplifica|simplifique)(?![\p{L}])`,
	].join("|"),
	"iu",
);

/** Pushback anywhere in a message: over-engineering and "this is not what I asked". */
const CORRECTION_ANYWHERE = wordsPattern([
	"too (?:complex|complicated|much)",
	"over-?engineer(?:ed|ing)?",
	"(?:that's|this is|that is) not what I",
	"complicad[oa] demais",
	"muito complicad[oa]",
	"não (?:é|era) (?:isso|o que eu)",
	"simplifica",
	"simplifique",
]);

/** Whether a developer message corrects the agent's previous approach. */
export function isCorrection(text: string): boolean {
	const prose = developerProse(text);
	return CORRECTION_START.test(prose) || CORRECTION_ANYWHERE.test(prose);
}

/** A correction the developer made, kept as a learning that may belong in the project's agent instructions. */
export interface DeveloperCorrection {
	text: string;
	timestamp: number;
}

// ============================================================================
// Authorization gate
// ============================================================================

export interface AuthorizationRequest {
	toolName: string;
	effect: ToolEffect;
	/** Stable identity of the operation, used for one-shot grants. */
	fingerprint: string;
}

/**
 * Interactive authorization, e.g. a confirmation dialog. Resolve true to allow the call once,
 * false when the developer declines, and undefined when nobody can be asked right now (no UI);
 * the call is then blocked until the developer approves in chat.
 */
export type Authorizer = (
	request: AuthorizationRequest,
	signal?: AbortSignal,
) => Promise<boolean | undefined> | boolean | undefined;

/** Basenames of the non-flag operands after the first deletion verb in a command. */
function deletionTargets(command: string): string[] {
	const match = command.match(/\b(?:rm|Remove-Item|rmdir|rd|del)\b([^\n;&|]*)/i);
	if (!match) return [];
	return match[1]
		.split(/\s+/)
		.filter((token) => token && !token.startsWith("-") && !token.startsWith("/"))
		.map((token) => token.replace(/["']/g, "").replace(/[\\/]+$/, ""))
		.map((token) => token.split(/[\\/]/).pop() ?? token)
		.filter((token) => token.length > 0 && token !== "." && token !== "*");
}

interface OperationWord {
	command: RegExp;
	request: RegExp;
	/** Operands that must also appear in the request; an operation word alone is not enough. */
	targets?: (command: string) => string[];
}

/**
 * Operation words that, when present in the developer's latest request, authorize matching
 * commands: "push the branch" authorizes `git push`; "apague o diretório dist" authorizes
 * `rm -r dist` because it names both the operation and the target, while "remove the unused
 * import" authorizes no deletion.
 */
const OPERATION_WORDS: OperationWord[] = [
	{ command: /\bgh\s+pr\s+merge\b/, request: wordsPattern(["merge", "mergear", "mescle", "mesclar"]) },
	{
		command: /\bgit\s+push\b[^\n;&|]*(?:--force|\s-f\b|\s\+\S)/,
		request: wordsPattern(["force push", "force-push", "push --force", "push -f", "forçar o push", "push forçado"]),
	},
	{
		command: /\b(?:git|docker)\s+push\b(?![^\n;&|]*(?:--force|\s-f\b|\s\+\S))/,
		request: wordsPattern(["push", "pushe", "faça push", "dê push"]),
	},
	{ command: /\bpublish\b/, request: wordsPattern(["publish", "publique", "publicar"]) },
	{ command: /\bdeploy\b|--prod\b/, request: wordsPattern(["deploy", "implante", "implantar", "ship"]) },
	{ command: /\breset\b/, request: wordsPattern(["reset", "resete", "resetar"]) },
	{ command: /\brebase\b/, request: wordsPattern(["rebase"]) },
	{
		command: /\b(?:rm|Remove-Item|rmdir|rd|del)\b/i,
		targets: deletionTargets,
		request: wordsPattern([
			"delete",
			"remove",
			"rm",
			"clean",
			"drop",
			"wipe",
			"apague",
			"apagar",
			"remova",
			"remover",
			"exclua",
			"excluir",
			"limpe",
			"limpar",
		]),
	},
	{
		command: /\bgh\s+(?:pr\s+(?!merge\b)|issue|release|repo)/,
		request: phrasePattern(
			[
				"create",
				"open",
				"close",
				"comment",
				"post",
				"crie",
				"criar",
				"abra",
				"abrir",
				"feche",
				"fechar",
				"comente",
				"comentar",
			],
			["pr", "pull request", "issue", "release", "repo"],
		),
	},
	{
		command: /\b(?:kubectl|helm|terraform|pulumi|docker)\b/,
		request: wordsPattern(["kubectl", "helm", "terraform", "pulumi", "docker", "destroy", "infra"]),
	},
	{ command: /\bcurl\b/, request: wordsPattern(["curl", "post", "put", "patch"]) },
];

const AFFIRMATIVE = new RegExp(
	`^\\s*${
		wordsPattern([
			"y",
			"yes",
			"yep",
			"yeah",
			"sure",
			"ok",
			"okay",
			"go ahead",
			"proceed",
			"do it",
			"confirm",
			"confirmed",
			"approve",
			"approved",
			"sim",
			"s",
			"pode",
			"manda",
			"vai",
			"confirmo",
			"autorizo",
			"prossiga",
			"faça",
			"faca",
			"isso",
		]).source
	}`,
	"iu",
);
const RESERVATION = wordsPattern([
	"no",
	"not",
	"don't",
	"dont",
	"never",
	"but",
	"não",
	"nao",
	"nunca",
	"mas",
	"porém",
	"porem",
	"exceto",
	"except",
]);

function fingerprint(toolName: string, effect: ToolEffect): string {
	return `${toolName}:${(effect.command ?? effect.paths.join(",")).replace(/\s+/g, " ").trim()}`;
}

export interface AlignmentPolicyOptions extends ConstraintLedgerOptions {
	/** Interactive authorization for destructive and external effects. Without it, such calls are blocked until the developer approves in chat. */
	authorize?: Authorizer;
	/** Block the first mutation in a turn where the developer only asked a question. Default: true. */
	scopeGuard?: boolean;
	/** Gate destructive and external effects. Default: true. */
	authorizationGate?: boolean;
}

export type AlignmentDecision =
	| { action: "allow"; via?: "request" | "grant" | "authorizer" }
	| { action: "block"; reason: string; kind: "authorization" | "scope" };

/** Alignment state and checks for one agent. */
export class AlignmentPolicy {
	readonly constraints: ConstraintLedger;
	private readonly authorize?: Authorizer;
	private readonly scopeGuard: boolean;
	private readonly authorizationGate: boolean;
	private latestRequest = "";
	private questionOnly = false;
	private scopeWarned = false;
	/** Operations blocked while waiting for the developer's answer. */
	private pending = new Set<string>();
	/** One-shot grants from an affirmative answer. */
	private grants = new Set<string>();
	private correctionList: DeveloperCorrection[] = [];
	/** Whether the latest developer message corrected the agent. */
	private correcting = false;
	/** Called after a correction is recorded, with every correction so far. */
	onCorrection?: (corrections: readonly DeveloperCorrection[]) => void;

	constructor(options: AlignmentPolicyOptions = {}) {
		this.constraints = new ConstraintLedger(options);
		this.authorize = options.authorize;
		this.scopeGuard = options.scopeGuard ?? true;
		this.authorizationGate = options.authorizationGate ?? true;
	}

	/**
	 * Observe a developer message: record constraints, intent, corrections, and answers to pending
	 * authorizations. `afterAgentWork` says whether the agent has already responded in this
	 * conversation; only then can a message correct it.
	 */
	observeDeveloperMessage(text: string, timestamp = Date.now(), afterAgentWork = true): void {
		this.constraints.observeDeveloperText(text, timestamp);
		this.latestRequest = developerProse(text);
		this.questionOnly = isQuestionOnly(text);
		this.scopeWarned = false;
		this.correcting = afterAgentWork && isCorrection(text);
		if (this.correcting) {
			this.correctionList.push({ text: clip(this.latestRequest, 240), timestamp });
			if (this.correctionList.length > 12) this.correctionList.shift();
			this.onCorrection?.(this.correctionList);
		}
		if (this.pending.size > 0 && AFFIRMATIVE.test(text) && !RESERVATION.test(text)) {
			for (const operation of this.pending) this.grants.add(operation);
		}
		this.pending.clear();
	}

	/** Operations currently waiting for the developer's approval. */
	pendingAuthorizations(): string[] {
		return [...this.pending];
	}

	/** Corrections the developer made in this conversation, oldest first. */
	corrections(): readonly DeveloperCorrection[] {
		return this.correctionList;
	}

	/** Replace the corrections with persisted ones, without notifying `onCorrection`. */
	restoreCorrections(corrections: readonly DeveloperCorrection[]): void {
		this.correctionList = corrections.slice(-12).map((correction) => ({ ...correction }));
	}

	/** Reminder for the request that follows a correction, or undefined otherwise. */
	renderCorrection(): string | undefined {
		if (!this.correcting) return undefined;
		return "The developer's latest message corrects your previous approach. Adopt the correction as stated, prefer the simplest design that satisfies it, and do not reintroduce what they rejected.";
	}

	/** Decide whether a tool call may run. */
	async check(toolName: string, effect: ToolEffect, signal?: AbortSignal): Promise<AlignmentDecision> {
		if (this.authorizationGate && requiresAuthorization(effect.kind)) {
			return this.checkAuthorization(toolName, effect, signal);
		}
		if (this.scopeGuard && this.questionOnly && !this.scopeWarned && effect.kind === "write") {
			this.scopeWarned = true;
			return {
				action: "block",
				kind: "scope",
				reason:
					"Blocked by the harness alignment policy: the developer asked a question and did not request changes. " +
					"Answer the question first, propose the change, and wait for approval. " +
					"If you are certain the developer's message requests this change, you may retry the call.",
			};
		}
		return { action: "allow" };
	}

	/** Convert a decision into the agent loop's hook result. */
	static toHookResult(decision: AlignmentDecision): BeforeToolCallResult | undefined {
		return decision.action === "block" ? { block: true, reason: decision.reason } : undefined;
	}

	/** Reminder text restating the active constraints, or undefined when there are none. */
	renderConstraints(): string | undefined {
		const constraints = this.constraints.list();
		if (constraints.length === 0) return undefined;
		return [
			"Developer constraints in force (stated earlier; they still apply):",
			...constraints.map((constraint) => `- ${constraint.text}`),
		].join("\n");
	}

	private async checkAuthorization(
		toolName: string,
		effect: ToolEffect,
		signal?: AbortSignal,
	): Promise<AlignmentDecision> {
		const operation = fingerprint(toolName, effect);
		if (this.grants.delete(operation)) return { action: "allow", via: "grant" };

		const command = effect.command ?? "";
		// Only affirmative clauses authorize: "não faça push ainda" names the operation to forbid it.
		const request = this.latestRequest
			.toLowerCase()
			.split(/[.,;!?\n]|(?<![\p{L}])(?:but|mas|porém|porem)(?![\p{L}])/u)
			.filter((clause) => !RESERVATION.test(clause))
			.join(" . ");
		const named = OPERATION_WORDS.some((word) => {
			if (!word.command.test(command) || !word.request.test(request)) return false;
			const targets = word.targets?.(command);
			return (
				targets === undefined ||
				(targets.length > 0 && targets.some((target) => request.includes(target.toLowerCase())))
			);
		});
		if (named) return { action: "allow", via: "request" };

		const approved = await this.authorize?.({ toolName, effect, fingerprint: operation }, signal);
		if (approved === true) return { action: "allow", via: "authorizer" };
		if (approved === false) {
			return {
				action: "block",
				kind: "authorization",
				reason: `Blocked: the developer declined this ${effect.kind} operation (${effect.reason ?? "unspecified effect"}). Do not retry it; continue without it or ask how to proceed.`,
			};
		}

		this.pending.add(operation);
		return {
			action: "block",
			kind: "authorization",
			reason:
				`Blocked by the harness alignment policy: \`${clip(command || toolName, 160)}\` is a ${effect.kind} operation ` +
				`(${effect.reason ?? "unspecified effect"}) and the developer has not authorized it. ` +
				"Explain what it would do and ask the developer to confirm. If they confirm, retry the same call unchanged.",
		};
	}
}
