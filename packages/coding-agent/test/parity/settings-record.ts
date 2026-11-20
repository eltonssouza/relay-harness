/**
 * Reference behavior of the settings manager (`src/core/settings-manager.ts`), for the Rust port:
 *
 * - `settings/load.json`: global and project settings files loaded with `SettingsManager.create`:
 *   the merged, global and project settings, the load errors, and every getter's answer.
 * - `settings/writes.json`: scripted setter calls on files: each call's outcome, then the files'
 *   text, the merged settings and the errors.
 *
 * The temporary directory becomes `<root>`, the home directory `<home>`, and random UUIDs
 * `<uuid>`. A JSON syntax error is recorded as `syntaxError`, since V8 words it its own way.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SettingsError, SettingsManager } from "../../src/core/settings-manager.ts";

export const SETTINGS_DIR = fileURLToPath(new URL("../../../../crates/fixtures/settings/", import.meta.url));

const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

/** A getter and its arguments. */
type Getter = [string, ...unknown[]];

const model = { provider: "anthropic", id: "claude-test" };

const GETTERS: Getter[] = [
	["getLastChangelogVersion"],
	["getSessionDir"],
	["getDefaultProvider"],
	["getDefaultModel"],
	["getSteeringMode"],
	["getFollowUpMode"],
	["getThemeSetting"],
	["getTheme"],
	["getDefaultThinkingLevel"],
	["getModelThinkingLevel", "anthropic", "claude-test"],
	["getAllModelThinkingLevels"],
	["getTransport"],
	["getCompactionEnabled"],
	["getHarnessCoreSettings"],
	["getCompactionReserveTokens"],
	["getCompactionReserveTokens", model],
	["getCompactionKeepRecentTokens"],
	["getCompactionKeepRecentTokens", model],
	["getCompactionSettings", model],
	["getBranchSummarySettings"],
	["getBranchSummarySkipPrompt"],
	["getRetryEnabled"],
	["getRetrySettings"],
	["getHttpIdleTimeoutMs"],
	["getCacheWarmingMode"],
	["getProviderRetrySettings"],
	["getWebSocketConnectTimeoutMs"],
	["getHideThinkingBlock"],
	["getShowCacheMissNotices"],
	["getExternalEditorCommand"],
	["getShellPath"],
	["getQuietStartup"],
	["getDefaultProjectTrust"],
	["getShellCommandPrefix"],
	["getNpmCommand"],
	["getCollapseChangelog"],
	["getEnableInstallTelemetry"],
	["getEnableAnalytics"],
	["getTrackingId"],
	["getPackages"],
	["getExtensionPaths"],
	["getSkillPaths"],
	["getPromptTemplatePaths"],
	["getThemePaths"],
	["getEnableSkillCommands"],
	["getThinkingBudgets"],
	["getTerminalCapabilityOverrides"],
	["getShowImages"],
	["getImageWidthCells"],
	["getClearOnShrink"],
	["getShowTerminalProgress"],
	["getTuiMode"],
	["getFullscreenExitOutput"],
	["getFullscreenScrollbar"],
	["getFullscreenCopyOnSelect"],
	["getFullscreenWheelScrollLines"],
	["getImageAutoResize"],
	["getBlockImages"],
	["getEnabledModels"],
	["getDefaultTools"],
	["getDoubleEscapeAction"],
	["getTreeFilterMode"],
	["getShowHardwareCursor"],
	["getEditorPaddingX"],
	["getOutputPad"],
	["getAutocompleteMaxVisible"],
	["getCodeBlockIndent"],
	["getMermaidRenderingMode"],
	["getWarnings"],
	["isProjectTrusted"],
];

/** Settings files: their text, or absent. */
interface LoadCase {
	name: string;
	global?: string;
	project?: string;
	untrusted?: boolean;
}

const text = (value: unknown) => JSON.stringify(value, null, 2);

