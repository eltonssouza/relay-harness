/**
 * Writes the `packages/agent` reference files for the Rust port to match: the loop's in
 * `crates/fixtures/loop/`, the `Agent` class's in `crates/fixtures/agent/` and `HarnessCore` on an
 * agent in `crates/fixtures/harness/`. Run through `npm run parity:record`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR, agentCases, agentJson } from "./agent-record.ts";
import { HARNESS_DIR, harnessCases, harnessJson } from "./harness-record.ts";
import { LOOP_DIR, loopCases, loopJson } from "./loop-record.ts";

for (const dir of [LOOP_DIR, AGENT_DIR, HARNESS_DIR]) {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
}
for (const testCase of loopCases()) writeFileSync(join(LOOP_DIR, `${testCase.name}.json`), await loopJson(testCase));
for (const testCase of agentCases()) writeFileSync(join(AGENT_DIR, `${testCase.name}.json`), await agentJson(testCase));
for (const testCase of harnessCases()) {
	writeFileSync(join(HARNESS_DIR, `${testCase.name}.json`), await harnessJson(testCase));
}
console.log(
	`wrote ${loopCases().length} loop, ${agentCases().length} Agent and ${harnessCases().length} harness cases to crates/fixtures/`,
);
