import { layaCheckpointIdentity } from "../laya/model-identity.ts";
import { LAYA_MODEL_MANIFEST } from "../laya/model-manifest.ts";

export const DELEGATION_MODEL = "relay-laya-v4";

/** Evaluation tests replace this boundary explicitly; production always uses the shipped manifest. */
export function delegationCheckpoint() {
	const identity = layaCheckpointIdentity(LAYA_MODEL_MANIFEST);
	if (identity.version !== DELEGATION_MODEL)
		throw new Error(`Delegation requires ${DELEGATION_MODEL} in the shipped manifest`);
	return identity;
}
