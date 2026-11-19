import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@relay-harness/ai";
import { afterEach, describe, expect, it } from "vitest";
import { deriveModelTiers, resolveTier } from "../src/core/model-tiers.ts";
import {
	type AgentDefinition,
	agentPrompt,
	DEFAULT_SUBAGENT_TOOLS,
	loadAgentCatalog,
	parseAgentDefinition,
} from "../src/extensions/subagents/definitions.ts";

const file = (frontmatter: string, body = "Body.") => `---\n${frontmatter}\n---\n${body}\n`;

describe("agent definitions", () => {
	const directories: string[] = [];
	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("maps Claude Code tools and model aliases", () => {
		const parsed = parseAgentDefinition(
			file(
				"name: go-expert\ndescription: Go code\ntools: Read, Grep, Glob, Bash, Edit, Write, Agent\nmodel: sonnet",
			),
			"go-expert.md",
		) as AgentDefinition;
		expect(parsed.tools).toEqual(["read", "grep", "find", "bash", "edit", "write", "agent"]);
		expect(parsed.model).toEqual({ kind: "tier", tier: "balanced" });
		expect(parseAgentDefinition(file("name: a\ndescription: d\nmodel: haiku"), "a.md")).toMatchObject({
			model: { kind: "tier", tier: "fast" },
			tools: DEFAULT_SUBAGENT_TOOLS,
		});
		expect(parseAgentDefinition(file("name: a\ndescription: d\nmodel: openai/gpt-5"), "a.md")).toMatchObject({
			model: { kind: "model", ref: "openai/gpt-5" },
		});
		expect(parseAgentDefinition(file("name: a\ndescription: d\ntools:\n  - read\n  - Bash"), "a.md")).toMatchObject({
			tools: ["read", "bash"],
		});
	});

	it("rejects a definition Relay cannot run, with the reason", () => {
		expect(parseAgentDefinition(file("name: a\ndescription: d\ntools: Read, WebFetch"), "a.md")).toEqual({
			filePath: "a.md",
			reason: "tool `WebFetch` is not available in Relay",
		});
		expect(parseAgentDefinition(file("name: Bad Name\ndescription: d"), "b.md")).toMatchObject({ filePath: "b.md" });
		expect(parseAgentDefinition(file("name: a"), "c.md")).toEqual({
			filePath: "c.md",
			reason: "`description` is missing",
		});
	});

	it("lets an earlier source replace a definition of the same name, and fills the placeholders", () => {
		const root = mkdtempSync(join(tmpdir(), "relay-agents-"));
		directories.push(root);
		const project = join(root, "project");
		const user = join(root, "user");
		mkdirSync(project);
		mkdirSync(user);
		writeFileSync(
			join(project, "scout.md"),
			file("name: scout\ndescription: project scout", "Run <PKG>/route.py in <ROOT>."),
		);
		writeFileSync(join(user, "scout.md"), file("name: scout\ndescription: user scout"));
		writeFileSync(join(user, "broken.md"), file("name: broken\ndescription: d\ntools: TodoWrite"));
		writeFileSync(join(user, "notes.txt"), "ignored");

		const catalog = loadAgentCatalog([
			{ directory: project, packageRoot: "/ga/01/_agents/scout", collectionRoot: "/ga" },
			{ directory: user },
		]);

		expect(catalog.agents.map((agent) => agent.description)).toEqual(["project scout"]);
		expect(catalog.rejected).toEqual([
			{ filePath: join(user, "broken.md"), reason: "tool `TodoWrite` is not available in Relay" },
		]);
		expect(agentPrompt(catalog.agents[0])).toBe("Run /ga/01/_agents/scout/route.py in /ga.");
	});
});

function model(provider: string, id: string, output: number, input = output / 5): Model<Api> {
	return { provider, id, cost: { input, output, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
}

describe("model tiers", () => {
	const catalog = [
		model("anthropic", "claude-haiku-5-5", 5),
		model("anthropic", "claude-sonnet-5-5", 15),
		model("anthropic", "claude-opus-5-5", 75),
		model("solo", "only-model", 10),
	];

	it("derives tiers from each provider's price levels", () => {
		expect(deriveModelTiers(catalog)).toEqual({
			fast: ["anthropic/claude-haiku-5-5"],
			balanced: ["anthropic/claude-sonnet-5-5"],
			strong: ["anthropic/claude-opus-5-5"],
			frontier: [],
		});
	});

	it("resolves a tier to a configured model, the session's model, or a derived one on its provider", () => {
		const [haiku, sonnet, opus] = catalog;
		const base = { catalog, isAvailable: () => true };
		expect(resolveTier("fast", { ...base, current: opus })).toBe(haiku);
		expect(resolveTier("strong", { ...base, current: opus })).toBe(opus);
		expect(
			resolveTier("fast", { ...base, current: opus, configured: { fast: ["anthropic/claude-sonnet-5-5"] } }),
		).toBe(sonnet);
		// A configured model without credentials is skipped.
		expect(
			resolveTier("fast", {
				...base,
				current: opus,
				configured: { fast: ["anthropic/claude-sonnet-5-5"] },
				isAvailable: (candidate) => candidate !== sonnet,
			}),
		).toBe(haiku);
		// A provider without tiers keeps the session's model.
		expect(resolveTier("fast", { ...base, current: catalog[3] })).toBe(catalog[3]);
	});
});
