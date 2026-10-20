import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalPath, hash, isWithin } from "./config.ts";
import { redact, redactData } from "./snapshot.ts";

export type StoredCheckpoint<T> = { version: 1; sha256: string; data: T };
export class AuditStore {
	readonly dir: string;
	private lock?: number;
	readonly root: string;
	readonly runId: string;
	constructor(root: string, runId: string, mode: "create" | "existing" = "create") {
		this.root = root;
		this.runId = runId;
		if (!/^audit-[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid run ID");
		const canonical = canonicalPath(root);
		if (mode === "create") mkdirSync(canonical, { recursive: true, mode: 0o700 });
		this.dir = join(canonical, runId);
		if (existsSync(this.dir) && lstatSync(this.dir).isSymbolicLink()) throw new Error("Run directory is a link");
		if (mode === "create") mkdirSync(this.dir, { mode: 0o700, recursive: true });
		if (!lstatSync(this.dir).isDirectory()) throw new Error("Missing run directory");
		this.assertPath(this.dir);
	}
	private assertPath(path: string) {
		const actual = canonicalPath(path);
		if (!isWithin(this.dir, actual) && actual !== this.dir) throw new Error("Artifact path escaped run directory");
	}
	private path(name: string) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes("..")) throw new Error("Invalid artifact name");
		const path = join(this.dir, name);
		this.assertPath(path);
		return path;
	}
	acquire(recover = false) {
		if (this.lock !== undefined) throw new Error("Run already locked");
		const path = this.path("run.lock");
		if (recover && existsSync(path)) {
			if (!lstatSync(path).isFile() || lstatSync(path).nlink > 1 || lstatSync(path).size > 4096)
				throw new Error("Invalid lock size");
			const stale = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
			if (!Number.isSafeInteger(stale.pid) || stale.pid <= 0)
				throw new Error("Invalid lock; manual inspection required");
			try {
				process.kill(stale.pid, 0);
				throw new Error("Run is active");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
			rmSync(path);
		}
		this.lock = openSync(path, "wx", 0o600);
		writeFileSync(this.lock, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
		fsyncSync(this.lock);
	}
	release() {
		if (this.lock !== undefined) {
			closeSync(this.lock);
			this.lock = undefined;
			rmSync(this.path("run.lock"), { force: true });
		}
	}
	write(name: string, value: unknown, raw = false) {
		if (this.lock === undefined) throw new Error("Run lock required");
		const text = raw ? redact(String(value)) : `${JSON.stringify(redactData(value), null, 2)}\n`;
		const path = this.path(name),
			temp = this.path(`${name}.${randomUUID()}.tmp`);
		const fd = openSync(temp, "wx", 0o600);
		try {
			writeFileSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		try {
			this.assertPath(path);
			renameSync(temp, path);
		} finally {
			rmSync(temp, { force: true });
		}
	}
	has(name: string): boolean {
		return existsSync(this.path(name));
	}
	readText(name: string): string {
		const path = this.path(name);
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.nlink > 1 || stat.size > 32 * 1024 * 1024)
			throw new Error("Artifact is not a bounded private regular file");
		return readFileSync(path, "utf8");
	}
	read(name: string): unknown {
		return JSON.parse(this.readText(name));
	}
	writeImmutable(name: string, value: unknown) {
		if (this.has(name)) {
			if (JSON.stringify(this.read(name)) !== JSON.stringify(redactData(value)))
				throw new Error("Immutable artifact collision");
			return;
		}
		this.write(name, value);
	}
	checkpoint<T>(data: T) {
		// Mask before computing the digest so round-trips remain verifiable.
		const clean = redactData(data);
		const value: StoredCheckpoint<T> = { version: 1, sha256: hash(JSON.stringify(clean)), data: clean };
		if (existsSync(this.path("checkpoint.json")))
			this.write("checkpoint.previous.json", this.read("checkpoint.json"));
		this.write("checkpoint.json", value);
	}
	load<T>(): T {
		function validate(raw: unknown): T {
			const value = raw as StoredCheckpoint<T>;
			if (value?.version !== 1 || hash(JSON.stringify(value.data)) !== value.sha256)
				throw new Error("Invalid checkpoint version/digest");
			return value.data;
		}
		try {
			return validate(this.read("checkpoint.json"));
		} catch (error) {
			if (!existsSync(this.path("checkpoint.previous.json"))) throw error;
			return validate(this.read("checkpoint.previous.json"));
		}
	}
	integrityManifest() {
		return {
			version: 1,
			run_id: this.runId,
			artifacts: this.artifacts()
				.filter((name) => name !== "artifact-manifest.json")
				.map((name) => {
					const text = this.readText(name);
					return { name, bytes: Buffer.byteLength(text), sha256: hash(text) };
				}),
		};
	}
	artifacts(): string[] {
		return readdirSync(this.dir)
			.filter((name) => !name.endsWith(".tmp") && name !== "run.lock")
			.sort();
	}
}
