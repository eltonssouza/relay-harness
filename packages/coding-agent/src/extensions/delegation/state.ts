import type { WorkerIdentity } from "../../core/delegation/contracts.ts";
import type { DelegationState } from "../../core/delegation/store.ts";
import type { WorkspaceBaseline } from "../../core/delegation/workspace.ts";

export const WORK_STATE_ENTRY = "relay.work.state";

export interface WorkEvidence {
	id: string;
	tool: string;
	command?: string;
	isError: boolean;
	text: string;
	revision: number;
	observedAt?: number;
	delegation?: WorkerIdentity;
	contentRef?: string;
}

export interface WorkState {
	version: 1;
	id: string;
	goal: string;
	status: "active" | "handoff" | "completed" | "stopped";
	revision: number;
	evidence: WorkEvidence[];
	workspace?: WorkspaceBaseline;
	delegation?: DelegationState;
	decisionError?: string;
	continuations: number;
}
