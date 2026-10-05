import { describe, expect, it } from "vitest";
import { getRelayUserAgent } from "../src/utils/relay-user-agent.ts";

describe("getRelayUserAgent", () => {
	it("formats the user agent expected by pi.dev", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getRelayUserAgent("1.2.3");

		expect(userAgent).toBe(`relay/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^relay\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
