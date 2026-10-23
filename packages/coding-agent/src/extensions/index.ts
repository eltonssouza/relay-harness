import type { InlineExtension } from "../core/extensions/types.ts";
import auditExtension from "./audit/index.ts";
import browserExtension from "./browser/index.ts";
import codemodeExtension from "./codemode/index.ts";
import delegationExtension from "./delegation/index.ts";
import engineeringExtension from "./engineering/index.ts";
import goalExtension from "./goal/index.ts";
import intakeExtension from "./intake/index.ts";
import layaExtension from "./laya/index.ts";
import llamaExtension from "./llama/index.ts";
import logbookExtension from "./logbook/index.ts";
import mcpExtension from "./mcp/index.ts";
import nativeMcpExtension from "./native-mcp/index.ts";
import nativeMemoryExtension from "./native-memory/index.ts";
import ollamaExtension from "./ollama/index.ts";
import projectMemoryExtension from "./project-memory/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	// Registers only host commands; no target IO until /audit-app is run and consented. RELAY_AUDIT_ENABLED=0 opts out.
	...(process.env.RELAY_AUDIT_ENABLED !== "0"
		? [
				{
					name: "audit",
					factory: auditExtension,
					builtin: true,
				},
			]
		: []),
	{ name: "engineering", factory: engineeringExtension, builtin: true },
	{ name: "browser", factory: browserExtension, builtin: true },
	{ name: "native-mcp", factory: nativeMcpExtension, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	{ name: "ollama", factory: ollamaExtension, builtin: true },
	// Adds the laya/auto virtual model; it routes nothing unless selected.
	{ name: "laya", factory: layaExtension, builtin: true },
	{ name: "delegation", factory: delegationExtension, builtin: true },
	// Adds /intake and its deferred intake_questionnaire tool.
	{ name: "intake", factory: intakeExtension, builtin: true },
	{ name: "project-memory", factory: projectMemoryExtension, builtin: true },
	{ name: "logbook", factory: logbookExtension, builtin: true },
	{ name: "goal", factory: goalExtension, builtin: true },
	// Opt-in (--native-memory or RELAY_NATIVE_MEMORY=1): persistent memories, knowledge graph and user model.
	{ name: "native-memory", factory: nativeMemoryExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