const FULL_GLOBAL = {
	lastChangelogVersion: "0.5.0",
	defaultProvider: "anthropic",
	defaultModel: "claude-test",
	defaultThinkingLevel: "medium",
	modelThinkingLevels: { "anthropic/claude-test": "high", "openai/gpt": "low" },
	transport: "websocket",
	steeringMode: "all",
	followUpMode: "all",
	theme: "dark",
	compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
	harnessCore: { alignment: false, verifyCommands: ["npm test", 5, "cargo test"], maxChangedLines: 0 },
	branchSummary: { reserveTokens: 100, skipPrompt: true },
	retry: {
		enabled: false,
		maxRetries: 7,
		baseDelayMs: 10,
		maxAgentDelayMs: 20,
		provider: { timeoutMs: 5, maxRetries: 2 },
	},
	hideThinkingBlock: true,
	showCacheMissNotices: true,
	externalEditor: "code --wait",
	shellPath: "~/bin/bash",
	quietStartup: "header",
	defaultProjectTrust: "always",
	shellCommandPrefix: "shopt -s expand_aliases",
	npmCommand: ["mise", "exec", "--", "npm"],
	collapseChangelog: true,
	enableInstallTelemetry: false,
	enableAnalytics: true,
	trackingId: "tracking",
	packages: ["npm:a", { source: "git:b", autoload: false, skills: ["x"] }],
	extensions: ["ext.ts"],
	skills: ["skills"],
	prompts: ["prompts"],
	themes: ["themes"],
	enableSkillCommands: false,
	terminal: {
		showImages: false,
		imageWidthCells: 42.7,
		clearOnShrink: true,
		showTerminalProgress: true,
		images: false,
		trueColor: true,
		hyperlinks: false,
	},
	images: { autoResize: false, blockImages: true },
	enabledModels: ["anthropic/*"],
	defaultTools: ["read", "grep"],
	doubleEscapeAction: "fork",
	treeFilterMode: "user-only",
	thinkingBudgets: { low: 1000 },
	editorPaddingX: 2,
	outputPad: 0,
	autocompleteMaxVisible: 9,
	showHardwareCursor: true,
	markdown: { codeBlockIndent: "    ", mermaid: "off" },
	warnings: { anthropicExtraUsage: false },
	sessionDir: "~/sessions",
	httpIdleTimeoutMs: 1500.7,
	cacheWarming: "idle",
	websocketConnectTimeoutMs: "disabled",
	tuiMode: "regular",
	fullscreenExitOutput: "resume-hint",
	fullscreenScrollbar: "hidden",
	fullscreenCopyOnSelect: false,
	fullscreenWheelScrollLines: 400,
	unknownField: { kept: true },
};

const LOAD_CASES: LoadCase[] = [
	{ name: "no files" },
	{ name: "every global setting", global: text(FULL_GLOBAL) },
	{
		name: "project over global",
		global: text({
			theme: "dark",
			compaction: { enabled: true, reserveTokens: 100 },
			terminal: { showImages: true },
			packages: ["a"],
			defaultTools: ["read", "grep"],
			defaultProjectTrust: "always",
			cacheWarming: "idle",
		}),
		project: text({
			theme: "light",
			compaction: { keepRecentTokens: 5 },
			terminal: { showImages: false, images: "kitty" },
			packages: ["b"],
			defaultTools: ["+find", "-read"],
			defaultProjectTrust: "never",
			cacheWarming: "off",
		}),
	},
	{ name: "untrusted project", global: text({ theme: "dark" }), project: text({ theme: "light" }), untrusted: true },
	{
		name: "migrations",
		global: text({
			queueMode: "all",
			websockets: true,
			skills: { enableSkillCommands: false, customDirectories: ["~/skills"] },
			retry: { maxDelayMs: 1234, provider: { timeoutMs: 9 } },
		}),
		project: text({
			queueMode: "all",
			steeringMode: "one-at-a-time",
			websockets: false,
			transport: "sse",
			skills: { customDirectories: [] },
			retry: { maxDelayMs: 1, provider: { maxRetryDelayMs: 5 } },
		}),
	},
	{ name: "legacy websockets off", global: text({ websockets: false, retry: { maxDelayMs: "x" } }) },
	{ name: "invalid global json", global: "{ not json", project: text({ theme: "light" }) },
	{ name: "invalid project json", global: text({ theme: "dark" }), project: "[1, 2" },
	{ name: "byte order mark", global: `﻿${text({ theme: "bom" })}` },
	{ name: "empty file", global: "" },
	{ name: "a number", global: "5" },
	{ name: "null", global: "null" },
	{
		name: "invalid compaction values",
		global: text({
			compaction: { reserveTokens: -1, keepRecentTokens: 1.5, modelOverrides: { "anthropic/claude-test": 5 } },
		}),
	},
	{
		name: "compaction model overrides",
		global: text({
			compaction: {
				reserveTokens: 100,
				modelOverrides: { "anthropic/claude-test": { reserveTokens: 7, keepRecentTokens: "x" } },
			},
		}),
	},
	{
		name: "model override not an object",
		global: text({ compaction: { reserveTokens: 100, modelOverrides: { "anthropic/claude-test": "fast" } } }),
	},
	{
		name: "valid model override",
		global: text({
			compaction: { modelOverrides: { "anthropic/claude-test": { keepRecentTokens: 9007199254740991 } } },
		}),
	},
	{ name: "timeouts as text", global: text({ httpIdleTimeoutMs: " 30000 ", websocketConnectTimeoutMs: "1e3" }) },
	{ name: "invalid timeout", global: text({ httpIdleTimeoutMs: "abc", websocketConnectTimeoutMs: -5 }) },
	{ name: "empty timeout text", global: text({ httpIdleTimeoutMs: "  ", websocketConnectTimeoutMs: "0x10" }) },
	{
		name: "default tools added to the defaults",
		project: text({ defaultTools: ["+ls", "-bash", "+read", "-nothing", "+"] }),
	},
	{
		name: "default tools replaced",
		global: text({ defaultTools: ["+ls"] }),
		project: text({ defaultTools: ["grep"] }),
	},
	{
		name: "default tools not a list",
		global: text({ defaultTools: ["read"] }),
		project: text({ defaultTools: "grep" }),
	},
	{ name: "default tools empty", global: text({ defaultTools: [] }) },
	{ name: "default tools with other values", global: text({ defaultTools: ["+ls", 5, null] }) },
	{
		name: "odd values",
		global: text({
			theme: 5,
			quietStartup: "yes",
			treeFilterMode: "bogus",
			terminal: { imageWidthCells: "wide", images: "iterm2", trueColor: "auto" },
			fullscreenWheelScrollLines: -3,
			fullscreenScrollbar: "always",
			outputPad: 3,
			markdown: { mermaid: "final" },
			externalEditor: "   ",
			tuiMode: "other",
			steeringMode: "",
			cacheWarming: "sometimes",
		}),
	},
	{ name: "theme path", global: text({ theme: "themes/custom.json" }) },
	{ name: "harness settings empty", global: text({ harnessCore: {} }) },
];

