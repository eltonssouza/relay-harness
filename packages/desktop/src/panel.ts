/**
 * The right-hand panel: the harness state from `get_harness_state` (constraints the developer can
 * forget, the evidence of the last completion, approvals and context savings) and the subagents
 * the `agent` tool is running.
 */

import { chip, element, toolSummary } from "./render.ts";

export interface HarnessSnapshot {
	engine: string;
	pillars: { alignment: boolean; evidence: boolean; context: boolean };
	constraints: Array<{ id: string; text: string }>;
	corrections: Array<{ text: string }>;
	pendingAuthorizations: string[];
	blockedCalls: Array<{ toolName: string; reason: string }>;
	latestReport?: { status: string; detail?: string; verifications: Array<{ command: string; passed: boolean }> };
	pendingChanges?: string[];
	contextStats?: { elidedResults: number; elidedChars: number; batches: number };
	verifyCommands: string[];
}

const STATUS_TONES: Record<string, "ok" | "warn" | "bad" | "plain"> = {
	verified: "ok",
	unverified: "warn",
	question: "warn",
	contradicted: "bad",
	"no-effect": "bad",
};

function section(title: string, ...content: Node[]): HTMLElement {
	const node = element("section", "panel-section");
	node.append(element("h3", undefined, title), ...content);
	return node;
}

function card(...rows: Node[]): HTMLElement {
	const node = element("div", "card");
	node.append(...rows);
	return node;
}

function stat(label: string, value: string): HTMLElement {
	const row = element("div", "stat");
	row.append(element("span", undefined, label), element("b", undefined, value));
	return row;
}

export class HarnessPanel {
	readonly element: HTMLElement;
	private readonly harness: HTMLElement;
	private readonly agents: HTMLElement;
	private readonly agentRows = new Map<string, { row: HTMLElement; status: HTMLElement; detail: HTMLElement }>();
	private readonly onForget: (id: string) => void;

	constructor(onForget: (id: string) => void, onSettings: () => void) {
		this.onForget = onForget;
		this.element = element("aside", "panel");
		this.element.setAttribute("aria-label", "Harness");
		this.harness = element("div", "panel-harness");
		this.agents = element("div", "agent-list");
		const settings = element("button", "btn", "Harness settings");
		settings.type = "button";
		settings.addEventListener("click", onSettings);
		this.element.append(settings, this.harness, section("Agents", this.agents));
		this.renderAgentsEmpty();
	}

	render(snapshot: HarnessSnapshot): void {
		const sections: HTMLElement[] = [];
		if (snapshot.pillars.alignment) {
			const constraints = card(
				...(snapshot.constraints.length === 0
					? [element("div", "muted", "No constraints recorded.")]
					: snapshot.constraints.map((constraint) => {
							const row = element("div", "constraint");
							const forget = element("button", "forget", "✕");
							forget.type = "button";
							forget.title = `Forget ${constraint.id}`;
							forget.setAttribute("aria-label", `Forget constraint ${constraint.id}`);
							forget.addEventListener("click", () => this.onForget(constraint.id));
							row.append(
								element("span", "id mono", constraint.id),
								element("span", "text", constraint.text),
								forget,
							);
							return row;
						})),
			);
			sections.push(section("Constraints", constraints));
			const blocked = snapshot.blockedCalls.slice(-3);
			sections.push(
				section(
					"Approvals",
					card(
						stat(
							"Waiting for you",
							snapshot.pendingAuthorizations.length === 0
								? "none"
								: String(snapshot.pendingAuthorizations.length),
						),
						...snapshot.pendingAuthorizations.map((operation) => element("div", "mono muted", operation)),
						stat("Blocked this session", String(snapshot.blockedCalls.length)),
						...blocked.map((call) => element("div", "muted", `${call.toolName}: ${call.reason.split(". ")[0]}`)),
					),
				),
			);
		}
		if (snapshot.pillars.evidence) {
			const report = snapshot.latestReport;
			const heading = element("h3", undefined, "Evidence ");
			if (report) heading.append(chip(report.status, STATUS_TONES[report.status] ?? "plain"));
			const evidence = element("section", "panel-section");
			const pending = snapshot.pendingChanges ?? [];
			const last = report?.verifications.at(-1);
			evidence.append(
				heading,
				card(
					...(report?.detail ? [element("div", "muted", report.detail)] : []),
					stat("Changed since the last check", pending.length === 1 ? "1 file" : `${pending.length} files`),
					...pending.slice(0, 8).map((path) => element("div", "mono muted", path)),
					...(last ? [stat("Last check", `${last.command} ${last.passed ? "passed" : "failed"}`)] : []),
					stat(
						"Checks that count",
						snapshot.verifyCommands.length > 0
							? snapshot.verifyCommands.join(", ")
							: "test, build and lint commands",
					),
				),
			);
			sections.push(evidence);
		}
		if (snapshot.pillars.context && snapshot.contextStats) {
			const stats = snapshot.contextStats;
			sections.push(
				section(
					"Context",
					card(
						stat("Results elided", `${stats.elidedResults} in ${stats.batches} batches`),
						stat("Characters kept out", stats.elidedChars.toLocaleString()),
					),
				),
			);
		}
		const engine = element("div", "engine muted", `Harness engine: ${snapshot.engine}`);
		this.harness.replaceChildren(...sections, engine);
	}

	/** A subagent started: one row under Agents with its type and task. */
	agentStarted(toolCallId: string, args: Record<string, unknown> | undefined): void {
		if (this.agentRows.size === 0) this.agents.replaceChildren();
		const row = element("div", "agent-row");
		const status = chip("running", "accent");
		const detail = element(
			"div",
			"muted",
			typeof args?.description === "string" ? args.description : toolSummary(args),
		);
		const name = element("div", "title", typeof args?.subagent_type === "string" ? args.subagent_type : "agent");
		const text = element("div");
		text.append(name, detail);
		row.append(text, status);
		this.agents.prepend(row);
		this.agentRows.set(toolCallId, { row, status, detail });
	}

	/** The subagent's latest progress line. */
	agentProgress(toolCallId: string, line: string): void {
		const entry = this.agentRows.get(toolCallId);
		if (entry && line) entry.detail.textContent = line;
	}

	agentFinished(toolCallId: string, isError: boolean): void {
		const entry = this.agentRows.get(toolCallId);
		if (!entry) return;
		entry.status.className = `chip ${isError ? "bad" : "ok"}`;
		entry.status.textContent = isError ? "stopped" : "completed";
	}

	private renderAgentsEmpty(): void {
		this.agents.replaceChildren(element("div", "muted", "No subagents in this session."));
	}
}
