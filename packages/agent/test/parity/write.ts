/**
 * Writes the `packages/agent` reference files for the Rust port to match: the loop's in
 * `crates/fixtures/loop/` and the `Agent` class's in `crates/fixtures/agent/`. Run through
 * `npm run parity:record`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR, agentCases, agentJson } from "./agent-record.ts";
import { LOOP_DIR, loopCases, loopJson } from "./loop-record.ts";

for (const dir of [LOOP_DIR, AGENT_DIR]) {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
}
for (const testCase of loopCases()) writeFileSync(join(LOOP_DIR, `${testCase.name}.json`), await loopJson(testCase));
for (const testCase of agentCases()) writeFileSync(join(AGENT_DIR, `${testCase.name}.json`), await agentJson(testCase));
console.log(
	`wrote ${loopCases().length} agent loop cases to crates/fixtures/loop/ and ${agentCases().length} Agent cases to crates/fixtures/agent/`,
);
