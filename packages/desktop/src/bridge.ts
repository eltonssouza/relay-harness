/**
 * The connection between the screen and `relay --mode rpc`. The Tauri shell starts the process
 * and forwards its JSON lines; tests install a scripted bridge as `window.__RELAY_BRIDGE__`.
 */

export interface Bridge {
	/** Write one RPC command as a JSON line to the process. */
	send(command: object): void;
	/** Each JSON value the process writes to stdout. */
	onMessage(listener: (message: unknown) => void): void;
	/** The process ended; `code` is null when it was killed. */
	onExit(listener: (code: number | null) => void): void;
}

interface TauriGlobal {
	core: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
	event: { listen(event: string, handler: (event: { payload: unknown }) => void): Promise<unknown> };
}

declare global {
	interface Window {
		__TAURI__?: TauriGlobal;
		__RELAY_BRIDGE__?: Bridge;
	}
}

/**
 * The Tauri shell's bridge: `rpc_send` writes a line, `rpc-line` and `rpc-exit` events come back.
 * The shell starts relay on the first command, and commands wait until the listeners are
 * registered, so no early output is lost.
 */
export function tauriBridge(tauri: TauriGlobal): Bridge {
	const registrations: Promise<unknown>[] = [];
	return {
		send(command) {
			void Promise.all(registrations).then(() => tauri.core.invoke("rpc_send", { line: JSON.stringify(command) }));
		},
		onMessage(listener) {
			registrations.push(
				tauri.event.listen("rpc-line", (event) => {
					try {
						listener(JSON.parse(String(event.payload)));
					} catch {
						// Not JSON: a stray line on stdout; the protocol carries only JSON.
					}
				}),
			);
		},
		onExit(listener) {
			registrations.push(
				tauri.event.listen("rpc-exit", (event) =>
					listener(typeof event.payload === "number" ? event.payload : null),
				),
			);
		},
	};
}

/** The bridge this window runs with: a test's, or the Tauri shell's. */
export function currentBridge(): Bridge {
	if (window.__RELAY_BRIDGE__) return window.__RELAY_BRIDGE__;
	if (window.__TAURI__) return tauriBridge(window.__TAURI__);
	throw new Error("No bridge to relay: run inside the Relay desktop shell.");
}
