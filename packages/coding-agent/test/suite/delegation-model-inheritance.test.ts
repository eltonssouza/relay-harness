import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@relay-harness/agent-core";
import { fauxAssistantMessage } from "@relay-harness/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDelegationExtension } from "../../src/extensions/delegation/index.ts";
import { call, latest, scriptedClassification, tasks } from "../delegation-integration-support.ts";
import { delegationTestHealth, delegationTestProvider } from "../delegation-test-support.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

describe("delegated model inheritance", () => {
	const harnesses: Harness[] = [];
	beforeEach(() =>
		vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response(JSON.stringify(delegationTestHealth()))),
	);
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	async function setup(missingPhysicalModel = false) {
		let directory = "";
		const routes: string[] = [];
		const missingLookups: string[][] = [];
		const readSchema = Type.Object({ path: Type.String() });
		const read: AgentTool<typeof readSchema> = {
			name: "read",
			label: "Read",
			description: "Read task inputs",
			parameters: readSchema,
			execute: async (_id, args) => ({
				content: [{ type: "text", text: readFileSync(join(directory, args.path), "utf8") }],
				details: {},
			}),
		};
		const harness = await createHarness({
			models: [{ id: "initial-model" }, { id: "request-model" }],
			settings: { harnessCore: { evidence: false } },
			tools: [read],
			extensionFactories: [
				delegationTestProvider(scriptedClassification),
				createDelegationExtension({ enabled: true }),
				(relay) => {
					relay.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						route(request, ctx) {
							routes.push(request.reason);
							return {
								model: ctx.modelRegistry.find(
									"faux",
									request.reason === "user" ? "initial-model" : "request-model",
								)!,
								thinkingLevel: "off",
							};
						},
					});
					relay.on("tool_call", (event, ctx) => {
						if (!missingPhysicalModel || event.toolName !== "execute_work") return;
						vi.spyOn(ctx.modelRegistry, "find").mockImplementationOnce((provider, id) => {
							missingLookups.push([provider, id]);
							return undefined;
						});
					});
				},
			],
		});
		harnesses.push(harness);
		directory = harness.tempDir;
		writeFileSync(join(directory, "input.txt"), "42\n");
		mkdirSync(join(directory, ".relay", "agents"), { recursive: true });
		writeFileSync(
			join(directory, ".relay", "agents", "backend-engineer.md"),
			"---\ntools: [read]\n---\nInspect the assigned inputs and report observed evidence.\n",
		);
		await harness.session.bindExtensions({});
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		await harness.session.setModel(runtime.getModel("router", "auto")!);
		return { harness, routes, missingLookups };
	}

	it("inherits the physical model of the current principal request without routing the worker", async () => {
		const { harness, routes } = await setup();
		const dispatched: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model) => {
				dispatched.push(`proposal:${model.id}`);
				return call("propose_work", { tasks: tasks().filter((task) => task.taskId === "api") });
			},
			(_context, _options, _state, model) => {
				dispatched.push(`execution:${model.id}`);
				return call("execute_work", { taskIds: ["api"] });
			},
			(_context, _options, _state, model) => {
				dispatched.push(`worker-read:${model.id}`);
				return call("read", { path: "input.txt" });
			},
			(_context, _options, _state, model) => {
				dispatched.push(`worker-report:${model.id}`);
				return fauxAssistantMessage("Observed input: 42.");
			},
			call("review_work", { taskId: "api", accepted: true, reason: "Observed input satisfies the criterion" }),
			call("complete_work", { summary: "Delivered the observed input", evidenceIds: [] }),
			fauxAssistantMessage("Delivered."),
		]);
		await harness.session.prompt("Inspect the API input using the current physical model.");
		expect(latest(harness).status).toBe("completed");
		expect(dispatched).toEqual([
			"proposal:initial-model",
			"execution:request-model",
			"worker-read:request-model",
			"worker-report:request-model",
		]);
		expect(routes).toEqual(["user", "continuation", "continuation", "continuation", "continuation"]);
		expect(harness.session.model).toMatchObject({ provider: "router", id: "auto" });
		expect(latest(harness).delegation?.runs[0].result).toMatchObject({
			accepted: true,
			evidence: [{ tool: "read", isError: false, text: "42\n" }],
		});
	});

	it("rejects worker execution when the principal physical model is unavailable", async () => {
		const { harness, missingLookups } = await setup(true);
		harness.setResponses([
			call("propose_work", { tasks: tasks().filter((task) => task.taskId === "api") }),
			call("execute_work", { taskIds: ["api"] }),
			fauxAssistantMessage("The principal model is unavailable.", { stopReason: "error" }),
		]);
		await harness.session.prompt("Inspect the API input without substituting another model.");
		expect(missingLookups).toEqual([["faux", "request-model"]]);
		expect(getToolResult(harness, "execute_work")).toMatchObject({
			isError: true,
			content: [{ text: expect.stringContaining("physical model is unavailable") }],
		});
		expect(latest(harness).delegation?.runs).toEqual([]);
		expect(harness.eventsOfType("tool_execution_start").filter((event) => event.toolName === "read")).toEqual([]);
	});
});
