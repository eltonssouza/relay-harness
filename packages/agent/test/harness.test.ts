import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import {
	AlignmentPolicy,
	auditSkill,
	ContextWindowPolicy,
	classifyCommand,
	EvidenceLedger,
	extractConstraints,
	HarnessCore,
	type HarnessCoreEvent,
	isCorrection,
	isQuestionOnly,
	SkillUsageTracker,
	SliceDiscipline,
	type WorkspaceProbe,
} from "../src/harness/index.ts";
import type { AgentMessage, AgentTool, AgentToolCall, StreamFn } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		// Fixed, so transcripts built at different times compare equal.
		timestamp: 0,
	};
}

function call(id: string, name: string, args: Record<string, string>): AgentToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function toolResult(id: string, name: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}

/** Stream function answering with scripted responses, recording each request's transcript. */
function scripted(responses: AssistantMessage["content"][], requests: TranscriptContext[]): StreamFn {
	return (_model, context) => {
		requests.push(context);
		const content = responses[requests.length - 1] ?? [{ type: "text", text: "(no more responses)" }];
		const stream = new MockAssistantStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant(content) }));
		return stream;
	};
}

function tool(name: string, isError = false): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async () => ({ content: [{ type: "text", text: `${name} ok` }], details: {}, isError }),
	};
}

