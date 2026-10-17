import { describe, expect, it } from "vitest";
import {
	type ApprovedWorkPlan,
	validateApprovedWorkPlan,
	validateWorkProposal,
	type WorkProposal,
	type WorkResourceCatalog,
	workerRunKey,
} from "../src/core/delegation/contracts.ts";
import {
	DEFAULT_DELEGATION_LIMITS,
	DELEGATION_LIMIT_CAPS,
	resolveDelegationLimits,
} from "../src/core/delegation/limits.ts";
import { delegationCheckpoint } from "../src/extensions/delegation/checkpoint.ts";

const catalog: WorkResourceCatalog = {
	checkpoint: delegationCheckpoint(),
	profiles: { engineer: { tools: ["read", "edit"] }, reviewer: { tools: ["read"] } },
	tools: ["read", "edit", "bash"],
	skills: ["review", "tdd"],
	descriptions: {
		tools: { read: "Read files", edit: "Edit files", bash: "Execute shell commands" },
		skills: { review: "Review implementation", tdd: "Implement with test-driven development" },
	},
	allowedTools: ["read", "edit"],
	allowedSkills: ["review"],
};

function proposal(): WorkProposal {
	return {
		workflowId: "workflow-1",

		version: 1,
		workspaceRevision: 2,
		tasks: [
			{
				taskId: "api",
				objective: "Locate the API login failure",
				acceptanceCriteria: ["Identify the failing request"],
				proposedProfile: "engineer",
				dependencies: [],
				inputs: ["Login returns 500"],
				expectedOutput: "Root cause and relevant files",
				resourceScope: ["src/api"],
				accessMode: "investigation",
				limits: { durationMs: 1000, steps: 5, outputBytes: 1000 },
			},
		],
	};
}

function plan(): ApprovedWorkPlan {
	return {
		proposal: proposal(),
		decisionId: "decision-1",
		model: "relay-laya-v4",
		checkpoint: delegationCheckpoint(),
		maxConcurrent: 3,
		limits: { ...DEFAULT_DELEGATION_LIMITS },
		selections: [
			{ taskId: "api", profile: "reviewer", tools: ["read"], skills: ["review"], executionMode: "parallel" },
		],
	};
}

