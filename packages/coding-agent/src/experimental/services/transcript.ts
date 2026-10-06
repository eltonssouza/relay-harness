import { defineService, type ReplicatedState } from "@relay-harness/chord";
import type { ConversationView } from "@relay-harness/durable";

/** The root conversation's durable view: active entries and its live, inbox, agent, and usage documents. */
export interface Transcript {
	readonly state: ReplicatedState<ConversationView>;
}

export const Transcript = defineService<Transcript>("relay.transcript");
