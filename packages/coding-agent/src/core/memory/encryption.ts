import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption at rest for the memory database. The whole SQLite image is sealed with AES-256-GCM
 * (authenticated: tampering or a wrong key fails instead of yielding garbage). The 256-bit key is random
 * and lives only in the operating system's credential store, never next to the database.
 */

const MAGIC = Buffer.from("RLYMEM01", "ascii");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SQLITE_HEADER = Buffer.from("SQLite format 3\u0000", "ascii");
const SERVICE = "relay-native-memory";

export function isEncryptedDatabase(data: Uint8Array): boolean {
	return data.length >= MAGIC.length && Buffer.from(data.subarray(0, MAGIC.length)).equals(MAGIC);
}

export function isPlainSqliteDatabase(data: Uint8Array): boolean {
	return data.length >= SQLITE_HEADER.length && Buffer.from(data.subarray(0, SQLITE_HEADER.length)).equals(SQLITE_HEADER);
}

export function encryptDatabase(plain: Uint8Array, key: Buffer): Buffer {
	if (key.length !== 32) throw new Error("Memory encryption key must be 256 bits.");
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(MAGIC);
	const body = Buffer.concat([cipher.update(plain), cipher.final()]);
	return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptDatabase(data: Uint8Array, key: Buffer): Uint8Array {
	if (!isEncryptedDatabase(data)) throw new Error("Not an encrypted memory database.");
	const bytes = Buffer.from(data);
	const iv = bytes.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
	const tag = bytes.subarray(MAGIC.length + IV_LENGTH, MAGIC.length + IV_LENGTH + TAG_LENGTH);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAAD(MAGIC);
	decipher.setAuthTag(tag);
	try {
		return Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + IV_LENGTH + TAG_LENGTH)), decipher.final()]);
	} catch {
		throw new Error("Memory database failed authentication: wrong key or modified file.");
	}
}

// ---------------------------------------------------------------- OS credential store

export interface SecretStore {
	/** Human-readable store name for status output. */
	readonly name: string;
	get(account: string): Promise<string | undefined>;
	set(account: string, secret: string): Promise<void>;
	delete(account: string): Promise<void>;
}

