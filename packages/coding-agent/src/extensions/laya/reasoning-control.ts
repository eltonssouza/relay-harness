import {
	type Api,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
} from "@relay-harness/ai";

/**
 * How a requested reasoning effort maps onto one concrete model (ACI phase 3). The applied level is
 * exactly what `clampThinkingLevel` sends; this record only makes the mapping and its evidence visible,
 * so an assumed capability is never reported as a confirmed one.
 */
export interface ReasoningControl {
	requested: ModelThinkingLevel;
	applied: ModelThinkingLevel;
	supported: ModelThinkingLevel[];
	/** `exact`, or the direction of the nearest supported level; `unsupported` when the model has no reasoning control. */
	adjustment: "exact" | "raised" | "lowered" | "unsupported";
	/**
	 * `declared`: the catalog lists this model's reasoning levels. `assumed`: the catalog only marks it as a
	 * reasoning model, so the standard levels are assumed. `none`: the catalog marks it as non-reasoning.
	 */
	evidence: "declared" | "assumed" | "none";
}

const ORDER: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function reasoningControl(model: Model<Api>, requested: ModelThinkingLevel): ReasoningControl {
	const supported = getSupportedThinkingLevels(model);
	const applied = clampThinkingLevel(model, requested);
	const evidence = !model.reasoning ? "none" : model.thinkingLevelMap ? "declared" : "assumed";
	const adjustment =
		applied === requested
			? "exact"
			: !model.reasoning
				? "unsupported"
				: ORDER.indexOf(applied) > ORDER.indexOf(requested)
					? "raised"
					: "lowered";
	return { requested, applied, supported, adjustment, evidence };
}
