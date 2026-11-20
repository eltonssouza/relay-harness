/**
 * Writes the `packages/agent` reference files in `crates/fixtures/loop/` for the Rust port to
 * match. Run through `npm run parity:record`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOOP_DIR, loopCases, loopJson } from "./loop-record.ts";

rmSync(LOOP_DIR, { recursive: true, force: true });
mkdirSync(LOOP_DIR, { recursive: true });
for (const testCase of loopCases()) writeFileSync(join(LOOP_DIR, `${testCase.name}.json`), await loopJson(testCase));
console.log(`wrote ${loopCases().length} agent loop cases to crates/fixtures/loop/`);
