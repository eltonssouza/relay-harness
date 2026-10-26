import { describe, expect, it } from "vitest";
import { auditSkill } from "../src/core/skill-audit.ts";

describe("skill audit", () => {
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
