import type { InlineExtension } from "../core/extensions/types.ts";
import browserExtension from "./browser/index.ts";
import codemodeExtension from "./codemode/index.ts";
import engineeringExtension from "./engineering/index.ts";
import intakeExtension from "./intake/index.ts";
import layaExtension from "./laya/index.ts";
import llamaExtension from "./llama/index.ts";
import logbookExtension from "./logbook/index.ts";
import mcpExtension from "./mcp/index.ts";
import projectMemoryExtension from "./project-memory/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
import xpExtension from "./xp/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "engineering", factory: engineeringExtension, builtin: true },
	{ name: "browser", factory: browserExtension, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Adds the laya/auto virtual model; it routes nothing unless selected.
	{ name: "laya", factory: layaExtension, builtin: true },
	{ name: "xp", factory: xpExtension, builtin: true },
	// Adds /intake and its deferred intake_questionnaire tool.
	{ name: "intake", factory: intakeExtension, builtin: true },
	{ name: "project-memory", factory: projectMemoryExtension, builtin: true },
	{ name: "logbook", factory: logbookExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
