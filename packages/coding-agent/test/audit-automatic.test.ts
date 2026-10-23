import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@relay-harness/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AUTOMATIC_EXCLUDES, automaticConfig, automaticOutputRoot, isWithin } from "../src/core/audit/config.ts";
import { DOMAINS } from "../src/core/audit/contracts.ts";
import { createSnapshot } from "../src/core/audit/snapshot.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import auditExtension from "../src/extensions/audit/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type Handler = (text: string, ctx: ExtensionCommandContext) => Promise<void>;
const roots: string[] = [];
const harnesses: Harness[] = [];
function temp(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}
function fixture(): string {
	const target = temp("relay-audit-auto-target-");
	writeFileSync(join(target, "app.ts"), "// fixture\nexport const unprotectedRoute = true;\n");
	return target;
}
function commands(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	auditExtension({
		registerCommand: (name: string, options: { handler: Handler }) => handlers.set(name, options.handler),
		registerTool: vi.fn(),
		on: vi.fn(),
	} as unknown as ExtensionAPI);
	return handlers;
}
function context(cwd: string, h: Harness | undefined, confirm: boolean) {
	const notes: { text: string; type?: string }[] = [];
	let settle: () => void = () => {};
	const finished = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const ctx = {
		cwd,
		model: h?.getModel(),
		modelRegistry: { modelRuntime: h?.session.modelRuntime },
		hasUI: true,
		ui: {
			confirm: vi.fn(async (_title: string, _message: string) => confirm),
			notify: (text: string, type?: string) => {
				notes.push({ text, type });
				if (/^Audit (audit-\S+: |failed)/.test(text)) settle();
			},
		},
	};
	return { ctx: ctx as unknown as ExtensionCommandContext, notes, finished, confirm: ctx.ui.confirm };
}
/** Scripted model: opens app.ts once, then answers the phase-specific JSON contract from the prompt. */
function scriptedModel(context: { messages: { role: string; content: unknown }[] }) {
	const prompt = context.messages.find((m) => m.role === "user")!;
	const text =
		typeof prompt.content === "string"
			? prompt.content
			: (prompt.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
	if (context.messages.at(-1)!.role === "user")
		return fauxAssistantMessage(fauxToolCall("audit_read", { path: "app.ts" }), { stopReason: "toolUse" });
	const run = JSON.parse(text.split("\n").find((line) => line.startsWith('{"run_id"')) ?? "{}");
	let answer: unknown;
	if (text.includes("Candidate (untrusted): ")) {
		const finding = JSON.parse(text.split("Candidate (untrusted): ")[1].split("\n")[0]);
		answer = {
			version: 1,
			finding_id: finding.id,
			status: "CONFIRMADO",
			validation: {
				reviewer_id: /independent reviewer (review-[a-f0-9]+)/.exec(text)![1],
				reviewed_at: new Date().toISOString(),
				independent_review: true,
				checked_evidence_refs: finding.evidence.map((e: { id: string }) => e.id),
				decision_reason: "Reread the route; no ownership guard is present",
			},
		};
	} else if (text.includes("Render a concise executive narrative"))
		answer = { version: 1, summary: "Automatic static audit of the fixture.", limitations: [] };
	else if (text.includes("\nTask: ")) {
		const task = JSON.parse(text.split("\nTask: ")[1].split("\n")[0]);
		const entries = run.inventory as { path: string; status: string; sha256?: string }[];
		answer = {
			run_id: run.run_id,
			task_id: task.task_id,
			scope_id: task.scope_id,
			repository_revision: run.repository_revision,
			specialist_id: task.agent,
			coverage: {
				discovered: entries.length,
				examined: entries.length,
				not_verified: 0,
				not_applicable: 0,
				assets: entries.map((e, i) => ({
					id: `${task.task_id}/a${i}`,
					kind: "file",
					locator: e.path,
					status: "EXAMINADO",
				})),
			},
			candidates:
				task.domain === "03"
					? [
							{
								id: `${task.task_id}/BOLA`,
								run_id: run.run_id,
								repository_revision: run.repository_revision,
								origin_specialist: task.agent,
								domain: "03",
								title: "Missing object authorization",
								status: "POTENCIAL",
								severity: "ALTA",
								priority: "P1",
								confidence: "MEDIA",
								description: "Route is exported without an ownership check",
								exploit_conditions: "Authenticated attacker knows another object's id",
								impact: "Unauthorized read",
								evidence: [
									{
										id: `${task.task_id}/evidence`,
										source_kind: "repository_code",
										locator: "app.ts:2",
										path: "app.ts",
										line_start: 2,
										line_end: 2,
										file_sha256: entries.find((e) => e.path === "app.ts")!.sha256,
										method: "snapshot read",
										summary: "Unprotected route",
									},
								],
								remediation: "Enforce ownership",
								acceptance_criteria: ["Cross-owner request denied"],
							},
						]
					: [],
			strengths: [],
			limitations: [],
			handoff_refs: [],
		};
	} else if (text.includes("threat model"))
		answer = {
			version: 1,
			assets: [{ name: "route", description: "Exported route", paths: ["app.ts"] }],
			entry_points: [],
			trust_boundaries: [],
			threats: [],
			limitations: [],
		};
	else
		answer = {
			version: 1,
			domains: DOMAINS.map((domain) => ({
				domain,
				applicable: "yes",
				reason: "Fixture source is in scope",
				evidence_paths: ["app.ts"],
			})),
			limitations: [],
		};
	return fauxAssistantMessage(JSON.stringify(answer));
}
afterEach(() => {
	vi.unstubAllEnvs();
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("automatic audit configuration", () => {
	it("derives a preflight-valid config from the working directory and selected model", async () => {
		const target = fixture();
		mkdirSync(join(target, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(target, "node_modules", "dep", "index.js"), "module.exports = 'dependency-source';\n");
		const base = join(temp("relay-audit-auto-base-"), "audits");
		const config = await automaticConfig(target, { provider: "p", id: "m" }, base);
		expect(config.model).toEqual({ authorized: true, provider: "p", id: "m" });
		expect(config.scope.output_root).toBe(automaticOutputRoot(target, base));
		expect(isWithin(base, config.scope.output_root)).toBe(true);
		expect(isWithin(config.project.repository_path, config.scope.output_root)).toBe(false);
		expect(config.scope.exclude).toEqual(AUTOMATIC_EXCLUDES);
		expect(config.snapshot.git_revision).toBe(false);
		const snapshot = await createSnapshot(config);
		expect(snapshot.entries.find((e) => e.path === "node_modules")?.status).toBe("excluded");
		expect(Object.keys(snapshot.files)).toEqual(["app.ts"]);
	});

	it("registers the commands by default and only RELAY_AUDIT_ENABLED=0 opts out", () => {
		vi.stubEnv("RELAY_AUDIT_ENABLED", undefined);
		expect([...commands().keys()]).toEqual(["audit-app", "audit-app-resume", "audit-app-status", "audit-app-cancel"]);
		vi.stubEnv("RELAY_AUDIT_ENABLED", "0");
		expect(commands().size).toBe(0);
	});

	it("reads nothing and writes nothing when the user declines model egress", async () => {
		const agentDir = temp("relay-audit-auto-agent-");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const h = await createHarness();
		harnesses.push(h);
		const target = fixture();
		const { ctx, notes, confirm } = context(target, h, false);
		await commands().get("audit-app")!("", ctx);
		expect(confirm).toHaveBeenCalledOnce();
		expect(notes.map((n) => n.text)).toEqual(["Audit not started; no repository content was read or sent."]);
		expect(existsSync(join(agentDir, "audits"))).toBe(false);
		expect(h.faux.state.callCount).toBe(0);
	});

	it("rejects /audit-app without a selected model", async () => {
		const { ctx, notes } = context(fixture(), undefined, true);
		await commands().get("audit-app")!("", ctx);
		expect(notes[0]).toEqual({ text: expect.stringContaining("Select a model"), type: "error" });
	});

	it("runs the full audit from /audit-app with no arguments and writes the report outside the target", async () => {
		const agentDir = temp("relay-audit-auto-agent-");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const h = await createHarness();
		harnesses.push(h);
		h.setResponses(Array.from({ length: 200 }, () => scriptedModel));
		const target = fixture();
		const before = readdirSync(target);
		const handlers = commands();
		const { ctx, notes, finished, confirm } = context(target, h, true);

		await handlers.get("audit-app")!("", ctx);
		await finished;

		const model = h.getModel();
		expect(confirm.mock.calls[0][1]).toContain(`${model.provider}/${model.id}`);
		expect(notes[0].text).toMatch(/^Static audit started for /);
		const done = notes.at(-1)!;
		expect(done.type).toBe("info");
		const match = /^Audit (audit-[a-f0-9-]{36}): COMPLETED\. Report: (.+)$/.exec(done.text);
		expect(match, done.text).not.toBeNull();
		const report = match![2];
		expect(isWithin(join(agentDir, "audits"), report)).toBe(true);
		const markdown = readFileSync(report, "utf8");
		expect(markdown).toContain("Missing object authorization");
		expect(JSON.parse(readFileSync(join(report, "..", "report.json"), "utf8")).status).toBe("COMPLETED");
		expect(readdirSync(target)).toEqual(before);

		const status = context(target, h, true);
		await handlers.get("audit-app-status")!(match![1], status.ctx);
		expect(JSON.parse(status.notes[0].text)).toMatchObject({ run_id: match![1], status: "COMPLETED" });
	}, 120_000);
});
