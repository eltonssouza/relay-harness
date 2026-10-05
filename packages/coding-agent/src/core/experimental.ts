export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.RELAY_EXPERIMENTAL === "1";
}
