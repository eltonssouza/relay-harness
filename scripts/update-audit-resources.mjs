import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "packages/coding-agent/resources/audit");
const check = process.argv.includes("--check");
const sourceArg = process.argv.slice(2).find(arg => !arg.startsWith("--"));
const source = sourceArg && resolve(sourceArg);
if (source) {
 if (!process.argv.includes("--authorized")) throw new Error("Resource update requires --authorized redistribution approval");
 for (const dir of ["prompts", "configs", "contracts", "templates", "docs", "examples"]) cpSync(join(source, dir), join(destination, dir), { recursive: true });
}
if (!existsSync(destination)) throw new Error("No audit resources");
const files = {};
function walk(dir) { for (const item of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) { const path = join(dir, item.name); if (item.isDirectory()) walk(path); else if (item.isFile() && item.name !== "manifest.json") files[relative(destination, path).replaceAll("\\", "/")] = createHash("sha256").update(readFileSync(path)).digest("hex"); else if (!item.isFile()) throw new Error("Resources must not contain links"); } }
walk(destination);
if (check) {
 const previous = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8"));
 if (JSON.stringify(previous.files) !== JSON.stringify(files)) throw new Error("Audit resource drift; explicitly update approved source and review the manifest diff");
 console.log(`Verified ${Object.keys(files).length} versioned audit resources`);
 process.exit(0);
}
mkdirSync(destination, { recursive: true });
writeFileSync(join(destination, "manifest.json"), `${JSON.stringify({ version: 1, protocol_version: "3.0", source: "agents-skills/universal-audit-multiagent", license: "MIT", redistribution: "Author explicitly authorized incorporation and redistribution under MIT in the implementation conversation.", files }, null, 2)}\n`);
