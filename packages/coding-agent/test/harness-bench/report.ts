import { fileURLToPath } from "node:url";
import { formatReport } from "./bench.ts";

const sessionFile = fileURLToPath(new URL("../fixtures/large-session.jsonl", import.meta.url));
console.log(formatReport(sessionFile));