function lastText(context: TranscriptContext): string {
	const last = context.messages.at(-1);
	if (!last || (last.role !== "user" && last.role !== "toolResult")) return "";
	return typeof last.content === "string"
		? last.content
		: last.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

describe("effects", () => {
	it("classifies destructive, external, verification, and plain commands", () => {
		expect(classifyCommand("git reset --hard HEAD~1").kind).toBe("destructive");
		expect(classifyCommand("git push --force origin main").kind).toBe("destructive");
		expect(classifyCommand("git push origin main").kind).toBe("external");
		expect(classifyCommand("rm -rf dist").kind).toBe("destructive");
		expect(classifyCommand("Remove-Item -Recurse -Force build").kind).toBe("destructive");
		expect(classifyCommand("npm publish").kind).toBe("external");
		expect(classifyCommand("git rebase --continue").kind).not.toBe("destructive");
		expect(classifyCommand("npm run check").kind).toBe("verify");
		expect(classifyCommand("npx vitest --run test/a.test.ts").kind).toBe("verify");
		expect(classifyCommand("git status").kind).toBe("execute");
	});

	it("does not count a check whose exit code is masked", () => {
		expect(classifyCommand("npm run check 2>&1 | tail -20").kind).toBe("execute");
		// With pipefail, a failing check still fails the pipeline.
		expect(classifyCommand("set -o pipefail; npm test | tee log.txt").kind).toBe("verify");
		expect(classifyCommand("npm test || true").kind).toBe("execute");
		expect(classifyCommand("npm test; echo done").kind).toBe("execute");
		expect(classifyCommand("cd packages/agent && npm test").kind).toBe("verify");
		expect(classifyCommand("npm test && echo ok").kind).toBe("verify");
		expect(classifyCommand("npm run build; npm test").kind).toBe("verify");
	});

	it("counts only the project's declared commands when they are set", () => {
		const declared = ["npm run check", "./test.sh"];
		expect(classifyCommand("npm run check", declared).kind).toBe("verify");
		expect(classifyCommand("cd repo &&  npm   run check", declared).kind).toBe("verify");
		expect(classifyCommand("./test.sh packages/agent", declared).kind).toBe("verify");
		expect(classifyCommand("npx tsc --noEmit", declared).kind).toBe("execute");
		expect(classifyCommand("npm run check | tail", declared).kind).toBe("execute");
	});
});

describe("slices", () => {
	function fakeProbe(files: Map<string, number>, changed: Map<string, number>): WorkspaceProbe {
		return {
			changedLines: async () => new Map(changed),
			fileLines: async (path) => files.get(path),
		};
	}

	it("measures changes against the request's baseline and flags a large slice", async () => {
		const changed = new Map([["old.ts", 40]]);
		let measurements = 0;
		const probe = fakeProbe(new Map(), changed);
		const slices = new SliceDiscipline({
			probe: {
				...probe,
				changedLines: () => {
					measurements++;
					return probe.changedLines();
				},
			},
			maxChangedLines: 100,
		});
		slices.beginRequest();
		// A request that changes nothing measures nothing.
		expect(measurements).toBe(0);
		await slices.beforeChange("1", []);
		changed.set("a.ts", 70);
		await slices.afterChange("1", [], false);
		await slices.refresh();
		expect(slices.status()).toMatchObject({ changedLines: 70, changedFiles: 1 });
		expect(slices.render()).toBeUndefined();
		await slices.beforeChange("2", []);
		changed.set("old.ts", 80);
		await slices.afterChange("2", [], false);
		await slices.refresh();
		expect(slices.status()).toMatchObject({ changedLines: 110, changedFiles: 2 });
		expect(slices.render()).toContain("changed about 110 lines in 2 files");
	});

	it("stops asking for change size where it cannot be measured", async () => {
		let measurements = 0;
		const slices = new SliceDiscipline({
			probe: {
				changedLines: async () => {
					measurements++;
					return undefined;
				},
				fileLines: async () => undefined,
			},
		});
		for (const id of ["1", "2", "3"]) {
			slices.beginRequest();
			await slices.beforeChange(id, []);
			await slices.afterChange(id, [], false);
			await slices.refresh();
		}
		expect(measurements).toBe(1);
	});

	it("flags a file that crosses the guideline or grows a lot, not a small edit to a large file", async () => {
		const files = new Map([
			["big.ts", 1500],
			["grow.ts", 900],
		]);
		const slices = new SliceDiscipline({ probe: fakeProbe(files, new Map()), maxFileLines: 1000 });
		slices.beginRequest();
		await slices.beforeChange("1", ["big.ts"]);
		files.set("big.ts", 1520);
		await slices.afterChange("1", ["big.ts"], false);
		expect(slices.render()).toBeUndefined();

		await slices.beforeChange("2", ["grow.ts"]);
		files.set("grow.ts", 1100);
		await slices.afterChange("2", ["grow.ts"], false);
		expect(slices.render()).toContain("grow.ts now has 1100 lines");

		await slices.beforeChange("3", ["big.ts"]);
		files.set("big.ts", 1800);
		await slices.afterChange("3", ["big.ts"], false);
		expect(slices.status().oversizedFiles.get("big.ts")).toBe(1800);
	});
});

describe("alignment", () => {
	it("extracts standing constraints in English and Portuguese, not questions or embedded blocks", () => {
		expect(
			extractConstraints(
				[
					"Refactor the parser. Never use any in the new code.",
					"Não altere os testes existentes.",
					"Use pnpm instead of npm.",
					"Why does it fail?",
					'<skill name="x" location="y">\nAlways do the skill thing.\n</skill>',
				].join("\n"),
			),
		).toEqual(["Never use any in the new code.", "Não altere os testes existentes.", "Use pnpm instead of npm."]);
	});

	it("tells questions from change requests", () => {
		expect(isQuestionOnly("Why does the build fail on Windows?")).toBe(true);
		expect(isQuestionOnly("Por que o teste falha?")).toBe(true);
		expect(isQuestionOnly("Can you fix the failing test?")).toBe(false);
		expect(isQuestionOnly("Corrija o teste que falha.")).toBe(false);
	});

	it("blocks unauthorized external effects and grants them after an affirmative answer", async () => {
		const policy = new AlignmentPolicy();
		const push = { kind: "external" as const, paths: [], command: "git push origin main", reason: "push" };
		policy.observeDeveloperMessage("Fix the typo in README.md");
		const blocked = await policy.check("bash", push);
		expect(blocked).toMatchObject({ action: "block", kind: "authorization" });
		expect(policy.pendingAuthorizations()).toHaveLength(1);

		policy.observeDeveloperMessage("yes");
		expect(await policy.check("bash", push)).toEqual({ action: "allow", via: "grant" });
		// The grant is one-shot.
		expect((await policy.check("bash", push)).action).toBe("block");
	});

	it("does not grant on an answer with reservations", async () => {
		const policy = new AlignmentPolicy();
		const push = { kind: "external" as const, paths: [], command: "git push", reason: "push" };
		policy.observeDeveloperMessage("Fix it");
		await policy.check("bash", push);
		policy.observeDeveloperMessage("sim, mas não faça push ainda");
		expect((await policy.check("bash", push)).action).toBe("block");
	});

	it("authorizes operations the request names, with targets for deletions", async () => {
		const policy = new AlignmentPolicy();
		policy.observeDeveloperMessage("Commit and push the branch.");
		expect(await policy.check("bash", { kind: "external", paths: [], command: "git push -u origin feat" })).toEqual({
			action: "allow",
			via: "request",
		});
		expect((await policy.check("bash", { kind: "destructive", paths: [], command: "git push --force" })).action).toBe(
			"block",
		);

		policy.observeDeveloperMessage("Push it, but not with force.");
		expect((await policy.check("bash", { kind: "external", paths: [], command: "git push" })).action).toBe("allow");
		expect((await policy.check("bash", { kind: "destructive", paths: [], command: "git push -f" })).action).toBe(
			"block",
		);

		policy.observeDeveloperMessage("Remove the unused import in parser.ts");
		expect((await policy.check("bash", { kind: "destructive", paths: [], command: "rm -rf dist" })).action).toBe(
			"block",
		);
		policy.observeDeveloperMessage("Apague o diretório dist antes do build");
		expect((await policy.check("bash", { kind: "destructive", paths: [], command: "rm -rf dist" })).action).toBe(
			"allow",
		);
	});

	it("uses the authorizer when one is configured", async () => {
		const asked: string[] = [];
		const policy = new AlignmentPolicy({
			authorize: (request) => {
				asked.push(request.fingerprint);
				return request.effect.command === "npm publish";
			},
		});
		policy.observeDeveloperMessage("Prepare the release notes");
		expect(await policy.check("bash", { kind: "external", paths: [], command: "npm publish" })).toEqual({
			action: "allow",
			via: "authorizer",
		});
		expect((await policy.check("bash", { kind: "external", paths: [], command: "docker push img" })).action).toBe(
			"block",
		);
		expect(asked).toEqual(["bash:npm publish", "bash:docker push img"]);
	});

	it("recognizes corrections without mistaking ordinary openings for them", () => {
		expect(isCorrection("Não, simplifica. Quatro estados: pending, sending, sent, unknown.")).toBe(true);
		expect(isCorrection("Para, isso tá ficando complicado demais")).toBe(true);
		expect(isCorrection("That's too complex; use a single flag.")).toBe(true);
		expect(isCorrection("Actually, use the existing client.")).toBe(true);
		expect(isCorrection("Para o módulo de email, adicione retry.")).toBe(false);
		expect(isCorrection("Não sei por que o teste falha.")).toBe(false);
		expect(isCorrection("No-op changes are fine here.")).toBe(false);
	});

	it("records corrections only after the agent has worked, and restates the latest one", () => {
		const policy = new AlignmentPolicy();
		const recorded: number[] = [];
		policy.onCorrection = (corrections) => recorded.push(corrections.length);
		policy.observeDeveloperMessage("Não, quero um CLI.", 1, false);
		expect(policy.corrections()).toEqual([]);
		policy.observeDeveloperMessage("Não, simplifica: na dúvida, não reenvia.", 2, true);
		expect(policy.corrections()).toEqual([{ text: "Não, simplifica: na dúvida, não reenvia.", timestamp: 2 }]);
		expect(recorded).toEqual([1]);
		expect(policy.renderCorrection()).toContain("corrects your previous approach");
		policy.observeDeveloperMessage("Ok, agora rode os testes.", 3, true);
		expect(policy.renderCorrection()).toBeUndefined();
	});

	it("blocks only the first edit in a question-only turn", async () => {
		const policy = new AlignmentPolicy();
		policy.observeDeveloperMessage("Why is the cache invalidated on every request?");
		const edit = { kind: "write" as const, paths: ["src/cache.ts"] };
		expect(await policy.check("edit", edit)).toMatchObject({ action: "block", kind: "scope" });
		expect((await policy.check("edit", edit)).action).toBe("allow");
		policy.observeDeveloperMessage("Fix it.");
		expect((await policy.check("edit", edit)).action).toBe("allow");
	});
});

describe("evidence", () => {
	const edit = { kind: "write" as const, paths: ["src/a.ts"] };
	const test = { kind: "verify" as const, paths: [], command: "npm test" };

	it("flags completion claims without a passing check after the last change", () => {
		const ledger = new EvidenceLedger();
		ledger.beginRequest(true);
		ledger.recordToolOutcome(test, false);
		ledger.recordToolOutcome(edit, false);
		const report = ledger.assess("Done. The parser is fixed.");
		expect(report.status).toBe("unverified");
		expect(ledger.shouldGate(report)).toBe(true);
		// One gate per request by default.
		expect(ledger.shouldGate(ledger.assess("Done."))).toBe(false);
	});

	it("accepts claims backed by a passing check", () => {
		const ledger = new EvidenceLedger();
		ledger.beginRequest(true);
		ledger.recordToolOutcome(edit, false);
		ledger.recordToolOutcome(test, false);
		expect(ledger.assess("Implemented and all tests pass.").status).toBe("verified");
	});

	it("detects contradicted check claims, no-effect claims, and acknowledged gaps", () => {
		const ledger = new EvidenceLedger();
		ledger.beginRequest(true);
		ledger.recordToolOutcome(edit, false);
		ledger.recordToolOutcome(test, true);
		expect(ledger.assess("Fixed, tests pass.").status).toBe("contradicted");
		expect(ledger.assess("Fixed the code, but tests still fail.").status).toBe("acknowledged");

		ledger.beginRequest(true);
		ledger.recordToolOutcome({ kind: "read", paths: ["src/a.ts"] }, false);
		expect(ledger.assess("Pronto, corrigido.").status).toBe("no-effect");

		// A command may have done the work unseen, so only a read-only trajectory is no-effect.
		ledger.beginRequest(true);
		ledger.recordToolOutcome({ kind: "execute", paths: [], command: "./generate.sh" }, false);
		expect(ledger.assess("Done.").status).toBe("no-claim");

		ledger.beginRequest(false);
		expect(ledger.assess("It works like this: ...").status).toBe("no-claim");
	});

	it("does not accept a name-filtered run as evidence that all tests pass", () => {
		const ledger = new EvidenceLedger();
		ledger.beginRequest(true);
		ledger.recordToolOutcome(edit, false);
		ledger.recordToolOutcome(
			{ kind: "verify", paths: [], command: 'npx vitest --run test/a.test.ts -t "new case"' },
			false,
		);
		expect(ledger.assess("Fixed; all tests pass.").status).toBe("contradicted");
		// A claim about the filtered test itself is supported.
		expect(ledger.assess("Fixed; the new test passes.").status).toBe("verified");
		ledger.recordToolOutcome({ kind: "verify", paths: [], command: "npx vitest --run test/a.test.ts" }, false);
		expect(ledger.assess("Fixed; all tests pass.").status).toBe("verified");
	});

	it("needs no check for documentation-only changes", () => {
		const ledger = new EvidenceLedger();
		ledger.beginRequest(true);
		ledger.recordToolOutcome({ kind: "write", paths: ["README.md"] }, false);
		expect(ledger.assess("Done, README updated.").status).toBe("verified");
	});
});

describe("context", () => {
	function transcript(results: number, size: number): AgentMessage[] {
		const messages: AgentMessage[] = [{ role: "user", content: "go", timestamp: 0 }];
		for (let index = 0; index < results; index++) {
			const id = `t${index}`;
			messages.push(assistant([call(id, "read", { path: `src/f${index}.ts` })]));
			messages.push(toolResult(id, "read", "x".repeat(size)));
		}
		return messages;
	}

	it("keeps the recent window and elides aged results in batches", () => {
		const policy = new ContextWindowPolicy({ keepRecent: 2, batchSize: 3, minElideChars: 100 });
		// Two aged results: below the batch size, nothing changes.
		const small = transcript(4, 500);
		expect(policy.transform(small)).toBe(small);

		const messages = transcript(5, 500);
		const projected = policy.transform(messages);
		const texts = projected.filter((message) => message.role === "toolResult").map((message) => message.content);
		expect(texts.slice(0, 3).every((content) => JSON.stringify(content).includes("[harness:context]"))).toBe(true);
		expect(texts.slice(3).every((content) => JSON.stringify(content).includes("xxxx"))).toBe(true);
		expect(policy.getStats()).toMatchObject({ elidedResults: 3, batches: 1 });

		// Between batches the projected prefix is stable: the same stubs, no new elisions.
		const next = policy.transform(transcript(6, 500));
		expect(next.slice(0, projected.length - 4)).toEqual(projected.slice(0, projected.length - 4));
		expect(policy.getStats().elidedResults).toBe(3);
		expect(policy.renderProgress()).toContain("read src/f0.ts: ok");
	});

	it("never elides small results and marks stale reads", () => {
		const policy = new ContextWindowPolicy({ keepRecent: 1, batchSize: 1, minElideChars: 100 });
		const messages: AgentMessage[] = [
			assistant([call("r", "read", { path: "src/a.ts" })]),
			toolResult("r", "read", "y".repeat(300)),
			assistant([call("s", "read", { path: "src/b.ts" })]),
			toolResult("s", "read", "tiny"),
			assistant([call("e", "edit", { path: "src/a.ts" })]),
			toolResult("e", "edit", "edited"),
		];
		const projected = policy.transform(messages);
		expect(JSON.stringify(projected[1])).toContain("stale");
		expect(projected[3]).toBe(messages[3]);
	});
});

describe("skills", () => {
	it("measures fanout and effective uptake of skill resources", () => {
		const tracker = new SkillUsageTracker({
			skills: () => [{ name: "pdf", baseDir: "/skills/pdf", filePath: "/skills/pdf/SKILL.md" }],
		});
		tracker.beginRun();
		tracker.recordToolCall({ kind: "read", paths: ["/skills/pdf/SKILL.md"] }, false);
		tracker.recordToolCall({ kind: "read", paths: ["/skills/pdf/references/forms.md"] }, false);
		tracker.recordToolCall({ kind: "write", paths: ["out.pdf"] }, false);
		tracker.recordToolCall(
			{ kind: "execute", paths: [], command: "python /skills/pdf/scripts/fill.py out.pdf" },
			false,
		);
		tracker.recordToolCall({ kind: "read", paths: ["/skills/pdf/references/forms.md"] }, false);
		const report = tracker.report();
		expect(report.events.map((event) => [event.resource, event.kind])).toEqual([
			["SKILL.md", "entry"],
			["references/forms.md", "reference"],
			["scripts/fill.py", "script"],
			["references/forms.md", "reference"],
		]);
		expect(report.skills[0]).toMatchObject({ skill: "pdf", events: 4, fanout: 3, revisits: 1 });
		// The last reference load has no action after it.
		expect(report.skills[0].effectiveUptake).toBe(0.75);
	});

	it("audits skill structure for progressive disclosure", () => {
		const entry = [
			"# PDF",
			"When filling forms, read [forms](references/forms.md).",
			"See `references/api.md`.",
			"Use [missing](references/missing.md) for edge cases.",
		].join("\n");
		const findings = auditSkill(entry, ["references/forms.md", "references/api.md", "scripts/orphan.py"]);
		expect(findings.map((finding) => [finding.code, finding.resource])).toEqual([
			["reference-without-trigger", "references/api.md"],
			["missing-resource", "references/missing.md"],
			["unreferenced-resource", "scripts/orphan.py"],
		]);
		expect(auditSkill("x\n".repeat(400), []).map((finding) => finding.code)).toEqual(["monolithic-entry"]);
		const routed = "When filling forms, read [forms](references/forms.md).\n";
		expect(auditSkill(routed + "x\n".repeat(400), ["references/forms.md"]).map((finding) => finding.code)).toEqual([
			"oversized-entry",
		]);
	});

	it("does not treat output paths in code spans as skill resources", () => {
		const entry = "Write the report to `docs/audit/report.pdf`. Before step 3, read `references/categories.md`.";
		expect(auditSkill(entry, ["references/categories.md"])).toEqual([]);
	});

	it("flags descriptions over the character limit", () => {
		const entry = (description: string) => `---\nname: x\ndescription: "${description}"\n---\n# X\n`;
		expect(auditSkill(entry("Use when filling PDF forms."), []).map((finding) => finding.code)).toEqual([]);
		expect(auditSkill(entry("y".repeat(301)), []).map((finding) => finding.code)).toEqual(["description-too-long"]);
	});
});

describe("HarnessCore on an Agent", () => {
	it("sends one verification request when completion is claimed without evidence", async () => {
		const requests: TranscriptContext[] = [];
		const events: HarnessCoreEvent[] = [];
		const agent = new Agent({
			initialState: { systemPrompt: "test", tools: [tool("edit"), tool("bash")] },
			streamFn: scripted(
				[
					[call("1", "edit", { path: "src/a.ts" })],
					[{ type: "text", text: "Done, the bug is fixed." }],
					[call("2", "bash", { command: "npm test" })],
					[{ type: "text", text: "Fixed; all tests pass." }],
				],
				requests,
			),
		});
		new HarnessCore({ onEvent: (event) => events.push(event) }).install(agent);

		await agent.prompt("Fix the bug in src/a.ts");

		expect(requests).toHaveLength(4);
		expect(lastText(requests[2])).toContain("[harness:evidence] Completion check");
		const statuses = events.flatMap((event) => (event.type === "completion_assessed" ? [event.report.status] : []));
		expect(statuses).toEqual(["unverified", "verified"]);
	});

	it("blocks an unauthorized push and restates constraints next to the latest message", async () => {
		const requests: TranscriptContext[] = [];
		const agent = new Agent({
			initialState: { systemPrompt: "test", tools: [tool("bash")] },
			streamFn: scripted(
				[
					[call("1", "bash", { command: "git push origin main" })],
					[{ type: "text", text: "I need approval to push." }],
				],
				requests,
			),
		});
		new HarnessCore().install(agent);

		await agent.prompt("Update the changelog. Never commit without asking.");

		const result = agent.state.messages.find((message) => message.role === "toolResult");
		expect(result?.role === "toolResult" && result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("Blocked by the harness alignment policy");
		expect(lastText(requests[0])).toContain("Never commit without asking.");
		expect(lastText(requests[1])).toContain("<harness_state>");
		// The stored transcript keeps the developer's message unchanged.
		const prompt = agent.state.messages.find((message) => message.role === "user");
		expect(JSON.stringify(prompt)).not.toContain("harness_state");
	});

	it("tells the agent to close the slice when a request changes too much", async () => {
		const requests: TranscriptContext[] = [];
		const changed = new Map<string, number>();
		const agent = new Agent({
			initialState: { systemPrompt: "test", tools: [tool("edit")] },
			streamFn: scripted(
				[[call("1", "edit", { path: "src/a.ts" })], [{ type: "text", text: "Continuing with the next part." }]],
				requests,
			),
		});
		agent.subscribe((event) => {
			// The edit "writes" 600 lines.
			if (event.type === "tool_execution_end") changed.set("src/a.ts", 600);
		});
		new HarnessCore({
			evidence: false,
			slices: { probe: { changedLines: async () => new Map(changed), fileLines: async () => 10 } },
		}).install(agent);

		await agent.prompt("Refactor src/a.ts");

		expect(lastText(requests[0])).not.toContain("This request has changed");
		expect(lastText(requests[1])).toContain("This request has changed about 600 lines in 1 files");
	});

	it("restores the previous hooks on uninstall", () => {
		const agent = new Agent({ streamFn: scripted([], []) });
		const before = agent.beforeToolCall;
		const uninstall = new HarnessCore().install(agent);
		expect(agent.beforeToolCall).not.toBe(before);
		uninstall();
		expect(agent.beforeToolCall).toBe(before);
	});
});
