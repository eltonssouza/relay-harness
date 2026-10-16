import { describe, expect, it } from "vitest";
import { isTestCommand } from "../src/core/delegation/test-command.ts";

describe("delegation test evidence", () => {
	it.each([
		"node --test test/result.test.mjs",
		"node node_modules/vitest/dist/cli.js --run test/result.test.ts",
		"cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/unit.test.ts",
		"npm run test:unit",
		"./test.sh",
		"python -m pytest tests",
	])("recognizes observed runner invocation %s", (command) => {
		expect(isTestCommand(command, "bash")).toBe(true);
	});
	it.each([
		"echo 'node --test test/result.test.mjs'",
		"npm test || true",
		"npm test | cat",
		"node --test test/result.test.mjs; echo success",
		"node script.mjs --test",
		"node --eval 'console.log(1)' --test",
		"node node_modules/vitest/dist/cli.js list",
		"npx vitest --run --help",
		"npx vitest --run --listTests=true",
		"python -m pytest --collect-only",
	])("rejects non-validation or masked invocation %s", (command) => {
		expect(isTestCommand(command, "bash")).toBe(false);
	});
	it("handles a directly invoked runner and setup in PowerShell", () => {
		expect(isTestCommand('& "C:\\Program Files\\nodejs\\node.exe" --test test/unit.test.mjs', "powershell")).toBe(
			true,
		);
		expect(isTestCommand("Set-Location packages/coding-agent; node --test test/unit.test.mjs", "powershell")).toBe(
			true,
		);
	});
});
