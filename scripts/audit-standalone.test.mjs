import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("approved audit resources resolve and validate beside a real Bun standalone executable", { timeout: 180000 }, t => {
 const root = mkdtempSync(join(process.platform === "win32" ? `${process.env.SystemDrive ?? "C:"}\\` : tmpdir(), "relay-audit-standalone-"));
 const home = join(root, "home"); mkdirSync(home);
 const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMP: home, TEMP: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, RELAY_OFFLINE: "1", RELAY_TELEMETRY: "0" };
 for (const name of ["SystemRoot", "SYSTEMROOT", "SystemDrive", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT"]) if (process.env[name]) env[name] = process.env[name];
 try {
  const probe = spawnSync("bun", ["--version"], { env, encoding: "utf8" });
  if (probe.error?.code === "ENOENT") { t.skip("Bun is not installed; npm consumer resource checks still run separately"); return; }
  assert.equal(probe.status, 0, probe.stderr);
  const source = join(root, "entry.ts"), binary = join(root, process.platform === "win32" ? "audit-smoke.exe" : "audit-smoke");
  const contracts = join(repository, "packages/coding-agent/src/core/audit/contracts.ts").replaceAll("\\", "/");
  const config = join(repository, "packages/coding-agent/src/config.ts").replaceAll("\\", "/");
  writeFileSync(source, `import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { loadResources } from ${JSON.stringify(contracts)};
import { getAuditResourcesPath, isBunBinary } from ${JSON.stringify(config)};
assert.equal(isBunBinary, true);
assert.equal(getAuditResourcesPath(), join(dirname(process.execPath), "resources", "audit"));
const resources = loadResources();
assert.equal(Object.keys(resources.routing.routing).length, 20);
assert.equal(new Set(Object.values(resources.routing.routing).map(r => r.primary)).size, 6);
assert.equal(typeof resources.prompt("validator"), "string");
assert.equal(typeof resources.prompt("reporter"), "string");
resources.validate("finding", JSON.parse(await Bun.file(join(getAuditResourcesPath(), "examples/finding.validated.example.json")).text()));
console.log("Standalone audit resources: 20 domains, 6 specialists, local schemas and prompts verified");
`);
  const build = spawnSync("bun", ["build", "--compile", source, "--outfile", binary], { cwd: repository, env, encoding: "utf8", timeout: 120000 });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}\n${build.error ?? ""}`);
  cpSync(join(repository, "packages/coding-agent/resources/audit"), join(root, "resources/audit"), { recursive: true });
  cpSync(join(repository, "packages/coding-agent/package.json"), join(root, "package.json"));
  rmSync(source); // Execution cannot depend on its entry source.
  const result = spawnSync(binary, [], { cwd: home, env, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  assert.match(result.stdout, /20 domains, 6 specialists/);
 } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
