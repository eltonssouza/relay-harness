import * as durable from "@relay-harness/durable";
import * as environment from "@relay-harness/durable/env";
import * as jsonl from "@relay-harness/durable/storage/jsonl";
import * as sqlite from "@relay-harness/durable/storage/sqlite";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
