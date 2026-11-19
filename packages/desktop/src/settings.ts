/**
 * The harness settings dialog. Each change goes to relay at once through `set_harness_setting`,
 * which checks the value; it applies to sessions started afterwards.
 */

import { element } from "./render.ts";

export interface HarnessSettings {
	alignment: boolean;
	authorizationGate: boolean;
	scopeGuard: boolean;
	evidence: boolean;
	context: boolean;
	contextKeepRecent: number;
	contextBatchSize: number;
	verifyCommands: string[];
	maxChangedLines: number;
	maxFileLines: number;
}

type SwitchKey = "alignment" | "authorizationGate" | "scopeGuard" | "evidence" | "context";
type CountKey = "contextKeepRecent" | "contextBatchSize" | "maxChangedLines" | "maxFileLines";

const SWITCHES: Array<[SwitchKey, string]> = [
	["alignment", "Record your constraints and gate risky operations"],
	["authorizationGate", "Ask before destructive and external commands"],
	["scopeGuard", "Block edits when you only asked a question"],
	["evidence", "Ask for a check before accepting a claim of completion"],
	["context", "Keep old tool results out of requests"],
];

const COUNTS: Array<[CountKey, string, number]> = [
	["contextKeepRecent", "Tool results always sent in full", 1],
	["contextBatchSize", "Old results elided together", 1],
	["maxChangedLines", "Changed lines before closing the slice (0 turns it off)", 0],
	["maxFileLines", "Lines per file before growth is flagged (0 turns it off)", 0],
];

/** Saves one setting; resolves to the settings after the change, or undefined when relay refused it. */
export type SaveSetting = (key: keyof HarnessSettings, value: unknown) => Promise<HarnessSettings | undefined>;

export function openSettingsDialog(root: HTMLElement, settings: HarnessSettings, save: SaveSetting): void {
	const overlay = element("div", "overlay");
	const dialog = element("div", "modal settings");
	dialog.setAttribute("role", "dialog");
	dialog.setAttribute("aria-modal", "true");
	dialog.setAttribute("aria-label", "Harness settings");
	dialog.append(
		element("h2", undefined, "Harness settings"),
		element("div", "muted", "Changes apply to sessions started afterwards."),
	);

	for (const [key, label] of SWITCHES) {
		const row = element("label", "setting");
		const input = element("input");
		input.type = "checkbox";
		input.checked = settings[key];
		input.addEventListener("change", async () => {
			const saved = await save(key, input.checked);
			if (!saved) input.checked = !input.checked;
		});
		row.append(input, element("span", undefined, label));
		dialog.append(row);
	}

	for (const [key, label, minimum] of COUNTS) {
		const row = element("label", "setting count");
		const input = element("input");
		input.type = "number";
		input.min = String(minimum);
		input.step = "1";
		input.value = String(settings[key]);
		input.addEventListener("change", async () => {
			const value = Number(input.value);
			if (!Number.isInteger(value) || value < minimum) {
				input.setAttribute("aria-invalid", "true");
				return;
			}
			input.removeAttribute("aria-invalid");
			const saved = await save(key, value);
			if (!saved) input.setAttribute("aria-invalid", "true");
		});
		row.append(element("span", undefined, label), input);
		dialog.append(row);
	}

	const commands = element("label", "setting commands");
	const textarea = element("textarea", "box mono");
	textarea.rows = 3;
	textarea.value = settings.verifyCommands.join("\n");
	textarea.placeholder = "npm run check";
	textarea.addEventListener("change", () => {
		const list = textarea.value
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
		void save("verifyCommands", list);
	});
	commands.append(
		element(
			"span",
			undefined,
			"Checks that count as verification, one per line (empty: test, build and lint commands)",
		),
		textarea,
	);
	dialog.append(commands);

	const close = element("button", "btn", "Close");
	close.type = "button";
	const actions = element("div", "actions");
	actions.append(close);
	dialog.append(actions);
	overlay.append(dialog);
	const dismiss = () => overlay.remove();
	close.addEventListener("click", dismiss);
	dialog.addEventListener("keydown", (event) => {
		if (event.key === "Escape") dismiss();
	});
	root.append(overlay);
	dialog.querySelector("input")?.focus();
}
