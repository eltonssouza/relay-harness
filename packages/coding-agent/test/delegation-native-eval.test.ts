import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createProvider } from "@relay-harness/ai";
import { typesafeSystemOneApi } from "@relay-harness/ai/api/typesafe-system-one.lazy";
import { describe, expect, it, vi } from "vitest";
import { useCandidateCheckpoint } from "./delegation-checkpoint-evaluation.ts";
import {
	createDelegationHarness,
	latest,
	runDelegationRecovery,
	runDelegationScenario,
} from "./delegation-integration-support.ts";
import { delegationTestClassifier } from "./delegation-test-support.ts";

const enabled = process.env.RELAY_EVALUATE_DELEGATION === "1";

describe.skipIf(!enabled)("real checkpoint with subordinate SDK workers", () => {
	it.each(["continuous", "recovery"] as const)(
		"validates %s execution without mandatory phases",
		async (scenario) => {
			vi.stubEnv("RELAY_OFFLINE", undefined);
			const identity = useCandidateCheckpoint();
			const baseUrl = process.env.LAYA_BASE_URL ?? "http://127.0.0.1:8737/v1";
			const report: Record<string, unknown> = {
				version: 3,
				contract: "phase-independent-delegation",
				scenario,
				identity,
				startedAt: new Date().toISOString(),
				paidProviderCalls: 0,
				workerModel: "faux",
				passed: false,
			};
			const harness = await createDelegationHarness(true, undefined, undefined, (relay) =>
				relay.registerProvider(
					createProvider({
						id: "laya",
						models: [{ ...delegationTestClassifier, baseUrl }],
						auth: {
							apiKey: {
								name: "Local evaluation",
								resolve: async () => ({ auth: { apiKey: "local", baseUrl } }),
							},
						},
						classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
					}),
				),
			);
			try {
				if (scenario === "continuous") await runDelegationScenario(harness);
				else await runDelegationRecovery(harness);
				report.passed = true;
			} catch (error) {
				report.error = error instanceof Error ? error.message : String(error);
			} finally {
				report.state = latest(harness);
				report.finishedAt = new Date().toISOString();
				report.traces = harness.sessionManager
					.getBranch()
					.filter((item) => item.type === "custom" && item.customType.startsWith("relay.work."));
				const destination = resolve(
					(scenario === "continuous"
						? process.env.RELAY_DELEGATION_NATIVE_EVAL_OUTPUT
						: process.env.RELAY_DELEGATION_RECOVERY_EVAL_OUTPUT) ??
						`../../development/laya-subagentes/phase-independent-${scenario}-evaluation.json`,
				);
				mkdirSync(dirname(destination), { recursive: true });
				writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
				harness.cleanup();
				vi.restoreAllMocks();
				vi.unstubAllEnvs();
			}
			expect(report.passed, String(report.error ?? "")).toBe(true);
		},
		600_000,
	);
});
