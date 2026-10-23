import { describe, expect, it } from "vitest";
import { localOnlyAllows } from "../src/extensions/laya/index.ts";

describe("laya.localOnly", () => {
	it("allows every model when it is off", () => {
		expect(localOnlyAllows({}, { baseUrl: "https://api.anthropic.com" })).toBe(true);
		expect(localOnlyAllows({ localOnly: false }, { baseUrl: "https://api.openai.com/v1" })).toBe(true);
	});

	it("only allows loopback base URLs when it is on", () => {
		const on = { localOnly: true };
		expect(localOnlyAllows(on, { baseUrl: "http://127.0.0.1:1234/v1" })).toBe(true);
		expect(localOnlyAllows(on, { baseUrl: "http://localhost:11434" })).toBe(true);
		expect(localOnlyAllows(on, { baseUrl: "http://[::1]:8080/v1" })).toBe(true);
		expect(localOnlyAllows(on, { baseUrl: "https://api.anthropic.com" })).toBe(false);
		expect(localOnlyAllows(on, { baseUrl: "http://192.168.1.20:1234/v1" })).toBe(false);
		expect(localOnlyAllows(on, { baseUrl: "http://localhost.example.com/v1" })).toBe(false);
	});

	it("treats a missing or malformed base URL as remote, failing closed", () => {
		const on = { localOnly: true };
		expect(localOnlyAllows(on, { baseUrl: "" })).toBe(false);
		expect(localOnlyAllows(on, { baseUrl: "not a url" })).toBe(false);
	});
});
