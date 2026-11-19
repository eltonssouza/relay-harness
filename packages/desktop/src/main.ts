/** Entry point of the screen: connect to relay and render. */

import { App } from "./app.ts";
import { currentBridge } from "./bridge.ts";

const root = document.getElementById("app");
if (!root) throw new Error("#app is missing");
try {
	void new App(root, currentBridge()).start();
} catch (error) {
	root.textContent = error instanceof Error ? error.message : String(error);
}