describe("delegation contracts", () => {
	it("rejects an approval without its checkpoint or with changed configuration", () => {
		const approved = plan();
		const legacy = { ...approved };
		Reflect.deleteProperty(legacy, "checkpoint");
		expect(() => validateApprovedWorkPlan(legacy, catalog)).toThrow("checkpoint changed or is missing");
		approved.checkpoint.artifactSha256 = "0".repeat(64);
		expect(() => validateApprovedWorkPlan(approved, catalog)).toThrow("checkpoint changed or is missing");
		const changed = { ...catalog, checkpoint: { ...catalog.checkpoint, sha256: "0".repeat(64) } };
		expect(() => validateApprovedWorkPlan(plan(), changed)).toThrow("checkpoint changed or is missing");
	});
	it("resolves configurable budgets without retaining caller data or changing defaults", () => {
		const input = {
			maxConcurrent: 4,
			maxTasks: 9,
			maxAttempts: 3,
			maxDurationMs: 600_000,
			maxSteps: 80,
			maxOutputBytes: 128_000,
		};
		const limits = resolveDelegationLimits(input);
		input.maxAttempts = 9;
		expect(limits.maxAttempts).toBe(3);
		expect(resolveDelegationLimits()).toEqual(DEFAULT_DELEGATION_LIMITS);
		const p = plan();
		p.limits = limits;
		p.maxConcurrent = 4;
		p.proposal.tasks = Array.from({ length: 9 }, (_, index) => ({
			...structuredClone(p.proposal.tasks[0]),
			taskId: `unit-${index}`,
			limits: { durationMs: 600_000, steps: 80, outputBytes: 128_000 },
		}));
		p.selections[0].taskId = "unit-0";
		expect(() => validateApprovedWorkPlan(p, { ...catalog, limits })).not.toThrow();
		expect(() => validateApprovedWorkPlan(p, catalog)).toThrow("limits changed");
		expect(() => validateWorkProposal(p.proposal, catalog)).toThrow("maxTasks");
	});
	it.each([
		null,
		[],
		"3",
		{ maxAttempts: 0 },
		{ maxSteps: 1.5 },
		{ maxTasks: Number.MAX_SAFE_INTEGER },
		{ maxConcurrent: 9 },
		{ maxAttempts: "3" },
		{ maxOutputBytes: Infinity },
		{ extra: 1 },
	])("rejects invalid delegation settings %j", (value) => {
		expect(() => resolveDelegationLimits(value)).toThrow("Invalid delegation");
	});
	it.each(Object.keys(DELEGATION_LIMIT_CAPS) as Array<keyof typeof DELEGATION_LIMIT_CAPS>)(
		"rejects %s above its schema ceiling",
		(key) => {
			expect(() => resolveDelegationLimits({ [key]: DELEGATION_LIMIT_CAPS[key] + 1 })).toThrow(`delegation.${key}`);
		},
	);
	it("enforces smaller configured task budgets and does not accept old plans without budgets", () => {
		const p = plan();
		for (const limits of [{ maxSteps: 4 }, { maxDurationMs: 999 }, { maxOutputBytes: 999 }])
			expect(() => validateWorkProposal(p.proposal, { ...catalog, limits })).toThrow("configured delegation limits");
		expect(() =>
			validateApprovedWorkPlan({ ...p, limits: undefined } as unknown as ApprovedWorkPlan, catalog),
		).toThrow("missing its configured limits");
	});
	it("validates without mutating or retaining the coordinator's input", () => {
		const original = proposal();
		const validated = validateWorkProposal(original, catalog);
		original.tasks[0].objective = "Changed";
		expect(validated.tasks[0].objective).toBe("Locate the API login failure");
		expect(() => validateApprovedWorkPlan(plan(), catalog)).not.toThrow();
	});
	it.each([
		[
			"empty criteria",
			(p: WorkProposal) => {
				p.tasks[0].acceptanceCriteria = [];
			},
		],
		[
			"blank objective",
			(p: WorkProposal) => {
				p.tasks[0].objective = "  ";
			},
		],
		[
			"missing scope",
			(p: WorkProposal) => {
				p.tasks[0].resourceScope = [];
			},
		],
		[
			"invalid profile",
			(p: WorkProposal) => {
				p.tasks[0].proposedProfile = "unavailable";
			},
		],
		[
			"invalid limit",
			(p: WorkProposal) => {
				p.tasks[0].limits.steps = 0;
			},
		],
		[
			"unbounded duration",
			(p: WorkProposal) => {
				p.tasks[0].limits.durationMs = Infinity;
			},
		],
		[
			"duplicate ID",
			(p: WorkProposal) => {
				p.tasks.push(structuredClone(p.tasks[0]));
			},
		],
		[
			"missing dependency",
			(p: WorkProposal) => {
				p.tasks[0].dependencies = ["missing"];
			},
		],
		[
			"self dependency",
			(p: WorkProposal) => {
				p.tasks[0].dependencies = ["api"];
			},
		],
		[
			"too many tasks",
			(p: WorkProposal) => {
				p.tasks = Array.from({ length: 9 }, (_, n) => ({ ...p.tasks[0], taskId: `task-${n}` }));
			},
		],
	] as const)("rejects %s", (_name, change) => {
		const p = proposal();
		change(p);
		expect(() => validateWorkProposal(p, catalog)).toThrow();
	});
	it("rejects cycles across tasks but accepts a dependency chain", () => {
		const p = proposal();
		p.tasks.push({ ...structuredClone(p.tasks[0]), taskId: "ui", dependencies: ["api"] });
		expect(() => validateWorkProposal(p, catalog)).not.toThrow();
		p.tasks[0].dependencies = ["ui"];
		expect(() => validateWorkProposal(p, catalog)).toThrow("Dependency cycle");
	});
	it.each([
		[
			"missing decision",
			(p: ApprovedWorkPlan) => {
				p.decisionId = "";
			},
		],
		[
			"unknown task",
			(p: ApprovedWorkPlan) => {
				p.selections[0].taskId = "unknown";
			},
		],
		[
			"duplicate selection",
			(p: ApprovedWorkPlan) => {
				p.selections.push(structuredClone(p.selections[0]));
			},
		],
		[
			"profile restriction",
			(p: ApprovedWorkPlan) => {
				p.selections[0].tools = ["edit"];
			},
		],
		[
			"session restriction",
			(p: ApprovedWorkPlan) => {
				p.selections[0].profile = "engineer";
				p.selections[0].tools = ["bash"];
			},
		],
		[
			"unknown tool",
			(p: ApprovedWorkPlan) => {
				p.selections[0].tools = ["unknown"];
			},
		],
		[
			"unknown skill",
			(p: ApprovedWorkPlan) => {
				p.selections[0].skills = ["unknown"];
			},
		],
		[
			"session skill restriction",
			(p: ApprovedWorkPlan) => {
				p.selections[0].skills = ["tdd"];
			},
		],
		[
			"parallel mutation",
			(p: ApprovedWorkPlan) => {
				p.proposal.tasks[0].accessMode = "mutation";
			},
		],
		[
			"parallel validation",
			(p: ApprovedWorkPlan) => {
				p.proposal.tasks[0].accessMode = "validation";
			},
		],
		[
			"invalid concurrency",
			(p: ApprovedWorkPlan) => {
				p.maxConcurrent = 0;
			},
		],
	] as const)("rejects approved plan with %s", (_name, change) => {
		const p = plan();
		change(p);
		expect(() => validateApprovedWorkPlan(p, catalog)).toThrow();
	});
	it("requires selected dependencies, allowing Laya to omit independent tasks", () => {
		const p = plan();
		p.proposal.tasks.push({ ...structuredClone(p.proposal.tasks[0]), taskId: "ui" });
		expect(() => validateApprovedWorkPlan(p, catalog)).not.toThrow();
		p.proposal.tasks[0].dependencies = ["ui"];
		expect(() => validateApprovedWorkPlan(p, catalog)).toThrow("unselected dependency");
	});
	it("does not treat structurally valid proposals as approved plans", () => {
		expect(() =>
			validateApprovedWorkPlan({ ...plan(), decisionId: undefined } as unknown as ApprovedWorkPlan, catalog),
		).toThrow();
	});
	it("uses stable, plan- and attempt-specific execution keys", () => {
		const identity = { workflowId: "w", planVersion: 1, taskId: "api", attempt: 1 };
		expect(workerRunKey(identity)).toBe(workerRunKey({ ...identity }));
		expect(workerRunKey(identity)).not.toBe(workerRunKey({ ...identity, attempt: 2 }));
	});
});
