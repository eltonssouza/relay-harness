import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const relayMessagesApi = (): ProviderStreams => lazyApi(() => import("./relay-messages.ts"));