export type CommandRunner = (
	command: string,
	args: string[],
	input?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const runCommand: CommandRunner = (command, args, input) =>
	new Promise((resolvePromise, reject) => {
		const child = execFile(
			command,
			args,
			{ timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
					reject(new Error(`OS credential store is unavailable: ${command} was not found.`));
					return;
				}
				const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
		// Secrets travel through stdin, never argv, so they do not appear in process listings.
		child.stdin?.end(input ?? "");
	});

function checkAccount(account: string): string {
	if (!/^[A-Za-z0-9._:-]{1,128}$/.test(account)) throw new Error("Invalid credential account name.");
	return account;
}

function failure(action: string, result: { code: number; stderr: string }): Error {
	return new Error(`Could not ${action} the memory key in the OS credential store (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`);
}

/** Windows Credential Manager through the WinRT PasswordVault, driven by PowerShell (no native module). */
export function windowsSecretStore(run: CommandRunner = runCommand): SecretStore {
	const powershell = (script: string, input?: string) =>
		run(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(
					`$ErrorActionPreference='Stop'\n$null=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]\n$v=New-Object Windows.Security.Credentials.PasswordVault\nfunction Find($a){ try { return $v.Retrieve('${SERVICE}',$a) } catch { $e=$_.Exception; while($e.InnerException){$e=$e.InnerException}; if($e.HResult -eq -2147023728){ return $null }; throw } }\n${script}`,
					"utf16le",
				).toString("base64"),
			],
			input,
		);
	return {
		name: "Windows Credential Manager",
		async get(account) {
			const result = await powershell(
				`$c=Find '${checkAccount(account)}'; if($c -eq $null){ exit 3 }; $c.RetrievePassword(); [Console]::Out.Write($c.Password)`,
			);
			if (result.code === 3) return undefined;
			if (result.code !== 0) throw failure("read", result);
			return result.stdout.trim() || undefined;
		},
		async set(account, secret) {
			const result = await powershell(
				`$p=[Console]::In.ReadLine(); $c=Find '${checkAccount(account)}'; if($c -ne $null){ $v.Remove($c) }; $v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}','${account}',$p)))`,
				`${secret}\n`,
			);
			if (result.code !== 0) throw failure("store", result);
		},
		async delete(account) {
			const result = await powershell(`$c=Find '${checkAccount(account)}'; if($c -ne $null){ $v.Remove($c) }`);
			if (result.code !== 0) throw failure("delete", result);
		},
	};
}

/** macOS login keychain through the `security` tool. */
export function macosSecretStore(run: CommandRunner = runCommand): SecretStore {
	return {
		name: "macOS Keychain",
		async get(account) {
			const result = await run("security", ["find-generic-password", "-s", SERVICE, "-a", checkAccount(account), "-w"]);
			if (result.code === 44) return undefined;
			if (result.code !== 0) throw failure("read", result);
			return result.stdout.trim() || undefined;
		},
		async set(account, secret) {
			// Interactive mode reads the command from stdin, which keeps the secret out of argv.
			const result = await run(
				"security",
				["-i"],
				`add-generic-password -U -s ${SERVICE} -a ${checkAccount(account)} -w ${secret}\n`,
			);
			if (result.code !== 0) throw failure("store", result);
		},
		async delete(account) {
			const result = await run("security", ["delete-generic-password", "-s", SERVICE, "-a", checkAccount(account)]);
			if (result.code !== 0 && result.code !== 44) throw failure("delete", result);
		},
	};
}

/** Linux Secret Service (GNOME Keyring, KWallet) through `secret-tool` from libsecret. */
export function linuxSecretStore(run: CommandRunner = runCommand): SecretStore {
	return {
		name: "Secret Service (libsecret)",
		async get(account) {
			const result = await run("secret-tool", ["lookup", "service", SERVICE, "account", checkAccount(account)]);
			if (result.code !== 0 && !result.stderr.trim()) return undefined;
			if (result.code !== 0) throw failure("read", result);
			return result.stdout.trim() || undefined;
		},
		async set(account, secret) {
			const result = await run(
				"secret-tool",
				["store", "--label=Relay native memory key", "service", SERVICE, "account", checkAccount(account)],
				secret,
			);
			if (result.code !== 0) throw failure("store", result);
		},
		async delete(account) {
			const result = await run("secret-tool", ["clear", "service", SERVICE, "account", checkAccount(account)]);
			if (result.code !== 0 && result.stderr.trim()) throw failure("delete", result);
		},
	};
}

export function osSecretStore(platform: NodeJS.Platform = process.platform): SecretStore {
	if (platform === "win32") return windowsSecretStore();
	if (platform === "darwin") return macosSecretStore();
	return linuxSecretStore();
}

/** One key per OS user: backups stay restorable to any path by the same user, and to nobody else. */
export const MEMORY_KEY_ACCOUNT = "database-key";

/**
 * Returns the database key, creating it on first use. A missing key never replaces an existing
 * encrypted database: that would make its contents unrecoverable, so it fails instead.
 */
export async function loadOrCreateMemoryKey(
	store: SecretStore,
	account: string,
	encryptedDatabaseExists: boolean,
): Promise<Buffer> {
	const existing = await store.get(account);
	if (existing) {
		const key = Buffer.from(existing, "hex");
		if (key.length !== 32) throw new Error(`The memory key in ${store.name} is malformed.`);
		return key;
	}
	if (encryptedDatabaseExists)
		throw new Error(
			`The memory database is encrypted but its key is missing from ${store.name}; restore the key or move the database away.`,
		);
	const key = randomBytes(32);
	await store.set(account, key.toString("hex"));
	const stored = await store.get(account);
	if (stored !== key.toString("hex")) throw new Error(`${store.name} did not keep the memory key.`);
	return key;
}
