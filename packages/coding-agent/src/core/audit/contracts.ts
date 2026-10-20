import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { default as formatsModule } from "ajv-formats";

const addFormats = formatsModule.default;

import { parse } from "yaml";
import { getAuditResourcesPath } from "../../config.ts";
import { hash, record } from "./config.ts";
import { observed, type ReadReceipt, readSnapshotFile, type Snapshot } from "./snapshot.ts";

export const DOMAINS = Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, "0"));
export type Specialist = "security" | "malware" | "privacy" | "supply-chain" | "infrastructure" | "ai-security";
export type FindingStatus = "CONFIRMADO" | "POTENCIAL" | "REQUER_VALIDACAO" | "DESCARTADO";
export type Evidence = {
	id: string;
	source_kind: string;
	locator: string;
	path?: string | null;
	line_start?: number | null;
	line_end?: number | null;
	file_sha256?: string | null;
	excerpt_redacted?: string | null;
	method: string;
	summary: string;
};
export type Finding = {
	id: string;
	run_id: string;
	repository_revision: string;
	origin_specialist: Specialist;
	domain: string;
	title: string;
	status: FindingStatus;
	severity: "CRITICA" | "ALTA" | "MEDIA" | "BAIXA" | "INFORMATIVA";
	priority: string;
	confidence: string;
	description: string;
	exploit_conditions: string;
	impact: string;
	evidence: Evidence[];
	remediation: string;
	acceptance_criteria: string[];
	duplicate_of?: string | null;
	validation?: Verdict["validation"] | null;
	[key: string]: unknown;
};
export type Asset = {
	id: string;
	kind: string;
	locator: string;
	status: "EXAMINADO" | "NAO_VERIFICADO" | "NAO_APLICAVEL";
	notes?: string;
};
export type AgentResult = {
	run_id: string;
	task_id: string;
	scope_id: string;
	repository_revision: string;
	specialist_id: Specialist;
	coverage: { discovered: number; examined: number; not_verified: number; not_applicable: number; assets: Asset[] };
	candidates: Finding[];
	strengths: { id: string; description: string; scope: string; evidence_refs: string[] }[];
	limitations: string[];
	handoff_refs: string[];
};
export type Task = {
	task_id: string;
	scope_id: string;
	domain: string;
	agent: Specialist;
	status: "PLANNED" | "RUNNING" | "COMPLETED" | "BLOCKED" | "SKIPPED";
	result_ref?: string | null;
};
export type Verdict = {
	finding_id: string;
	status: FindingStatus;
	validation: {
		reviewer_id: string;
		reviewed_at: string;
		independent_review: true;
		checked_evidence_refs: string[];
		decision_reason: string;
		validation_method?: string;
		remaining_uncertainties?: string[];
	};
};
export type Discovery = {
	version: 1;
	domains: { domain: string; applicable: "yes" | "unknown" | "no"; reason: string; evidence_paths: string[] }[];
	limitations: string[];
};
export type Routing = {
	version: string;
	roles: Record<string, string>;
	shared_policy: string;
	routing: Record<string, { primary: Specialist; consult: Specialist[] }>;
};
export type Resources = {
	id: string;
	files: Record<string, string>;
	routing: Routing;
	validate: (name: string, value: unknown) => void;
	prompt: (role: string) => string;
	schema: (name: string) => string;
};
export function loadResources(): Resources {
	const root = getAuditResourcesPath();
	const manifestText = readFileSync(join(root, "manifest.json"), "utf8");
	const manifest = JSON.parse(manifestText) as {
		version: number;
		protocol_version: string;
		files: Record<string, string>;
	};
	if (manifest.version !== 1 || manifest.protocol_version !== "3.0") throw new Error("Unsupported audit resources");
	const texts: Record<string, string> = Object.create(null);
	for (const [path, digest] of Object.entries(manifest.files)) {
		if (path.startsWith("/") || path.includes("..") || path.includes("\\")) throw new Error("Unsafe resource path");
		const data = readFileSync(join(root, path));
		if (hash(data) !== digest) throw new Error(`Audit resource drift: ${path}`);
		texts[path] = data.toString("utf8");
	}
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	addFormats(ajv);
	for (const name of ["finding", "agent-result", "audit-run"])
		ajv.addSchema(JSON.parse(texts[`contracts/${name}.schema.json`]), name);
	const routing = parse(texts["configs/routing.yaml"]) as Routing;
	if (
		routing.version !== "3.0" ||
		DOMAINS.some((d) => !routing.routing[d] || !routing.roles[routing.routing[d].primary])
	)
		throw new Error("Invalid 20-domain routing");
	return {
		id: hash(manifestText),
		files: manifest.files,
		routing,
		validate(name, value) {
			const validate = ajv.getSchema(name);
			if (!validate || !validate(value)) throw new Error(`Invalid ${name}: ${ajv.errorsText(validate?.errors)}`);
		},
		prompt(role) {
			const policy = texts[routing.shared_policy],
				prompt = texts[routing.roles[role]];
			if (!policy || !prompt) throw new Error("Unknown audit role");
			return `${policy}\n\n${prompt}`;
		},
		schema(name) {
			const text = texts[`contracts/${name}.schema.json`];
			if (!text) throw new Error("Unknown schema");
			return text;
		},
	};
}
export function parseOutput(text: string, limit: number): unknown {
	if (Buffer.byteLength(text) > limit) throw new Error("Model output size limit exceeded");
	// Do not salvage arbitrary prose, multiple documents or truncated JSON.
	const value: unknown = JSON.parse(text);
	const pending = [{ value, depth: 0 }];
	let nodes = 0;
	while (pending.length) {
		const current = pending.pop()!;
		if (++nodes > 100000 || current.depth > 20) throw new Error("Model JSON complexity limit exceeded");
		if (current.value && typeof current.value === "object")
			for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
	}
	return value;
}
export function validateDiscovery(value: unknown, snapshot: Snapshot): Discovery {
	const v = record(value, "discovery");
	if (
		v.version !== 1 ||
		!Array.isArray(v.domains) ||
		v.domains.length !== 20 ||
		!Array.isArray(v.limitations) ||
		!v.limitations.every((x) => typeof x === "string") ||
		Object.keys(v).some((k) => !["version", "domains", "limitations"].includes(k))
	)
		throw new Error("Invalid discovery contract v1");
	const seen = new Set<string>();
	for (const raw of v.domains) {
		const d = record(raw, "domain applicability");
		if (
			typeof d.domain !== "string" ||
			!DOMAINS.includes(d.domain) ||
			seen.has(d.domain) ||
			!["yes", "unknown", "no"].includes(String(d.applicable)) ||
			typeof d.reason !== "string" ||
			!d.reason.trim() ||
			!Array.isArray(d.evidence_paths) ||
			Object.keys(d).some((k) => !["domain", "applicable", "reason", "evidence_paths"].includes(k))
		)
			throw new Error("Invalid applicability");
		for (const path of d.evidence_paths) {
			if (typeof path !== "string") throw new Error("Invalid discovery reference");
			readSnapshotFile(snapshot, path);
		}
		if (d.applicable === "no" && !d.evidence_paths.length)
			throw new Error("Non-applicability requires snapshot evidence, not an exclusion");
		seen.add(d.domain);
	}
	return value as Discovery;
}
export function validateAgentResult(
	value: unknown,
	resources: Resources,
	snapshot: Snapshot,
	runId: string,
	task: Task,
	tasks: Task[],
): AgentResult {
	resources.validate("agent-result", value);
	const result = value as AgentResult;
	if (
		result.run_id !== runId ||
		result.task_id !== task.task_id ||
		result.scope_id !== task.scope_id ||
		result.repository_revision !== snapshot.repositoryRevision ||
		result.specialist_id !== task.agent
	)
		throw new Error("Specialist identity/revision mismatch");
	const paths = new Set(snapshot.entries.map((e) => e.path));
	const seen = new Set<string>();
	const ids = new Set<string>();
	for (const asset of result.coverage.assets) {
		if (!paths.has(asset.locator) || seen.has(asset.locator) || ids.has(asset.id))
			throw new Error("Coverage asset is missing, duplicated or outside inventory");
		if (asset.status === "EXAMINADO" && !Object.hasOwn(snapshot.files, asset.locator))
			throw new Error("Omitted file cannot be examined");
		if (asset.status === "NAO_APLICAVEL" && (!asset.notes?.trim() || !Object.hasOwn(snapshot.files, asset.locator)))
			throw new Error("Exclusion is not non-applicability");
		seen.add(asset.locator);
		ids.add(asset.id);
	}
	const coverage = result.coverage;
	if (
		seen.size !== paths.size ||
		coverage.discovered !== paths.size ||
		coverage.examined !== coverage.assets.filter((a) => a.status === "EXAMINADO").length ||
		coverage.not_verified !== coverage.assets.filter((a) => a.status === "NAO_VERIFICADO").length ||
		coverage.not_applicable !== coverage.assets.filter((a) => a.status === "NAO_APLICAVEL").length ||
		coverage.discovered !== coverage.examined + coverage.not_verified + coverage.not_applicable
	)
		throw new Error("Coverage denominator/count reconciliation failed");
	const findingIds = new Set<string>(),
		evidenceIds = new Set<string>();
	for (const finding of result.candidates) {
		if (
			findingIds.has(finding.id) ||
			finding.run_id !== runId ||
			finding.repository_revision !== snapshot.repositoryRevision ||
			finding.origin_specialist !== task.agent ||
			finding.domain !== task.domain ||
			finding.validation != null ||
			finding.duplicate_of != null ||
			(finding.status !== "POTENCIAL" && finding.status !== "REQUER_VALIDACAO")
		)
			throw new Error("Specialists cannot confirm/discard candidates or forge identity");
		if (finding.cve != null || finding.cvss_score != null || finding.cvss_vector != null)
			throw new Error(
				"Current advisory and quantitative scoring evidence is not supported; keep qualitative severity and record a limitation",
			);
		findingIds.add(finding.id);
		for (const evidence of finding.evidence) {
			if (evidenceIds.has(evidence.id)) throw new Error("Duplicate evidence ID");
			evidenceIds.add(evidence.id);
			if (evidence.source_kind !== "repository_code" && evidence.source_kind !== "repository_config")
				throw new Error("Runtime/external evidence is unsupported in static mode; use a limitation");
			if (!evidence.path || !evidence.line_start || !evidence.line_end) throw new Error("Missing evidence range");
			const excerpt = readSnapshotFile(snapshot, evidence.path, evidence.line_start, evidence.line_end);
			const entry = snapshot.entries.find((e) => e.path === evidence.path);
			if (
				evidence.file_sha256 !== entry?.sha256 ||
				(evidence.excerpt_redacted != null && !excerpt.includes(evidence.excerpt_redacted))
			)
				throw new Error("Evidence hash/excerpt mismatch");
		}
	}
	for (const strength of result.strengths)
		if (
			strength.scope !== task.scope_id ||
			strength.evidence_refs.some(
				(ref) =>
					!evidenceIds.has(ref) &&
					!coverage.assets.some((asset) => asset.id === ref && asset.status === "EXAMINADO"),
			)
		)
			throw new Error("Strength lacks resolvable evidence");
	if (
		new Set(result.handoff_refs).size !== result.handoff_refs.length ||
		result.handoff_refs.some((ref) => !tasks.some((t) => t.task_id === ref && t.task_id !== task.task_id))
	)
		throw new Error("Invalid handoff reference");
	return result;
}
export function validateVerdict(value: unknown, finding: Finding, reviewer: string, reads: ReadReceipt[]): Verdict {
	const v = record(value, "verdict");
	if (
		Object.keys(v).some((k) => !["version", "finding_id", "status", "validation"].includes(k)) ||
		v.version !== 1 ||
		v.finding_id !== finding.id ||
		!["CONFIRMADO", "POTENCIAL", "REQUER_VALIDACAO", "DESCARTADO"].includes(String(v.status))
	)
		throw new Error("Invalid verdict v1");
	const validation = record(v.validation, "independent validation");
	const refs = validation.checked_evidence_refs;
	if (
		validation.reviewer_id !== reviewer ||
		validation.independent_review !== true ||
		typeof validation.decision_reason !== "string" ||
		!validation.decision_reason.trim() ||
		!Array.isArray(refs) ||
		!refs.length ||
		new Set(refs).size !== refs.length ||
		refs.some((ref) => !finding.evidence.some((e) => e.id === ref))
	)
		throw new Error("Invalid independent review references");
	for (const ref of refs) {
		const e = finding.evidence.find((e) => e.id === ref)!;
		if (!e.path || !e.line_start || !e.line_end || !observed(reads, e.path, e.line_start, e.line_end))
			throw new Error("Reviewer did not independently reopen evidence");
	}
	if (
		v.status === "CONFIRMADO" &&
		/\b(?:CVE-\d{4}-\d+|LGPD|GDPR|HIPAA|CCPA|certification|certifica[cç][aã]o|legal compliance|conformidade legal)\b/i.test(
			`${finding.title} ${finding.description}`,
		)
	)
		throw new Error("Static evidence cannot confirm current-advisory or legal certification claims");
	if (v.status === "CONFIRMADO" && refs.length !== finding.evidence.length)
		throw new Error("Confirmation must check every evidence reference");
	return {
		finding_id: finding.id,
		status: v.status as FindingStatus,
		validation: validation as Verdict["validation"],
	};
}
