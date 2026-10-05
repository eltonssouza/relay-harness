import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { beforeAll, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => childProcessMocks);

import { shareSession } from "../src/modes/interactive/session-share.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("shareSession", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps concurrent session exports isolated", async () => {
		const uploads: string[] = [];
		childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
			uploads.push(readFileSync(args.at(-1)!, "utf8"));
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			});
			queueMicrotask(() => {
				child.stdout.end(`https://gist.github.com/test/${uploads.length}\n`);
				child.stderr.end();
				child.emit("close", 0);
			});
			return child;
		});

		const aWritten = deferred();
		const bWritten = deferred();
		const releaseB = deferred();
		const errors: string[] = [];
		const context = (name: "A" | "B") => ({
			session: {
				sessionManager: {
					getSessionId: () => name,
					getCwd: () => "/tmp",
					getBranch: () => [],
				},
				state: { systemPrompt: name, tools: [] },
				modelRuntime: { getProvider: () => undefined },
				exportToHtml: async (filePath: string) => {
					writeFileSync(filePath, name);
					if (name === "A") {
						aWritten.resolve();
						await bWritten.promise;
					} else {
						bWritten.resolve();
						await releaseB.promise;
					}
				},
			},
			ui: { setFocus() {}, requestRender() {} },
			editorContainer: { clear() {}, addChild() {} },
			editor: {},
			showStatus() {},
			showError(message: string) {
				errors.push(message);
			},
		});

		const shareA = shareSession(context("A") as never);
		await aWritten.promise;
		const shareB = shareSession(context("B") as never);
		await bWritten.promise;
		await shareA;
		releaseB.resolve();
		await shareB;

		expect(uploads).toEqual(["A", "B"]);
		expect(errors).toEqual([]);
	});

	it("reports only the gist URL when no share viewer is configured", async () => {
		const originalViewerUrl = process.env.RELAY_SHARE_VIEWER_URL;
		delete process.env.RELAY_SHARE_VIEWER_URL;
		childProcessMocks.spawn.mockImplementation(() => {
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			});
			queueMicrotask(() => {
				child.stdout.end("https://gist.github.com/test/abc123\n");
				child.stderr.end();
				child.emit("close", 0);
			});
			return child;
		});

		const statuses: string[] = [];
		const errors: string[] = [];
		try {
			await shareSession({
				session: {
					exportToHtml: async (filePath: string) => writeFileSync(filePath, "session"),
				},
				ui: { setFocus() {}, requestRender() {} },
				editorContainer: { clear() {}, addChild() {} },
				editor: {},
				showStatus(message: string) {
					statuses.push(message);
				},
				showError(message: string) {
					errors.push(message);
				},
			} as never);
		} finally {
			if (originalViewerUrl !== undefined) process.env.RELAY_SHARE_VIEWER_URL = originalViewerUrl;
		}

		expect(errors).toEqual([]);
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toContain("Gist: ");
		expect(statuses[0]).toContain("https://gist.github.com/test/abc123");
		expect(statuses[0]).not.toContain("Share URL");
	});
});
