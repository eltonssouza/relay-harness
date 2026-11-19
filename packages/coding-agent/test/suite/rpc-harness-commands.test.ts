import { fauxAssistantMessage } from "@relay-harness/ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

/** Send one command and wait for its response. */
async function request(command: Record<string, unknown>): Promise<Record<string, unknown>> {
	const id = `req-${Math.random().toString(36).slice(2)}`;
	rpcIo.lineHandler?.(JSON.stringify({ id, ...command }));
	let response: Record<string, unknown> | undefined;
	await vi.waitFor(() => {
		response = parseOutputLines().find((line) => line.id === id);
		expect(response).toBeDefined();
	});
	return response as Record<string, unknown>;
}

describe("RPC harness, session and settings commands", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("reads the harness state, forgets a constraint, lists sessions and reads settings", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness({ settings: { harnessCore: { verifyCommands: ["npm test"] } } });
		try {
			harness.setResponses([fauxAssistantMessage("Noted.")]);
			await harness.session.prompt("Never edit the tests.");
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			const state = await request({ type: "get_harness_state" });
			expect(state).toMatchObject({ success: true, command: "get_harness_state" });
			const data = state.data as {
				constraints: Array<{ id: string; text: string }>;
				verifyCommands: string[];
				engine: string;
			};
			expect(data.constraints.map((constraint) => constraint.text)).toEqual(["Never edit the tests."]);
			expect(data.verifyCommands).toEqual(["npm test"]);
			expect(data.engine).toBe("rust");

			expect((await request({ type: "harness_forget", constraintId: data.constraints[0].id })).data).toEqual({
				removed: true,
			});
			expect((await request({ type: "harness_forget", constraintId: "c99" })).data).toEqual({ removed: false });
			const after = (await request({ type: "get_harness_state" })).data as { constraints: unknown[] };
			expect(after.constraints).toEqual([]);
			expect(await request({ type: "harness_clear" })).toMatchObject({ success: true, command: "harness_clear" });

			const sessions = await request({ type: "list_sessions" });
			expect(sessions).toMatchObject({ success: true, command: "list_sessions" });
			expect(Array.isArray((sessions.data as { sessions: unknown }).sessions)).toBe(true);

			const settings = (await request({ type: "get_settings" })).data as {
				settings: { harnessCore?: { verifyCommands?: string[] } };
			};
			expect(settings.settings.harnessCore?.verifyCommands).toEqual(["npm test"]);

			const defaults = (await request({ type: "get_harness_settings" })).data as Record<string, unknown>;
			expect(defaults).toMatchObject({ evidence: true, contextKeepRecent: 6, verifyCommands: ["npm test"] });
			const changed = await request({ type: "set_harness_setting", key: "evidence", value: false });
			expect(changed).toMatchObject({ success: true, data: { evidence: false } });
			expect(harness.settingsManager.getHarnessCoreSettings().evidence).toBe(false);
			expect(await request({ type: "set_harness_setting", key: "contextBatchSize", value: 0 })).toMatchObject({
				success: false,
				error: "harnessCore.contextBatchSize must be an integer of at least 1",
			});
			expect(
				await request({ type: "set_harness_setting", key: "verifyCommands", value: ["npm test", ""] }),
			).toMatchObject({
				success: false,
				error: "harnessCore.verifyCommands must be a list of commands",
			});
			expect(await request({ type: "set_harness_setting", key: "shellPath", value: "/bin/sh" })).toMatchObject({
				success: false,
				error: "harnessCore.shellPath is not a harness setting",
			});
			expect(harness.settingsManager.getHarnessCoreSettings().contextBatchSize).toBe(6);
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});

describe("RpcClient harness, session and settings methods", () => {
	test("send the matching commands", async () => {
		const client = new RpcClient();
		const sent: unknown[] = [];
		const data: Record<string, unknown> = {
			get_harness_state: { constraints: [] },
			harness_forget: { removed: true },
			list_sessions: { sessions: [] },
			get_settings: { settings: { theme: "dark" } },
			get_harness_settings: { evidence: true },
			set_harness_setting: { evidence: false },
		};
		const privateClient = client as unknown as {
			send: (command: { type: string }) => Promise<unknown>;
			getData: <T>(response: unknown) => T;
		};
		privateClient.send = async (command) => {
			sent.push(command);
			return { type: "response", command: command.type, success: true, data: data[command.type] };
		};
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;

		expect(await client.getHarnessState()).toEqual({ constraints: [] });
		expect(await client.harnessForget("c1")).toBe(true);
		await client.harnessClear();
		expect(await client.listSessions()).toEqual([]);
		expect(await client.getSettings()).toEqual({ theme: "dark" });
		expect(await client.getHarnessSettings()).toEqual({ evidence: true });
		expect(await client.setHarnessSetting("evidence", false)).toEqual({ evidence: false });
		expect(sent).toEqual([
			{ type: "get_harness_state" },
			{ type: "harness_forget", constraintId: "c1" },
			{ type: "harness_clear" },
			{ type: "list_sessions" },
			{ type: "get_settings" },
			{ type: "get_harness_settings" },
			{ type: "set_harness_setting", key: "evidence", value: false },
		]);
	});
});
