/**
 * Reference behavior of the TypeScript agent, for the Rust port to match.
 *
 * Each scenario runs an AgentSession against the faux provider and records the messages the
 * provider received on each call, the session events and the session entries. Values that differ
 * between runs and machines become placeholders (see `normalize`). The files live in
 * `crates/fixtures/scenarios/`; `parity.test.ts` fails when they no longer match the TypeScript
 * code, so a behavior change regenerates them. `--write` also writes the config values
 * (`config-value-record.ts`) to `crates/fixtures/config-values.json` and the tool-argument validation
 * (`validation-record.ts`) to `crates/fixtures/validation.json` and the file tools' outputs
 * (`tools-record.ts`) to `crates/fixtures/tools/`:
 *
 *   npm run parity:record
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Message } from "@relay-harness/ai";
import { createHarness } from "../suite/harness.ts";
import { CONFIG_VALUES_FILE, configValuesJson } from "./config-value-record.ts";
import { TOOLS_DIR, toolFiles } from "./tools-record.ts";
import { VALIDATION_FILE, validationJson } from "./validation-record.ts";

export const SCENARIOS_DIR = fileURLToPath(new URL("../../../../crates/fixtures/scenarios/", import.meta.url));

/** The coding-agent package, which the system prompt names for its documentation. */
const PACKAGE_DIR = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");

/** A fixed time for the scripted responses; `normalize` replaces every time anyway. */
const RESPONSE_TIME = 1_700_000_000_000;

export interface Scenario {
	name: string;
	description: string;
	/** Files written into the working directory before the prompt, by relative path. */
	files: Record<string, string>;
	prompt: string;
	/** The faux provider's answer to each call, in order. */
	responses: AssistantMessage[];
}

export const SCENARIOS: Scenario[] = [
	{
		name: "read-file",
		description: "The model reads a file with the read tool, then answers from its content.",
		files: { "notes.txt": "The release is on Friday.\n" },
		prompt: "When is the release? It says in notes.txt.",
		responses: [
			fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" }, { id: "call_1" })], {
				stopReason: "toolUse",
				timestamp: RESPONSE_TIME,
			}),
			fauxAssistantMessage("The release is on Friday.", { timestamp: RESPONSE_TIME }),
		],
	},
];

export interface Recording {
	scenario: Omit<Scenario, "responses">;
	/** The messages the provider received on each call. */
	requests: Message[][];
	/** Session events, without the streaming `message_update` deltas. */
	events: unknown[];
	/** The session's entries, as its file stores them. */
	session: unknown[];
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace what differs between runs and machines:
 * - the working directory and the package directory become `<cwd>` and `<package>`, with `/`
 *   between the segments that follow them, whatever the platform;
 * - times become 0 (numbers) or `<time>` (ISO strings), and session entry ids become `entry-N`;
 * - the faux provider's per-registration API id (`faux:<time>:<random>`) becomes `faux`;
 * - token counts become 0: the faux provider estimates them from the prompt's length, which
 *   includes the directories above.
 */
export function normalize(recording: Recording, cwd: string): Recording {
	const directories: Array<[string, string]> = [
		[cwd, "<cwd>"],
		[PACKAGE_DIR, "<package>"],
	];
	const paths = directories.map(([directory, placeholder]) => {
		const variants = [...new Set([directory, directory.replace(/\\/g, "/")])].map(escapeRegExp);
		return [new RegExp(`(?:${variants.join("|")})((?:[\\\\/][^\\s\\\\/"'<>()]+)*)`, "g"), placeholder] as const;
	});
	const entryIds = new Map<string, string>();
	for (const entry of recording.session as Array<{ id?: string }>) {
		if (entry.id) entryIds.set(entry.id, `entry-${entryIds.size + 1}`);
	}

	const walk = (value: unknown, key?: string): unknown => {
		if (typeof value === "string") {
			if (key === "timestamp") return "<time>";
			if ((key === "id" || key === "parentId") && entryIds.has(value)) return entryIds.get(value);
			if (/^faux:\d+:[a-z0-9]+$/.test(value)) return "faux";
			let text = value;
			for (const [pattern, placeholder] of paths) {
				text = text.replace(pattern, (_match, rest: string) => `${placeholder}${rest.replace(/\\/g, "/")}`);
			}
			return text;
		}
		if (typeof value === "number") return key === "timestamp" ? 0 : value;
		if (Array.isArray(value)) return value.map((item) => walk(item));
		if (value !== null && typeof value === "object") {
			if (key === "usage") return zeroNumbers(value);
			return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
		}
		return value;
	};
	return walk(recording) as Recording;
}

function zeroNumbers(value: unknown): unknown {
	if (typeof value === "number") return 0;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, zeroNumbers(item)]));
	}
	return value;
}

export async function record(scenario: Scenario): Promise<Recording> {
	const harness = await createHarness();
	try {
		for (const [path, content] of Object.entries(scenario.files)) {
			mkdirSync(dirname(join(harness.tempDir, path)), { recursive: true });
			writeFileSync(join(harness.tempDir, path), content);
		}
		const requests: Message[][] = [];
		harness.setResponses(
			scenario.responses.map((response) => (context) => {
				requests.push(structuredClone(context.messages));
				return response;
			}),
		);
		await harness.session.prompt(scenario.prompt);
		const { responses: _responses, ...described } = scenario;
		const recording: Recording = {
			scenario: described,
			requests,
			events: harness.events.filter((event) => event.type !== "message_update"),
			session: harness.sessionManager.getEntries(),
		};
		// Through JSON first, as the session file stores it: undefined fields disappear.
		return normalize(JSON.parse(JSON.stringify(recording)) as Recording, harness.tempDir);
	} finally {
		harness.cleanup();
	}
}

export function scenarioJson(recording: Recording): string {
	return `${JSON.stringify(recording, null, "\t")}\n`;
}

export function readScenario(name: string): string {
	return readFileSync(join(SCENARIOS_DIR, `${name}.json`), "utf8");
}

if (process.argv.includes("--write")) {
	mkdirSync(SCENARIOS_DIR, { recursive: true });
	for (const scenario of SCENARIOS) {
		writeFileSync(join(SCENARIOS_DIR, `${scenario.name}.json`), scenarioJson(await record(scenario)));
	}
	writeFileSync(CONFIG_VALUES_FILE, configValuesJson());
	writeFileSync(VALIDATION_FILE, validationJson());
	mkdirSync(TOOLS_DIR, { recursive: true });
	for (const [name, content] of Object.entries(await toolFiles())) writeFileSync(join(TOOLS_DIR, name), content);
	console.log(
		`wrote ${SCENARIOS.length} scenario(s) to ${SCENARIOS_DIR}, the config values, the tool-argument validation and the file tools`,
	);
}
