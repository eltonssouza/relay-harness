/**
 * Reference results of the coding agent's config values (`resolve-config-value.ts`), for the
 * Rust port to match: API keys and headers written as `$VAR` or `${VAR}` templates, with `$$`
 * and `$!` escapes, or as `!command`. Commands are only classified here; running them depends on
 * the shell. Variables come from the provider env given to each case; the names are chosen to be
 * unset in any process environment.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	getConfigValueEnvVarName,
	getConfigValueEnvVarNames,
	getMissingConfigValueEnvVarNames,
	isCommandConfigValue,
	resolveConfigValue,
} from "../../src/core/resolve-config-value.ts";

export const CONFIG_VALUES_FILE = fileURLToPath(
	new URL("../../../../crates/fixtures/config-values.json", import.meta.url),
);

const ENV = { RELAY_PARITY_A: "alpha", RELAY_PARITY_B: "beta", RELAY_PARITY_EMPTY: "", _RELAY_PARITY_9: "nine" };

const CONFIGS = [
	"plain-key",
	"",
	"$RELAY_PARITY_A",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
	"${RELAY_PARITY_A}",
	"prefix-$RELAY_PARITY_A-suffix",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
	"${RELAY_PARITY_A}${RELAY_PARITY_B}",
	"$RELAY_PARITY_A$RELAY_PARITY_B",
	"$RELAY_PARITY_MISSING",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
	"x-${RELAY_PARITY_MISSING}",
	"$RELAY_PARITY_A and $RELAY_PARITY_MISSING",
	"$RELAY_PARITY_EMPTY",
	"$_RELAY_PARITY_9",
	"cost $$5",
	"$!not-a-command",
	"$$RELAY_PARITY_A",
	"$",
	"$5",
	"a$",
	"${",
	"${RELAY_PARITY_A",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
	"${not a name}",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
	"${}",
	"$-x",
	"café $RELAY_PARITY_A 🙈",
	"!echo hello",
	"!",
	" !echo",
];

export function configValueCases(): unknown[] {
	return CONFIGS.map((config) => ({
		config,
		command: isCommandConfigValue(config),
		envVarName: getConfigValueEnvVarName(config) ?? null,
		envVarNames: getConfigValueEnvVarNames(config),
		missing: getMissingConfigValueEnvVarNames(config, ENV),
		resolved: isCommandConfigValue(config) ? null : (resolveConfigValue(config, ENV) ?? null),
	}));
}

export function configValuesJson(): string {
	return `${JSON.stringify({ env: ENV, cases: configValueCases() }, null, "\t")}\n`;
}

export function readConfigValues(): string {
	return readFileSync(CONFIG_VALUES_FILE, "utf8");
}
