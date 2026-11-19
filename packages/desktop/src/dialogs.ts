/**
 * Dialogs for relay's `input` and `select` requests: an extension asking for text, or a login
 * asking for an API key (masked) or a choice. Each resolves to the answer, or undefined when the
 * developer cancels.
 */

import { element } from "./render.ts";

function modal(root: HTMLElement, title: string): { overlay: HTMLElement; dialog: HTMLElement; close: () => void } {
	const overlay = element("div", "overlay");
	const dialog = element("div", "modal");
	dialog.setAttribute("role", "dialog");
	dialog.setAttribute("aria-modal", "true");
	dialog.setAttribute("aria-label", title);
	dialog.append(element("h2", undefined, title));
	overlay.append(dialog);
	root.append(overlay);
	return { overlay, dialog, close: () => overlay.remove() };
}

export function askInput(
	root: HTMLElement,
	request: { title: string; placeholder?: string; secret?: boolean },
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const { dialog, close } = modal(root, request.title);
		const form = element("form", "ask");
		const input = element("input", "field");
		input.type = request.secret ? "password" : "text";
		input.autocomplete = "off";
		input.spellcheck = false;
		input.setAttribute("aria-label", request.title);
		if (request.placeholder) input.placeholder = request.placeholder;
		const cancel = element("button", "btn", "Cancel");
		cancel.type = "button";
		const submit = element("button", "btn primary", "Continue");
		submit.type = "submit";
		const actions = element("div", "actions");
		actions.append(cancel, submit);
		form.append(input, actions);
		dialog.append(form);
		const finish = (value: string | undefined) => {
			close();
			resolve(value);
		};
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			finish(input.value);
		});
		cancel.addEventListener("click", () => finish(undefined));
		dialog.addEventListener("keydown", (event) => {
			if (event.key === "Escape") finish(undefined);
		});
		input.focus();
	});
}

export function askSelect(root: HTMLElement, title: string, options: readonly string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		const { dialog, close } = modal(root, title);
		const finish = (value: string | undefined) => {
			close();
			resolve(value);
		};
		const list = element("div", "choices");
		for (const option of options) {
			const choice = element("button", "btn choice", option);
			choice.type = "button";
			choice.addEventListener("click", () => finish(option));
			list.append(choice);
		}
		const cancel = element("button", "btn", "Cancel");
		cancel.type = "button";
		cancel.addEventListener("click", () => finish(undefined));
		const actions = element("div", "actions");
		actions.append(cancel);
		dialog.append(list, actions);
		dialog.addEventListener("keydown", (event) => {
			if (event.key === "Escape") finish(undefined);
		});
		list.querySelector("button")?.focus();
	});
}
