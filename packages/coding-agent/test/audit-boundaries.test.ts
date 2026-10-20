import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflight } from "../src/core/audit/config.ts";
import { createSnapshot, readSnapshotFile, redact, redactData } from "../src/core/audit/snapshot.ts";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "relay-audit-test-"));
	roots.push(root);
	const target = join(root, "target");
	mkdirSync(target);
	writeFileSync(join(target, "app.ts"), "const password = 'do-not-include-secret';\nexport const app = true;\n");
	return { root, target, output: join(root, "output") };
}
function config(target: string, output: string) {
	return {
		version: "3.0",
		snapshot: { policy: "working-tree" },
		project: { name: "fixture", repository_path: target },
		scope: { output_root: output },
		model: { authorized: true, provider: "faux", id: "fixture" },
	};
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe("audit preflight and snapshot", () => {
	it("requires explicit model authorization before reading the target", async () => {
		const { target, output } = fixture();
		const value = config(target, output);
		value.model.authorized = false;
		await expect(preflight(value)).rejects.toThrow(/model.*authoriz/i);
	});
	it("rejects dynamic, network, publication, PDF and ambiguous in-target output", async () => {
		const { target, output } = fixture();
		for (const key of [
			"runtime_testing",
			"sandbox_authorized",
			"external_network_access",
			"allow_publish_github_issues",
			"allow_write_to_target",
		]) {
			const value = config(target, output);
			Object.assign(value.scope, { [key]: true });
			await expect(preflight(value)).rejects.toThrow();
		}
		await expect(preflight(config(target, join(target, "reports")))).rejects.toThrow(/output/i);
		await expect(preflight({ ...config(target, output), execution: { generate_pdf: true } })).rejects.toThrow(/PDF/i);
	});
	it("rejects invalid budgets before touching a missing target, and requires explicit working-tree policy", async () => {
		const { root, output } = fixture();
		const value = config(join(root, "does-not-exist"), output);
		await expect(preflight({ ...value, execution: { max_cost: -1 } })).rejects.toThrow(/cost/i);
		await expect(preflight({ ...value, snapshot: undefined })).rejects.toThrow(/snapshot/i);
	});
	it("requires directory-specific consent for in-target artifacts and keeps snapshot identity stable when they appear", async () => {
		const { target } = fixture(),
			output = join(target, "reports");
		const input = config(target, output);
		Object.assign(input.scope, { allow_output_in_target: true });
		const cfg = await preflight(input);
		const before = await createSnapshot(cfg);
		mkdirSync(output);
		writeFileSync(join(output, "report.json"), "not target source");
		const after = await createSnapshot(cfg);
		expect(after.id).toBe(before.id);
		expect(() => readSnapshotFile(after, "reports/report.json")).toThrow();
	});
	it("rejects output junctions and nested Git output even with write-directory consent", async () => {
		const { root, target } = fixture(),
			real = join(root, "real-output"),
			alias = join(root, "alias-output");
		mkdirSync(real);
		symlinkSync(real, alias, "junction");
		await expect(preflight(config(target, alias))).rejects.toThrow(/link|junction/i);
		const input = config(target, join(target, ".git/reports"));
		Object.assign(input.scope, { allow_output_in_target: true });
		await expect(preflight(input)).rejects.toThrow(/Git metadata/i);
	});
	it("redacts quoted secrets and private keys without changing line positions or corrupting JSON", () => {
		const source =
			'const apiKey = "a secret value";\n-----BEGIN PRIVATE KEY-----\nTOP-SECRET\n-----END PRIVATE KEY-----\n';
		const masked = redact(source);
		expect(masked).not.toContain("a secret value");
		expect(masked).not.toContain("TOP-SECRET");
		expect(masked.split("\n")).toHaveLength(source.split("\n").length);
		const value = { description: source, nested: { api_key: "do-not-retain" } };
		const clean = redactData(value);
		expect(JSON.parse(JSON.stringify(clean)).nested.api_key).toBe("[REDACTED]");
	});
	it("does not disclose content reached through a hard link to an out-of-scope file", async () => {
		const { root, target, output } = fixture();
		const outside = join(root, "outside-secret");
		writeFileSync(outside, "DO_NOT_DISCLOSE");
		linkSync(outside, join(target, "looks-like-source.ts"));
		const snapshot = await createSnapshot(await preflight(config(target, output)));
		expect(snapshot.entries.find((e) => e.path === "looks-like-source.ts")?.status).toBe("excluded");
		expect(() => readSnapshotFile(snapshot, "looks-like-source.ts")).toThrow();
	});
	it("reads only explicitly authorized bounded Git identity, never history or hooks", async () => {
		const { target, output } = fixture();
		mkdirSync(join(target, ".git"));
		const revision = "a".repeat(40);
		writeFileSync(join(target, ".git/HEAD"), revision);
		writeFileSync(join(target, ".git/config"), "password=not-for-model");
		const input = config(target, output);
		Object.assign(input.snapshot, { git_revision: true });
		const snapshot = await createSnapshot(await preflight(input));
		expect(snapshot.repositoryRevision).toContain(`git:${revision};snapshot:`);
		expect(() => readSnapshotFile(snapshot, ".git/HEAD")).toThrow();
	});
	it("fails closed on inventory and time budgets instead of silently shrinking the denominator", async () => {
		const { target, output } = fixture();
		mkdirSync(join(target, "nested"));
		writeFileSync(join(target, "nested/x"), "data");
		const input = config(target, output);
		Object.assign(input.snapshot, { max_files: 1 });
		await expect(createSnapshot(await preflight(input))).rejects.toThrow(/limit/i);
		const cfg = await preflight(config(target, output));
		await expect(createSnapshot(cfg, { deadline: Date.now() - 1 })).rejects.toThrow(/time budget/i);
	});
	it("snapshots content, inventories omissions and rejects all path escapes", async () => {
		const { root, target, output } = fixture();
		mkdirSync(join(target, ".git"));
		writeFileSync(join(target, ".git", "config"), "secret");
		writeFileSync(join(target, ".env"), "API_KEY=do-not-export");
		writeFileSync(join(root, "outside.txt"), "outside");
		symlinkSync(join(root, "outside.txt"), join(target, "escape"), "file");
		const effective = await preflight(config(target, output));
		const snapshot = await createSnapshot(effective);
		expect(snapshot.entries.find((e) => e.path === "escape")?.status).toBe("symlink");
		expect(snapshot.entries.find((e) => e.path === ".env")?.status).toBe("excluded");
		expect(snapshot.entries.find((e) => e.path === ".git")?.status).toBe("excluded");
		expect(readSnapshotFile(snapshot, "app.ts")).not.toContain("do-not-include-secret");
		for (const path of [
			"../outside.txt",
			join(root, "outside.txt"),
			"C:\\Users\\credentials",
			"escape",
			".git/config",
			".env",
			"app.ts/../app.ts",
		])
			expect(() => readSnapshotFile(snapshot, path)).toThrow();
		writeFileSync(join(target, "app.ts"), "modified");
		expect(readSnapshotFile(snapshot, "app.ts")).not.toContain("modified");
		const changed = await createSnapshot(effective);
		expect(changed.id).not.toBe(snapshot.id);
		expect(readFileSync(join(target, ".env"), "utf8")).toContain("do-not-export");
	});
});
