import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@relay-harness/agent-core";
import type { TaskAssessment } from "./assessment.ts";
import { type EscalationReason, PerformanceHistory, type PolicyProfile } from "./policy.ts";
import type { CapabilityTier, TaskScope, TaskType } from "./questions.ts";

/** One routed request and its outcome, as written to `telemetry.jsonl`. */
export interface ToolRetrievalTelemetryRecord {
	timestamp: string;
	candidateCount: number;
	retrievedCount: number;
	invokedCount: number;
	invokedRetrievedCount: number;
}

export interface TelemetryRecord {
	task_id: string;
	timestamp: string;
	/** The user's request, truncated. Kept locally to export training exercises. */
	request: string;
	classification: {
		source: TaskAssessment["source"];
		type: TaskType;
		complexity: number;
		risk: number;
		ambiguity: number;
		reasoning: number;
		scope: TaskScope;
		agent: string;
		validation: string;
		confidence: number;
		recommended_tier: CapabilityTier;
		recommended_effort: string;
	};
	policy: { profile: PolicyProfile; required_tier: CapabilityTier; rules: string[] };
	selected: { provider: string; model: string; tier: CapabilityTier; thinking_level: string };
	result: {
		success: boolean;
		outcome: "completed" | "error" | "aborted";
		attempts: number;
		escalations: Array<{ reason: EscalationReason; from: CapabilityTier; to: CapabilityTier }>;
		tests_passed: boolean | null;
		tool_failures: number;
	};
	usage: { tokens: number; cost: number; duration_ms: number; models: string[] };
}

const MAX_REQUEST_CHARS = 2000;
const TEST_COMMAND =
	/\b(test|tests|vitest|jest|mocha|pytest|go test|cargo test|mvn|gradle|tsc|check|lint|build)\b|test\.sh/;

/** Reads `[laya:*]` and `[harness:*]` messages as harness text, not as the user's words. */
export const HARNESS_MESSAGE = /^\[(laya|harness):[a-z-]+\]/;

/** Outcome of the latest check (test, type check, build, lint) run through bash, or null when none ran. */
export function lastCheckPassed(messages: readonly AgentMessage[]): boolean | null {
	const commands = new Map<string, string>();
	let passed: boolean | null = null;
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall" && typeof block.arguments.command === "string") {
					commands.set(block.id, block.arguments.command);
				}
			}
		} else if (message.role === "toolResult" && message.toolName === "bash") {
			const command = commands.get(message.toolCallId);
			if (command && TEST_COMMAND.test(command)) passed = !message.isError;
		}
	}
	return passed;
}

/** Outcome, usage and checks of one agent run. */
export function summarizeRun(messages: readonly AgentMessage[]): {
	outcome: TelemetryRecord["result"]["outcome"];
	testsPassed: boolean | null;
	toolFailures: number;
	tokens: number;
	cost: number;
	models: string[];
} {
	let tokens = 0;
	let cost = 0;
	let toolFailures = 0;
	const models = new Set<string>();
	let outcome: TelemetryRecord["result"]["outcome"] = "completed";
	for (const message of messages) {
		if (message.role === "assistant") {
			tokens += message.usage?.totalTokens ?? 0;
			cost += message.usage?.cost.total ?? 0;
			models.add(`${message.provider}/${message.model}`);
			outcome =
				message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "completed";
		} else if (message.role === "toolResult" && message.isError) {
			toolFailures++;
		}
	}
	return { outcome, testsPassed: lastCheckPassed(messages), toolFailures, tokens, cost, models: [...models] };
}

export function truncateRequest(request: string): string {
	return request.length > MAX_REQUEST_CHARS ? `${request.slice(0, MAX_REQUEST_CHARS)}…` : request;
}

/** Append-only JSONL store. Unreadable lines are skipped. */
export class TelemetryStore {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	append(record: TelemetryRecord): void {
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
	}

	/** Append prompt-free retrieval metrics to a separate local JSONL file. */
	appendToolRetrieval(record: ToolRetrievalTelemetryRecord): void {
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(join(dirname(this.path), "tool-retrieval.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
	}

	/** The newest `limit` records, oldest first. */
	read(limit = 5000): TelemetryRecord[] {
		if (!existsSync(this.path)) return [];
		const records: TelemetryRecord[] = [];
		for (const line of readFileSync(this.path, "utf8").split("\n").slice(-limit)) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line) as TelemetryRecord);
			} catch {
				// A partially written line from a crashed process.
			}
		}
		return records;
	}
}

export function historyKey(record: Pick<TelemetryRecord, "classification">): string {
	return `${record.classification.type}:${Math.round(record.classification.complexity * 4)}`;
}

/** Aborted runs say nothing about the model, so they are not counted. */
export function historyFromTelemetry(records: readonly TelemetryRecord[]): PerformanceHistory {
	const history = new PerformanceHistory();
	for (const record of records) {
		if (record.result.outcome === "aborted") continue;
		history.record(historyKey(record), `${record.selected.provider}/${record.selected.model}`, record.result.success);
	}
	return history;
}

/**
 * Training exercises with evidence-based tier labels: for each successful run, the tier that
 * finished it. Only `capability_tier` is labeled; the other answers came from Laya itself and would
 * teach it nothing new. Review the rows before adding them (`/laya-data`).
 */
export function datasetFromTelemetry(records: readonly TelemetryRecord[]): Array<{
	state: { request: string };
	expected: { capability_tier: CapabilityTier };
	source: "harness";
}> {
	return records
		.filter((record) => record.result.success && record.request.trim())
		.map((record) => ({
			state: { request: record.request },
			expected: { capability_tier: record.selected.tier },
			source: "harness",
		}));
}
