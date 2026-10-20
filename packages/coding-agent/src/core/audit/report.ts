import { hash } from "./config.ts";
import type { AgentResult, Finding, Task } from "./contracts.ts";
import { readSnapshotFile, type Snapshot } from "./snapshot.ts";
import type { AuditStore } from "./store.ts";

/** Keep provenance of every candidate; choose a confirmed canonical record when equivalent candidates differ. */
export function deduplicate(findings: Finding[]): Finding[] {
	const canonical = new Map<string, Finding>();
	function key(f: Finding) {
		return JSON.stringify([
			f.root_cause ?? f.title,
			f.evidence.map((e) => [e.path, e.line_start, e.line_end]).sort(),
		]);
	}
	for (const finding of findings) {
		const existing = canonical.get(key(finding));
		if (!existing || (finding.status === "CONFIRMADO" && existing.status !== "CONFIRMADO"))
			canonical.set(key(finding), finding);
	}
	return findings.map((f) => ({
		...f,
		...(canonical.get(key(f))!.id === f.id ? {} : { duplicate_of: canonical.get(key(f))!.id }),
	}));
}
function md(text: unknown): string {
	return String(text ?? "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
		.replace(/([\\`*_{}[\]()#+.!|<>])/g, "\\$1");
}
export function writeReports(
	store: AuditStore,
	input: {
		runId: string;
		status: string;
		snapshot: Snapshot;
		tasks: Task[];
		results: AgentResult[];
		findings: Finding[];
		limitations: string[];
		summary: string;
		issues: boolean;
	},
) {
	const findings = deduplicate(input.findings),
		confirmed = findings.filter((f) => f.status === "CONFIRMADO" && !f.duplicate_of);
	const totals = {
		confirmed: confirmed.length,
		potential: findings.filter((f) => f.status === "POTENCIAL" && !f.duplicate_of).length,
		requires_validation: findings.filter((f) => f.status === "REQUER_VALIDACAO" && !f.duplicate_of).length,
		discarded: findings.filter((f) => f.status === "DESCARTADO" && !f.duplicate_of).length,
		duplicates: findings.filter((f) => f.duplicate_of).length,
	};
	const coverage = input.tasks.map((task) => ({
		task_id: task.task_id,
		scope_id: task.scope_id,
		domain: task.domain,
		status: task.status,
		coverage: input.results.find((r) => r.task_id === task.task_id)?.coverage ?? null,
	}));
	let status = input.status;
	const failedFormats: string[] = [];
	function attempt(name: string, value: unknown, raw = false) {
		try {
			store.write(name, value, raw);
			return true;
		} catch {
			failedFormats.push(name);
			return false;
		}
	}
	attempt("findings.json", findings);
	attempt("coverage.json", coverage);
	attempt("strengths.json", {
		version: 1,
		observations: input.results.flatMap((result) =>
			result.strengths.map((strength) => ({
				...strength,
				task_id: result.task_id,
				specialist_id: result.specialist_id,
				note: "Scoped source observation, not project-wide assurance; references resolve to read assets or evidence in the originating immutable result.",
			})),
		),
	});
	for (const finding of findings) {
		attempt(`evidence-${hash(finding.id).slice(0, 20)}.json`, {
			version: 1,
			run_id: input.runId,
			snapshot_id: input.snapshot.id,
			finding_id: finding.id,
			observations: finding.evidence.map((e) => ({
				evidence_id: e.id,
				path: e.path,
				line_start: e.line_start,
				line_end: e.line_end,
				original_sha256: e.file_sha256,
				excerpt_redacted:
					e.path && e.line_start && e.line_end
						? readSnapshotFile(input.snapshot, e.path, e.line_start, e.line_end)
						: null,
			})),
			note: "Executor observation; original specialist evidence remains immutable in its result artifact.",
		});
	}
	// Free-form model prose is retained only as an explicitly unverified editorial draft, never as authoritative counts or conclusions.
	attempt("editorial-draft.json", {
		version: 1,
		status: "UNVERIFIED_EDITORIAL_DRAFT",
		text: input.summary,
		warning:
			"Not authoritative. May contain inaccuracies. Findings, decisions, totals and coverage are rendered deterministically.",
	});
	function finding(f: Finding) {
		return `### ${md(f.id)} — ${md(f.title)}\n\n${md(f.status)} / ${md(f.severity)} / ${md(f.priority)} / confidence ${md(f.confidence)}\n\n${md(f.description)}\n\nConditions: ${md(f.exploit_conditions)}\n\nImpact: ${md(f.impact)}\n\nEvidence: ${f.evidence.map((e) => `${md(e.id)}: ${md(e.path)}:${e.line_start}-${e.line_end} (${md(e.file_sha256)})`).join("; ")}\n\nIndependent decision: ${md(f.validation?.decision_reason ?? "No accepted independent verdict")}\n\nRemediation: ${md(f.remediation)}\n\nAcceptance:\n${f.acceptance_criteria.map((c) => `- ${md(c)}`).join("\n")}`;
	}
	if (input.issues)
		for (const f of confirmed)
			attempt(`issue-draft-${hash(f.id).slice(0, 20)}.md`, `# LOCAL DRAFT — not published\n\n${finding(f)}\n`, true);
	function document() {
		const summary = `Static audit ${status}: ${totals.confirmed} unique confirmed findings. ${totals.potential + totals.requires_validation} unconfirmed candidates; ${totals.discarded} discarded; ${totals.duplicates} duplicates.`;
		return {
			version: 1,
			run_id: input.runId,
			status,
			snapshot_id: input.snapshot.id,
			repository_revision: input.snapshot.repositoryRevision,
			summary,
			totals,
			coverage,
			findings,
			limitations: input.limitations,
			failed_formats: [...new Set(failedFormats)],
			assurance:
				"Static model-assisted review, not certification, legal advice or assurance of absence. Exclusions reduce coverage. No current CVE, runtime or compliance verification.",
		};
	}
	function markdown() {
		const parts = [
			`# Audit ${md(input.runId)}`,
			`Status: **${md(status)}**`,
			md(document().summary),
			`Confirmed unique findings: **${totals.confirmed}**; potential: ${totals.potential}; requires validation: ${totals.requires_validation}; discarded: ${totals.discarded}; duplicates: ${totals.duplicates}.`,
			"## Confirmed findings",
			...confirmed.map(finding),
			"## Unconfirmed candidates (not vulnerability totals)",
			...findings
				.filter((f) => ["POTENCIAL", "REQUER_VALIDACAO"].includes(f.status) && !f.duplicate_of)
				.map(finding),
			"## Discarded / duplicates",
			...findings
				.filter((f) => f.status === "DESCARTADO" || f.duplicate_of)
				.map(
					(f) =>
						`- ${md(f.id)} / ${md(f.origin_specialist)} / domain ${md(f.domain)}: ${md(f.status)}; duplicate of ${md(f.duplicate_of ?? "none")}; ${md(f.validation?.decision_reason)}`,
				),
			"## Coverage by domain / scope",
			...coverage.map(
				(c) =>
					`- ${md(c.domain)} / ${md(c.scope_id)}: ${c.status}; discovered ${c.coverage?.discovered ?? "unknown"}; examined ${c.coverage?.examined ?? 0}; not verified ${c.coverage?.not_verified ?? "unknown"}; not applicable ${c.coverage?.not_applicable ?? "unknown"}.`,
			),
			"## Limitations",
			...input.limitations.map((l) => `- ${md(l)}`),
			...failedFormats.map((f) => `- Failed artifact: ${md(f)}.`),
			"Static model-assisted review only. No security grade, certification, legal assurance, current advisory verification or guarantee of absence. Secret masking is heuristic. Review and delete retained artifacts according to your policy.",
		];
		const links = [
			["JSON", "report.json"],
			["inventory", "inventory.json"],
			["coverage", "coverage.json"],
			["findings", "findings.json"],
			["run", "audit-run.json"],
		].filter(([, name]) => store.has(name));
		parts.push(`Local artifacts: ${links.map(([label, name]) => `[${label}](${name})`).join(", ")}.`);
		return `${parts.join("\n\n")}\n`;
	}
	if (failedFormats.length) status = "PARTIAL";
	const json = attempt("report.json", document());
	const markdownWritten = attempt("report.md", markdown(), true);
	if (failedFormats.length) {
		status = "PARTIAL";
		input.limitations.push(
			...[...new Set(failedFormats)].map(
				(name) => `Artifact ${name} failed to write; other valid formats retained.`,
			),
		);
		if (json) attempt("report.json", document());
		if (markdownWritten) attempt("report.md", markdown(), true);
	}
	return { status, totals, findings, failedFormats: [...new Set(failedFormats)] };
}
