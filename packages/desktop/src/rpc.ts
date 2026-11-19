/**
 * RPC over a bridge: commands get an id and a promise for their response; everything else the
 * process writes (agent events, UI requests) goes to the event listener.
 */

import type { Bridge } from "./bridge.ts";

export interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface RpcEvent {
	type: string;
	[key: string]: unknown;
}

export class RpcConnection {
	private readonly bridge: Bridge;
	private readonly pending = new Map<string, (response: RpcResponse) => void>();
	private nextId = 1;
	private eventListener: (event: RpcEvent) => void = () => {};

	constructor(bridge: Bridge) {
		this.bridge = bridge;
		bridge.onMessage((message) => this.receive(message));
	}

	onEvent(listener: (event: RpcEvent) => void): void {
		this.eventListener = listener;
	}

	/** Send a command and wait for its response; a failed command rejects with its error. */
	request<T = unknown>(command: { type: string; [key: string]: unknown }): Promise<T> {
		const id = `ui-${this.nextId++}`;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, (response) => {
				if (response.success) resolve(response.data as T);
				else reject(new Error(response.error ?? `${command.type} failed`));
			});
			this.bridge.send({ ...command, id });
		});
	}

	/** Send without waiting, for answers to UI requests. */
	notify(message: object): void {
		this.bridge.send(message);
	}

	private receive(message: unknown): void {
		if (!message || typeof message !== "object") return;
		const value = message as RpcEvent;
		if (value.type === "response" && typeof value.id === "string" && this.pending.has(value.id)) {
			const settle = this.pending.get(value.id);
			this.pending.delete(value.id);
			settle?.(value as unknown as RpcResponse);
			return;
		}
		this.eventListener(value);
	}
}
