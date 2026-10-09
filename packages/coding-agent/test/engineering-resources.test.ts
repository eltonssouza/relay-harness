import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getEngineeringResourcesPath } from "../src/config.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import { loadAgentProfile } from "../src/extensions/engineering/index.ts";
import { AGENTS } from "../src/extensions/laya/questions.ts";
import { parseFrontmatter } from "../src/utils/frontmatter.ts";

describe("distributed engineering resources", () => {
	it("discovers all nineteen skills without diagnostics and preserves references", () => {
		const root = join(getEngineeringResourcesPath(), "skills");
		const loaded = loadSkillsFromDir({ dir: root, source: "builtin" });
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.skills).toHaveLength(19);
		expect(loaded.skills.map((skill) => skill.name)).toContain("implement-feature-tdd");
		expect(existsSync(join(root, "implement-feature-tdd", "references", "red-green-refactor.md"))).toBe(true);
	});
	it("makes all sixteen profiles selectable and loads their full role instructions", () => {
		const root = join(getEngineeringResourcesPath(), "agents");
		const files = readdirSync(root).filter((name) => name.endsWith(".md"));
		expect(files).toHaveLength(16);
		for (const file of files) {
			const { frontmatter } = parseFrontmatter(readFileSync(join(root, file), "utf8"));
			expect(AGENTS).toHaveProperty(String(frontmatter.name));
		}
		expect(loadAgentProfile("software-engineer", { cwd: root, isProjectTrusted: () => false })).toContain(
			"Test-Driven Discipline",
		);
	});
});