/** `<root>` and `<home>` for directories, `/` after them, and `<uuid>` for random ids. */
function portable(value: unknown, root: string): unknown {
	if (typeof value === "string") {
		let result = value.split(root).join("<root>").split(homedir()).join("<home>");
		result = result.replace(/<(?:root|home)>[^"'\s]*/g, (path) => path.replaceAll("\\", "/"));
		return result.replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, "<uuid>");
	}
	if (Array.isArray(value)) return value.map((item) => portable(item, root));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item, root)]));
	}
	return value;
}

const errorsJson = (errors: SettingsError[]) =>
	errors.map((error) => ({
		scope: error.scope,
		...(error.path ? { path: error.path } : {}),
		...(error.error instanceof SyntaxError ? { syntaxError: true } : { message: error.error.message }),
	}));

/** A getter's answer: its value (`<undefined>` for none) or the error it threw. */
function answer(manager: SettingsManager, getter: Getter): unknown {
	const [name, ...args] = getter;
	const method = manager[name as keyof SettingsManager] as (...values: unknown[]) => unknown;
	try {
		const value = method.apply(manager, args);
		return { value: value === undefined ? "<undefined>" : JSON.parse(JSON.stringify(value)) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function writeFile(path: string, content: string | undefined): void {
	if (content === undefined) return;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

const fileText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "<absent>");

/** Environment variables the getters read, fixed while recording. */
function withEnvironment<T>(run: () => T): T {
	const names = ["VISUAL", "EDITOR", "RELAY_CLEAR_ON_SHRINK", "RELAY_HARDWARE_CURSOR"];
	const saved = names.map((name) => [name, process.env[name]] as const);
	for (const name of names) delete process.env[name];
	process.env.VISUAL = "visual-editor";
	try {
		return run();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function layout(): { root: string; agentDir: string; cwd: string; globalPath: string; projectPath: string } {
	const root = mkdtempSync(join(tmpdir(), "relay-settings-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	return {
		root,
		agentDir,
		cwd,
		globalPath: join(agentDir, "settings.json"),
		projectPath: join(cwd, ".relay", "settings.json"),
	};
}

function loadJson(): string {
	return withEnvironment(() =>
		json(
			LOAD_CASES.map((testCase) => {
				const { root, agentDir, cwd, globalPath, projectPath } = layout();
				try {
					writeFile(globalPath, testCase.global);
					writeFile(projectPath, testCase.project);
					const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: !testCase.untrusted });
					return portable(
						{
							...testCase,
							settings: manager.getSettings(),
							globalSettings: manager.getGlobalSettings(),
							projectSettings: manager.getProjectSettings(),
							errors: errorsJson(manager.drainErrors()),
							getters: GETTERS.map((getter) => ({ getter, ...(answer(manager, getter) as object) })),
						},
						root,
					);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		),
	);
}

/** A setter call, or a step around one. */
type Call = [string, ...unknown[]];

interface WriteCase {
	name: string;
	global?: string;
	project?: string;
	untrusted?: boolean;
	calls: Call[];
}

const WRITE_CASES: WriteCase[] = [
	{
		name: "new global file",
		calls: [
			["setDefaultModelAndProvider", "openai", "gpt-test"],
			["setTheme", "light"],
			["setSteeringMode", "all"],
			["setFollowUpMode", "all"],
			["setDefaultThinkingLevel", "high"],
			["setTransport", "sse"],
			["setLastChangelogVersion", "1.2.3"],
		],
	},
	{
		name: "nested settings keep what the file has",
		global: text({
			compaction: { reserveTokens: 5, enabled: true },
			terminal: { imageWidthCells: 10 },
			other: [1, { a: 0.0000012 }],
		}),
		calls: [
			["externalEdit", "global", { compaction: { reserveTokens: 6, keepRecentTokens: 7 }, theme: "external" }],
			["setCompactionEnabled", false],
			["setRetryEnabled", false],
			["setShowImages", false],
			["setImageWidthCells", 0.5],
			["setClearOnShrink", true],
			["setShowTerminalProgress", true],
			["setImageAutoResize", false],
			["setBlockImages", true],
			["setMermaidRenderingMode", "final"],
		],
	},
	{
		name: "project settings",
		project: text({ theme: "project", packages: ["old"] }),
		calls: [
			["setProjectPackages", ["a", { source: "b", autoload: false }]],
			["setProjectExtensionPaths", ["ext"]],
			["setProjectSkillPaths", ["skill"]],
			["setProjectPromptTemplatePaths", ["prompt"]],
			["setProjectThemePaths", ["theme"]],
			["setPackages", ["global"]],
			["setExtensionPaths", ["g-ext"]],
			["setSkillPaths", ["g-skill"]],
			["setPromptTemplatePaths", ["g-prompt"]],
			["setThemePaths", ["g-theme"]],
		],
	},
	{
		name: "untrusted project refuses writes",
		project: text({ theme: "project" }),
		untrusted: true,
		calls: [
			["setProjectPackages", ["a"]],
			["setProjectTrusted", true],
			["setProjectSkillPaths", ["s"]],
			["setProjectTrusted", false],
		],
	},
	{
		name: "model thinking levels",
		global: text({ modelThinkingLevels: { "a/b": "low" } }),
		calls: [
			["setModelThinkingLevel", "c", "d", "high"],
			["removeModelThinkingLevel", "a", "b"],
			["removeModelThinkingLevel", "c", "d"],
			["removeModelThinkingLevel", "c", "d"],
		],
	},
	{
		name: "values removed",
		global: text({ shellPath: "/bin/zsh", npmCommand: ["npm"], shellCommandPrefix: "x", enabledModels: ["a"] }),
		calls: [
			["setShellPath", undefined],
			["setNpmCommand", undefined],
			["setShellCommandPrefix", undefined],
			["setEnabledModels", undefined],
		],
	},
	{
		name: "an invalid global file is never written",
		global: "{ broken",
		calls: [
			["setTheme", "light"],
			["setDefaultModel", "m"],
		],
	},
	{
		name: "harness settings",
		global: text({ harnessCore: { evidence: false } }),
		calls: [
			["setHarnessCoreSetting", "alignment", false],
			["setHarnessCoreSetting", "contextKeepRecent", 0],
			["setHarnessCoreSetting", "contextKeepRecent", 3],
			["setHarnessCoreSetting", "maxChangedLines", 1.5],
			["setHarnessCoreSetting", "verifyCommands", ["npm test", " "]],
			["setHarnessCoreSetting", "verifyCommands", ["npm test"]],
			["setHarnessCoreSetting", "evidence", "yes"],
			["setHarnessCoreSetting", "unknown", true],
		],
	},
	{
		name: "identifiers",
		calls: [
			["setEnableAnalytics", false],
			["setEnableAnalytics", true],
			["getTrackingId"],
			["getOrCreateDeviceId"],
			["setEnableAnalytics", true],
		],
	},
	{
		name: "clamps",
		calls: [
			["setEditorPaddingX", 9],
			["setAutocompleteMaxVisible", 1],
			["setFullscreenWheelScrollLines", 500],
			["setFullscreenWheelScrollLines", "auto"],
			["setHttpIdleTimeoutMs", -1],
			["setHttpIdleTimeoutMs", 1234.9],
			["setOutputPad", 0],
			["setTuiMode", "regular"],
			["setFullscreenExitOutput", "resume-hint"],
			["setFullscreenScrollbar", "always"],
			["setFullscreenCopyOnSelect", false],
			["setDoubleEscapeAction", "none"],
			["setTreeFilterMode", "all"],
			["setShowHardwareCursor", true],
			["setCacheWarmingMode", "off"],
			["setHideThinkingBlock", true],
			["setShowCacheMissNotices", true],
			["setQuietStartup", true],
			["setDefaultProjectTrust", "never"],
			["setCollapseChangelog", true],
			["setEnableInstallTelemetry", false],
			["setEnableSkillCommands", false],
			["setWarnings", { anthropicExtraUsage: false }],
		],
	},
	{
		name: "overrides and reload",
		global: text({ theme: "dark" }),
		project: text({ defaultModel: "project-model" }),
		calls: [
			["applyOverrides", { theme: "override", compaction: { enabled: false } }],
			["getSettings"],
			["setDefaultProvider", "p"],
			["getSettings"],
			["externalEdit", "global", { theme: "reloaded" }],
			["externalEdit", "project", { defaultModel: "edited" }],
			["reload"],
			["getSettings"],
			["externalEdit", "global", "{ broken"],
			["reload"],
			["getSettings"],
		],
	},
	{
		name: "a held lock",
		global: text({ theme: "dark" }),
		calls: [
			["holdLock", "global"],
			["setTheme", "light"],
		],
	},
	{
		name: "a held lock on a new file",
		calls: [
			["holdLock", "global"],
			["setTheme", "light"],
		],
	},
	{
		name: "an existing tracking id stays",
		global: text({ trackingId: "existing" }),
		calls: [["setEnableAnalytics", true], ["getTrackingId"]],
	},
	{
		name: "written fields are not written again",
		calls: [
			["setTheme", "first"],
			["externalEdit", "global", { theme: "external", other: 1 }],
			["setDefaultModel", "m"],
		],
	},
];

function runCall(manager: SettingsManager, call: Call, paths: { globalPath: string; projectPath: string }): unknown {
	const [name, ...args] = call;
	if (name === "externalEdit") {
		const [scope, content] = args as [string, unknown];
		writeFile(
			scope === "global" ? paths.globalPath : paths.projectPath,
			typeof content === "string" ? content : text(content),
		);
		return null;
	}
	if (name === "holdLock") {
		mkdirSync(`${args[0] === "global" ? paths.globalPath : paths.projectPath}.lock`, { recursive: true });
		return null;
	}
	const method = manager[name as keyof SettingsManager] as (...values: unknown[]) => unknown;
	return method.apply(manager, args);
}

async function writesJson(): Promise<string> {
	const environment = ["VISUAL", "EDITOR", "RELAY_CLEAR_ON_SHRINK", "RELAY_HARDWARE_CURSOR"];
	const saved = environment.map((name) => [name, process.env[name]] as const);
	for (const name of environment) delete process.env[name];
	try {
		const results: unknown[] = [];
		for (const testCase of WRITE_CASES) {
			const { root, agentDir, cwd, globalPath, projectPath } = layout();
			try {
				writeFile(globalPath, testCase.global);
				writeFile(projectPath, testCase.project);
				const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: !testCase.untrusted });
				const outcomes: unknown[] = [];
				for (const call of testCase.calls) {
					try {
						// `reload` returns a promise; the setters' writes are flushed here, as a caller awaits them.
						const raw = runCall(manager, call, { globalPath, projectPath });
						const value = raw instanceof Promise ? await raw : raw;
						outcomes.push({ result: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
						await manager.flush();
					} catch (error) {
						outcomes.push({ error: error instanceof Error ? error.message : String(error) });
					}
				}
				await manager.flush();
				results.push(
					portable(
						{
							...testCase,
							outcomes,
							globalFile: fileText(globalPath),
							projectFile: fileText(projectPath),
							settings: manager.getSettings(),
							errors: errorsJson(manager.drainErrors()),
						},
						root,
					),
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
		return json(results);
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

export async function settingsFiles(): Promise<Record<string, string>> {
	return { "load.json": loadJson(), "writes.json": await writesJson() };
}

export function readSettingsFile(name: string): string {
	return readFileSync(join(SETTINGS_DIR, name), "utf8");
}
