import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AuditConfig, preflight } from "../src/core/audit/config.ts";
import { type AgentResult, DOMAINS, type Finding, loadResources } from "../src/core/audit/contracts.ts";
import { cancelAudit, readAuditStatus, runAudit } from "../src/core/audit/coordinator.ts";
import { writeReports } from "../src/core/audit/report.ts";
import type { AuditWorker, WorkerInput } from "../src/core/audit/runtime.ts";
import { createSnapshot } from "../src/core/audit/snapshot.ts";
import { AuditStore } from "../src/core/audit/store.ts";

const roots: string[] = [];
function fixture(content = "// fixture\nexport const protectedRoute = true;\n") {
	const root = mkdtempSync(join(tmpdir(), "relay-audit-run-"));
	roots.push(root);
	const target = join(root, "target");
	mkdirSync(target);
	writeFileSync(join(target, "app.ts"), content);
	return { root, target, output: join(root, "reports") };
}
async function config(target: string, output: string, execution: Record<string, unknown> = {}): Promise<AuditConfig> {
	return preflight({
		version: "3.0",
		snapshot: { policy: "working-tree" },
		project: { name: "fixture", repository_path: target },
		scope: { output_root: output },
		model: { authorized: true, provider: "mock", id: "test" },
		execution: { max_retries: 0, ...execution },
	});
}
function candidate(input: WorkerInput): Finding {
	const context = JSON.parse(input.prompt.split("\n")[0]);
	const entry = input.snapshot.entries.find((e) => e.path === "app.ts")!;
	return {
		id: `${input.id}/BOLA`,
		run_id: context.run_id,
		repository_revision: input.snapshot.repositoryRevision,
		origin_specialist: "security",
		domain: "03",
		title: "Missing object authorization",
		status: "POTENCIAL",
		severity: "ALTA",
		priority: "P1",
		confidence: "MEDIA",
		description: "Synthetic ownership check missing in fixture",
		exploit_conditions: "Authenticated attacker must know another object's id",
		impact: "Unauthorized read",
		evidence: [
			{
				id: `${input.id}/evidence`,
				source_kind: "repository_code",
				locator: "app.ts:2",
				path: "app.ts",
				line_start: 2,
				line_end: 2,
				file_sha256: entry.sha256!,
				method: "snapshot read",
				summary: "Synthetic route",
			},
		],
		remediation: "Enforce ownership",
		acceptance_criteria: ["Cross-owner request denied"],
	};
}
function result(input: WorkerInput): AgentResult {
	const context = JSON.parse(input.prompt.split("\n")[0]);
	const task = JSON.parse(input.prompt.split("\nTask: ")[1].split("\n")[0]) as { domain: string; scope_id: string };
	return {
		run_id: context.run_id,
		task_id: input.id,
		scope_id: task.scope_id,
		repository_revision: input.snapshot.repositoryRevision,
		specialist_id: input.role as AgentResult["specialist_id"],
		coverage: {
			discovered: input.snapshot.entries.length,
			examined: input.snapshot.entries.filter((e) => e.status === "included").length,
			not_verified: input.snapshot.entries.filter((e) => e.status !== "included").length,
			not_applicable: 0,
			assets: input.snapshot.entries.map((e, i) => ({
				id: `${input.id}/asset-${i}`,
				kind: "file",
				locator: e.path,
				status: e.status === "included" ? "EXAMINADO" : "NAO_VERIFICADO",
			})),
		},
		candidates:
			input.id === "domain-03" && input.snapshot.files["app.ts"].includes("unprotected") ? [candidate(input)] : [],
		strengths: [],
		limitations: [],
		handoff_refs: [],
	};
}
function worker(hook?: (input: WorkerInput, output: unknown) => unknown): AuditWorker {
	return async (input) => {
		input.signal.throwIfAborted();
		input.charge({ tokens: 10, cost: 0.001 });
		let output: unknown;
		if (input.id === "discovery")
			output = {
				version: 1,
				domains: DOMAINS.map((domain) => ({
					domain,
					applicable: "yes",
					reason: "Synthetic fixture applicability",
					evidence_paths: ["app.ts"],
				})),
				limitations: [],
			};
		else if (input.id === "threat-model")
			output = {
				version: 1,
				assets: [{ name: "object", description: "Synthetic object", paths: ["app.ts"] }],
				entry_points: [],
				trust_boundaries: [],
				threats: [],
				limitations: [],
			};
		else if (input.id.startsWith("domain-") || input.id.startsWith("consult-")) output = result(input);
		else if (input.id.startsWith("review-")) {
			const finding = JSON.parse(input.prompt.split("Candidate (untrusted): ")[1].split("\n")[0]) as Finding;
			output = {
				version: 1,
				finding_id: finding.id,
				status: input.snapshot.files["app.ts"].includes("with-owner-guard") ? "DESCARTADO" : "CONFIRMADO",
				validation: {
					reviewer_id: input.id,
					reviewed_at: new Date().toISOString(),
					independent_review: true,
					checked_evidence_refs: finding.evidence.map((e) => e.id),
					decision_reason: "Independently reread the synthetic route and surrounding controls",
				},
			};
		} else output = { version: 1, summary: "Synthetic static audit; no certification.", limitations: [] };
		output = hook?.(input, output) ?? output;
		return {
			text: typeof output === "string" ? output : JSON.stringify(output),
			reads: Object.entries(input.snapshot.files).map(([path, text]) => ({
				path,
				start: 1,
				end: text.split("\n").length,
			})),
		};
	};
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe("local audit coordinator", () => {
	it("runs all 20 domains and generates deterministic local JSON/Markdown with no false empty vulnerability totals", async () => {
		const f = fixture();
		const calls: string[] = [];
		const outcome = await runAudit({
			config: await config(f.target, f.output),
			worker: worker((i, o) => {
				calls.push(i.id);
				return o;
			}),
		});
		expect(outcome.run.status).toBe("COMPLETED");
		expect(outcome.run.tasks).toHaveLength(20);
		expect(outcome.run.tasks.every((t) => t.status === "COMPLETED")).toBe(true);
		expect(calls).toHaveLength(23);
		const report = JSON.parse(readFileSync(join(outcome.directory, "report.json"), "utf8"));
		expect(report.totals.confirmed).toBe(0);
		expect(readFileSync(join(outcome.directory, "report.md"), "utf8")).toContain("No security grade");
		expect(readFileSync(join(f.target, "app.ts"), "utf8")).toContain("protectedRoute");
	});
	it("confirms only after an independent reread, and discards a protected-route false positive", async () => {
		for (const content of ["// synthetic\nunprotected\n", "// synthetic\nunprotected with-owner-guard\n"]) {
			const f = fixture(content);
			const outcome = await runAudit({
				config: await config(f.target, f.output, { generate_issues_drafts: true }),
				worker: worker(),
			});
			const report = JSON.parse(readFileSync(join(outcome.directory, "report.json"), "utf8"));
			expect(report.totals.confirmed).toBe(content.includes("guard") ? 0 : 1);
			expect(report.totals.discarded).toBe(content.includes("guard") ? 1 : 0);
			expect(report.findings[0].validation.independent_review).toBe(true);
		}
	});
	it("retains partial accepted results, retries failed tasks on compatible resume, and rejects modified snapshots", async () => {
		const f = fixture();
		const cfg = await config(f.target, f.output);
		const partial = await runAudit({
			config: cfg,
			worker: worker((i, o) => (i.id === "domain-07" ? '{"truncated":' : o)),
		});
		expect(partial.run.status).toBe("PARTIAL");
		expect(partial.run.tasks.filter((t) => t.status === "COMPLETED")).toHaveLength(19);
		const calls: string[] = [];
		const resumed = await runAudit({
			config: cfg,
			runId: partial.run.run_id,
			worker: worker((i, o) => {
				calls.push(i.id);
				return o;
			}),
		});
		expect(resumed.run.status).toBe("COMPLETED");
		expect(calls).toEqual(["domain-07", "report"]);
		writeFileSync(join(f.target, "app.ts"), "changed");
		await expect(runAudit({ config: cfg, runId: partial.run.run_id, worker: worker() })).rejects.toThrow(
			/modified snapshot/,
		);
	});
	it("rejects forged confirmations and malformed evidence before the reporting boundary", async () => {
		const f = fixture("// fixture\nunprotected\n");
		const outcome = await runAudit({
			config: await config(f.target, f.output),
			worker: worker((i, o) => {
				if (i.id === "domain-03") {
					const value = o as AgentResult;
					value.candidates[0].status = "CONFIRMADO";
					return value;
				}
				return o;
			}),
		});
		const report = JSON.parse(readFileSync(join(outcome.directory, "report.json"), "utf8"));
		expect(outcome.run.status).toBe("PARTIAL");
		expect(report.totals.confirmed).toBe(0);
	});
	it("does not count unreadable/excluded/binary assets as non-applicable or complete", async () => {
		const f = fixture();
		writeFileSync(join(f.target, ".env"), "API_KEY=not-an-export");
		writeFileSync(join(f.target, "binary"), Buffer.from([0, 1, 0]));
		const outcome = await runAudit({ config: await config(f.target, f.output), worker: worker() });
		expect(outcome.run.status).toBe("PARTIAL");
		const coverage = JSON.parse(readFileSync(join(outcome.directory, "coverage.json"), "utf8"));
		expect(
			coverage.every(
				(c: { coverage: { not_applicable: number; not_verified: number } }) =>
					c.coverage.not_applicable === 0 && c.coverage.not_verified === 2,
			),
		).toBe(true);
		expect(readFileSync(join(outcome.directory, "report.json"), "utf8")).not.toContain("not-an-export");
	});
	it("enforces cancellation and global token budgets and retains terminal checkpoints", async () => {
		for (const mode of ["cancel", "tokens"]) {
			const f = fixture();
			let runId = "";
			const outcome = await runAudit({
				config: await config(f.target, f.output, mode === "tokens" ? { max_tokens: 1 } : {}),
				onStatus(run) {
					runId = run.run_id;
				},
				worker:
					mode === "tokens"
						? worker()
						: async (input) => {
								cancelAudit(runId);
								input.signal.throwIfAborted();
								throw new Error("cancelled");
							},
			});
			expect(["FAILED", "PARTIAL"]).toContain(outcome.run.status);
			expect(readAuditStatus(f.output, outcome.run.run_id).run.status).toBe(outcome.run.status);
		}
	});
	it("routes bounded consultations through fresh scoped tasks, without experimental delegation", async () => {
		const f = fixture(),
			resources = loadResources();
		const from = DOMAINS.find((d) => resources.routing.routing[d].consult.length > 0)!;
		const target = DOMAINS.find(
			(d) => d !== from && resources.routing.routing[d].primary === resources.routing.routing[from].consult[0],
		)!;
		const outcome = await runAudit({
			config: await config(f.target, f.output),
			worker: worker((input, output) => {
				if (input.id === `domain-${from}`) (output as AgentResult).handoff_refs = [`domain-${target}`];
				return output;
			}),
		});
		expect(outcome.run.status).toBe("COMPLETED");
		const consultations = outcome.run.tasks.filter((t) => t.task_id.startsWith("consult-"));
		expect(consultations).toHaveLength(1);
		expect(consultations[0].domain).toBe(from);
		expect(consultations[0].agent).toBe(resources.routing.routing[from].consult[0]);
		expect(outcome.meter.handoffs).toBe(1);
	});
	it.each([
		"run",
		"revision",
		"scope",
		"specialist",
		"coverage",
		"range",
		"hash",
		"path",
		"strength",
		"handoff",
		"advisory",
	])("rejects poisoned %s data before accepting a specialist result", async (kind) => {
		const f = fixture("// fixture\nunprotected\n");
		const outcome = await runAudit({
			config: await config(f.target, f.output),
			worker: worker((i, o) => {
				if (i.id !== "domain-03") return o;
				const r = o as AgentResult,
					finding = r.candidates[0];
				switch (kind) {
					case "run":
						r.run_id = "foreign";
						break;
					case "revision":
						r.repository_revision = "foreign";
						break;
					case "scope":
						r.scope_id = "foreign";
						break;
					case "specialist":
						r.specialist_id = "malware";
						break;
					case "coverage":
						r.coverage.discovered++;
						break;
					case "range":
						finding.evidence[0].line_end = 999;
						break;
					case "hash":
						finding.evidence[0].file_sha256 = "0".repeat(64);
						break;
					case "path":
						finding.evidence[0].path = "../credentials";
						break;
					case "strength":
						r.strengths.push({
							id: "s",
							scope: r.scope_id,
							description: "unsupported assurance",
							evidence_refs: ["missing"],
						});
						break;
					case "handoff":
						r.handoff_refs.push("unknown-task");
						break;
					case "advisory":
						finding.cve = "CVE-2099-99999";
						break;
				}
				return r;
			}),
		});
		expect(outcome.run.status).toBe("PARTIAL");
		expect(outcome.run.tasks.find((t) => t.task_id === "domain-03")?.status).toBe("BLOCKED");
		const report = JSON.parse(readFileSync(join(outcome.directory, "report.json"), "utf8"));
		expect(report.totals.confirmed).toBe(0);
	});
	it("retains original candidates and accepted independent verdicts across resume", async () => {
		const f = fixture("// fixture\nunprotected\n");
		const cfg = await config(f.target, f.output);
		const original = await runAudit({ config: cfg, worker: worker() });
		const calls: string[] = [];
		const resumed = await runAudit({
			config: cfg,
			runId: original.run.run_id,
			worker: worker((i, o) => {
				calls.push(i.id);
				return o;
			}),
		});
		expect(calls).toEqual([]);
		expect(resumed.run.status).toBe("COMPLETED");
		const state = readAuditStatus(f.output, original.run.run_id);
		expect(state.results.find((r) => r.result.task_id === "domain-03")?.result.candidates[0].status).toBe(
			"POTENCIAL",
		);
		expect(state.findings[0].status).toBe("CONFIRMADO");
	});
	it("does not trust arbitrary editorial prose to add findings or certify the project", async () => {
		const f = fixture();
		const outcome = await runAudit({
			config: await config(f.target, f.output),
			worker: worker((i, o) =>
				i.id === "report"
					? { version: 1, summary: "Certified! 999 confirmed findings. <script>bad()</script>", limitations: [] }
					: o,
			),
		});
		const report = JSON.parse(readFileSync(join(outcome.directory, "report.json"), "utf8"));
		expect(report.summary).not.toContain("999");
		expect(report.totals.confirmed).toBe(0);
		expect(readFileSync(join(outcome.directory, "report.md"), "utf8")).not.toContain("<script>");
	});
	it("retains a valid JSON report and reports partial status when Markdown writing fails", async () => {
		const f = fixture(),
			cfg = await config(f.target, f.output),
			snapshot = await createSnapshot(cfg);
		const store = new AuditStore(f.output, "audit-00000000-0000-0000-0000-000000000000");
		store.acquire();
		const original = store.write.bind(store);
		store.write = (name, value, raw) => {
			if (name === "report.md") throw new Error("fixture disk failure");
			original(name, value, raw);
		};
		try {
			const rendered = writeReports(store, {
				runId: store.runId,
				status: "COMPLETED",
				snapshot,
				tasks: [],
				results: [],
				findings: [],
				limitations: [],
				summary: "draft",
				issues: false,
			});
			expect(rendered.status).toBe("PARTIAL");
			expect((store.read("report.json") as { status: string }).status).toBe("PARTIAL");
			expect(rendered.failedFormats).toContain("report.md");
		} finally {
			store.release();
		}
	});
	it("invalidates current-target consolidation when source changes during execution", async () => {
		const f = fixture("// fixture\nunprotected\n"),
			cfg = await config(f.target, f.output);
		const outcome = await runAudit({
			config: cfg,
			worker: worker((input, output) => {
				if (input.id === "report") writeFileSync(join(f.target, "app.ts"), "changed after review");
				return output;
			}),
		});
		expect(outcome.run.status).toBe("PARTIAL");
		const report = JSON.parse(readFileSync(join(outcome.directory, "report.json"), "utf8"));
		expect(report.totals.confirmed).toBe(0);
		expect(report.totals.requires_validation).toBe(1);
		await expect(runAudit({ config: cfg, runId: outcome.run.run_id, worker: worker() })).rejects.toThrow(/new run/);
	});
	it("deduplicates independently reviewed candidates without losing origins or inflating totals", async () => {
		const f = fixture("// fixture\nunprotected\n");
		const outcome = await runAudit({
			config: await config(f.target, f.output),
			worker: worker((input, output) => {
				if (input.id === "domain-03") {
					const result = output as AgentResult,
						duplicate = structuredClone(result.candidates[0]);
					duplicate.id += "-duplicate";
					duplicate.evidence[0].id += "-duplicate";
					result.candidates.push(duplicate);
				}
				return output;
			}),
		});
		const report = JSON.parse(readFileSync(join(outcome.directory, "report.json"), "utf8"));
		expect(report.totals.confirmed).toBe(1);
		expect(report.totals.duplicates).toBe(1);
		expect(report.findings).toHaveLength(2);
	});
	it("requires observed evidence ranges from the independent reviewer, not just a confident JSON verdict", async () => {
		const f = fixture("// fixture\nunprotected\n"),
			base = worker();
		const outcome = await runAudit({
			config: await config(f.target, f.output),
			worker: async (input) => {
				const output = await base(input);
				if (input.id.startsWith("review-")) output.reads = [];
				return output;
			},
		});
		const report = JSON.parse(readFileSync(join(outcome.directory, "report.json"), "utf8"));
		expect(outcome.run.status).toBe("PARTIAL");
		expect(report.totals.confirmed).toBe(0);
		expect(report.totals.requires_validation).toBe(1);
	});
	it("enforces per-task limits while preserving successful siblings", async () => {
		const f = fixture(),
			base = worker();
		const outcome = await runAudit({
			config: await config(f.target, f.output, { max_task_tool_calls: 2 }),
			worker: async (input) => {
				if (input.id === "domain-07") input.charge({ toolCalls: 3 });
				return base(input);
			},
		});
		expect(outcome.run.status).toBe("PARTIAL");
		expect(outcome.run.tasks.filter((t) => t.status === "COMPLETED")).toHaveLength(19);
	});
	it("performs at most the configured contract correction and records consumption", async () => {
		const f = fixture();
		let attempts = 0;
		const outcome = await runAudit({
			config: await config(f.target, f.output, { max_retries: 1 }),
			worker: worker((input, output) => (input.id === "domain-07" && attempts++ === 0 ? "truncated" : output)),
		});
		expect(outcome.run.status).toBe("COMPLETED");
		const checkpoint = readAuditStatus(f.output, outcome.run.run_id);
		expect(checkpoint.task_meter["domain-07"].attempts).toBe(2);
		expect(outcome.meter.tokens).toBeGreaterThan(0);
	});
	it.each(["malware", "supply-chain", "infrastructure", "privacy", "ai-security"] as const)(
		"keeps the synthetic %s surface as inert scoped data, with no runtime or jurisdiction assumptions",
		async (role) => {
			const f = fixture(),
				resources = loadResources(),
				domain = DOMAINS.find((d) => resources.routing.routing[d].primary === role)!;
			const filename =
				role === "supply-chain" ? "package.json" : role === "infrastructure" ? "main.tf" : `${role}.ts`;
			const body =
				role === "supply-chain"
					? JSON.stringify({ scripts: { postinstall: "DO_NOT_EXECUTE_THIS_FIXTURE" } })
					: role === "infrastructure"
						? 'resource "aws_security_group_rule" "ssh" { type = "ingress"; from_port = 22; to_port = 22; cidr_blocks = ["0.0.0.0/0"] }'
						: role === "privacy"
							? 'console.log({ email: "synthetic@example.invalid" });'
							: role === "ai-security"
								? "systemPrompt += externalDocument; // untrusted instruction surface"
								: 'exec("DO_NOT_EXECUTE_THIS_FIXTURE");';
			writeFileSync(join(f.target, filename), body);
			const outcome = await runAudit({
				config: await config(f.target, f.output),
				worker: worker((input, output) => {
					if (input.id === `domain-${domain}`) {
						const result = output as AgentResult,
							finding = candidate(input),
							entry = input.snapshot.entries.find((e) => e.path === filename)!;
						finding.id = `${input.id}/fixture`;
						finding.domain = domain;
						finding.origin_specialist = result.specialist_id;
						finding.title = `Synthetic ${role} fixture`;
						finding.evidence[0] = {
							...finding.evidence[0],
							id: `${input.id}/fixture-evidence`,
							path: filename,
							locator: `${filename}:1`,
							line_start: 1,
							line_end: 1,
							file_sha256: entry.sha256,
						};
						result.candidates = [finding];
					}
					return output;
				}),
			});
			const report = JSON.parse(readFileSync(join(outcome.directory, "report.json"), "utf8"));
			expect(report.totals.confirmed).toBe(1);
			const effective = JSON.parse(readFileSync(join(outcome.directory, "effective-config.json"), "utf8"));
			expect(effective.context.target_jurisdictions).toEqual([]);
			expect(effective.context.personal_data_processing).toBe("unknown");
			expect(readFileSync(join(f.target, filename), "utf8")).toBe(body);
		},
	);
	it("locks runs and recovers a previous complete checkpoint from interrupted writes", () => {
		const f = fixture();
		const id = "audit-00000000-0000-0000-0000-000000000000";
		const first = new AuditStore(f.output, id);
		first.acquire();
		first.checkpoint({ step: 1 });
		first.checkpoint({ step: 2 });
		const other = new AuditStore(f.output, id);
		expect(() => other.acquire()).toThrow();
		expect(() => other.write("report.json", {})).toThrow();
		expect(() => first.write("../escape", {})).toThrow();
		writeFileSync(join(first.dir, "checkpoint.json"), "interrupted");
		expect(first.load()).toEqual({ step: 1 });
		first.release();
		other.acquire();
		other.release();
	});
});
