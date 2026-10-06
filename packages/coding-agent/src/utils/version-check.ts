import { compare, valid } from "semver";
import { fetchWithRetry } from "./management-http.ts";
import { getRelayUserAgent } from "./relay-user-agent.ts";

/**
 * The npm registry is public, so every install can read it. The GitHub releases API answers 404 for a
 * private repository, which would silence the update notice for everyone.
 */
const LATEST_VERSION_URL = "https://registry.npmjs.org/@relay-harness/coding-agent/latest";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestRelayRelease {
	version: string;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestRelayRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestRelayRelease | undefined> {
	if (process.env.RELAY_OFFLINE) return undefined;

	const response = await fetchWithRetry(
		LATEST_VERSION_URL,
		{
			headers: {
				"User-Agent": getRelayUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	// The registry answers 404 when the package is not published.
	if (!response.ok) return undefined;

	const data = (await response.json()) as { version?: unknown } | null;
	if (typeof data?.version !== "string") return undefined;
	const version = valid(data.version.trim());
	return version ? { version } : undefined;
}

export async function getLatestRelayVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestRelayRelease(currentVersion, options))?.version;
}

export async function checkForNewRelayVersion(currentVersion: string): Promise<LatestRelayRelease | undefined> {
	if (process.env.RELAY_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestRelayRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
