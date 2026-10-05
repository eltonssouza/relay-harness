import * as bundledRelayAgentCore from "@relay-harness/agent-core";
import * as bundledRelayAiCompat from "@relay-harness/ai/compat";
import * as bundledRelayAiOauth from "@relay-harness/ai/oauth";
import * as bundledRelayAiProviders from "@relay-harness/ai/providers/all";
import * as bundledRelayTui from "@relay-harness/tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @relay-harness/coding-agent.
import * as bundledRelayCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@relay-harness/agent-core": bundledRelayAgentCore,
	"@relay-harness/tui": bundledRelayTui,
	// Extensions resolve the relay-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@relay-harness/ai": bundledRelayAiCompat,
	"@relay-harness/ai/compat": bundledRelayAiCompat,
	"@relay-harness/ai/oauth": bundledRelayAiOauth,
	"@relay-harness/ai/providers/all": bundledRelayAiProviders,
	"@relay-harness/coding-agent": bundledRelayCodingAgent,
	"@mariozechner/pi-agent-core": bundledRelayAgentCore,
	"@mariozechner/pi-tui": bundledRelayTui,
	"@mariozechner/pi-ai": bundledRelayAiCompat,
	"@mariozechner/pi-ai/compat": bundledRelayAiCompat,
	"@mariozechner/pi-ai/oauth": bundledRelayAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledRelayAiProviders,
	"@mariozechner/pi-coding-agent": bundledRelayCodingAgent,
};
