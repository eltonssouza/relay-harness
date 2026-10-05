export function getRelayUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `relay/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
