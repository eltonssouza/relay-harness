export interface DelegationLimits {
	maxConcurrent: number;
	maxTasks: number;
	maxAttempts: number;
	maxDurationMs: number;
	maxSteps: number;
	maxOutputBytes: number;
}

export const DEFAULT_DELEGATION_LIMITS: Readonly<DelegationLimits> = {
	maxConcurrent: 3,
	maxTasks: 8,
	maxAttempts: 2,
	maxDurationMs: 300_000,
	maxSteps: 40,
	maxOutputBytes: 64_000,
};

/** Finite schema bounds; settings select the effective budgets inside these bounds. */
export const DELEGATION_LIMIT_CAPS: Readonly<DelegationLimits> = {
	maxConcurrent: 16,
	maxTasks: 32,
	maxAttempts: 10,
	maxDurationMs: 3_600_000,
	maxSteps: 1000,
	maxOutputBytes: 4_194_304,
};

export function resolveDelegationLimits(value?: unknown): DelegationLimits {
	if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value)))
		throw new Error("Invalid delegation setting: expected a limits object");
	const supplied = (value ?? {}) as Record<string, unknown>;
	for (const key of Object.keys(supplied))
		if (!Object.hasOwn(DEFAULT_DELEGATION_LIMITS, key))
			throw new Error(`Invalid delegation setting: unknown limit ${key}`);
	const limits = { ...DEFAULT_DELEGATION_LIMITS };
	for (const key of Object.keys(limits) as Array<keyof DelegationLimits>) {
		const setting = supplied[key];
		if (setting === undefined) continue;
		if (
			typeof setting !== "number" ||
			!Number.isSafeInteger(setting) ||
			setting < 1 ||
			setting > DELEGATION_LIMIT_CAPS[key]
		)
			throw new Error(`Invalid delegation.${key}: expected an integer from 1 to ${DELEGATION_LIMIT_CAPS[key]}`);
		limits[key] = setting;
	}
	if (limits.maxConcurrent > limits.maxTasks)
		throw new Error("Invalid delegation: maxConcurrent cannot exceed maxTasks");
	return limits;
}
