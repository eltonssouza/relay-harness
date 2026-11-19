/**
 * The accounts dialog: the providers relay can sign in to, how each is configured, and signing in
 * or out. While a login runs, its `auth_event` messages show here: the link to open, a device code,
 * or progress. The link is shown and copied, not opened: the window cannot open a browser itself.
 */

import { chip, element } from "./render.ts";

export interface AuthProvider {
	id: string;
	name: string;
	oauth: boolean;
	apiKey: boolean;
	configured: boolean;
	method?: "oauth" | "api_key";
	source?: string;
}

export interface AuthEvent {
	type: "info" | "auth_url" | "device_code" | "progress";
	message?: string;
	url?: string;
	instructions?: string;
	userCode?: string;
	verificationUri?: string;
}

export interface AccountActions {
	login(provider: AuthProvider, method: "oauth" | "api_key"): Promise<void>;
	cancel(provider: string): void;
	logout(provider: AuthProvider): Promise<void>;
}

export class AccountsDialog {
	private readonly overlay: HTMLElement;
	private readonly list: HTMLElement;
	private readonly status: HTMLElement;
	private readonly actions: AccountActions;
	private running?: string;
	private providers: AuthProvider[] = [];

	constructor(root: HTMLElement, providers: AuthProvider[], actions: AccountActions, onClose: () => void) {
		this.actions = actions;
		this.overlay = element("div", "overlay");
		const dialog = element("div", "modal accounts");
		dialog.setAttribute("role", "dialog");
		dialog.setAttribute("aria-modal", "true");
		dialog.setAttribute("aria-label", "Accounts");
		this.list = element("div", "account-list");
		this.status = element("div", "login-status");
		this.status.setAttribute("aria-live", "polite");
		const close = element("button", "btn", "Close");
		close.type = "button";
		const footer = element("div", "actions");
		footer.append(close);
		dialog.append(element("h2", undefined, "Accounts"), this.list, this.status, footer);
		this.overlay.append(dialog);
		// Re-rendering the list can remove the focused button, leaving focus on the page: Escape then
		// still closes this dialog, but not when it was meant for a dialog opened over it.
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as Node | null;
			if (event.key === "Escape" && (target === document.body || (target && dialog.contains(target)))) dismiss();
		};
		const dismiss = () => {
			if (this.running) this.actions.cancel(this.running);
			document.removeEventListener("keydown", onKey);
			this.overlay.remove();
			onClose();
		};
		close.addEventListener("click", dismiss);
		document.addEventListener("keydown", onKey);
		this.render(providers);
		root.append(this.overlay);
		close.focus();
	}

	render(providers: AuthProvider[]): void {
		this.providers = providers;
		this.list.replaceChildren(
			...providers.map((provider) => {
				const row = element("div", "account");
				const name = element("div", "title", provider.name);
				const state = provider.configured
					? chip(
							`${provider.method === "oauth" ? "signed in" : "API key"}${provider.source ? ` · ${provider.source}` : ""}`,
							"ok",
						)
					: chip("not configured", "plain");
				const buttons = element("div", "row");
				const add = (label: string, run: () => void) => {
					const button = element("button", "btn", label);
					button.type = "button";
					button.disabled = this.running !== undefined;
					button.setAttribute("aria-label", `${label}: ${provider.name}`);
					button.addEventListener("click", run);
					buttons.append(button);
				};
				if (provider.oauth) add("Sign in", () => void this.login(provider, "oauth"));
				if (provider.apiKey) add("API key", () => void this.login(provider, "api_key"));
				if (provider.configured) add("Sign out", () => void this.actions.logout(provider));
				const text = element("div");
				text.append(name, state);
				row.append(text, buttons);
				return row;
			}),
		);
	}

	/** Show a login's progress, when it is the one this dialog started. */
	showEvent(provider: string, event: AuthEvent): void {
		if (provider !== this.running) return;
		if (event.type === "auth_url" && event.url) {
			const url = element("div", "mono link", event.url);
			const copy = element("button", "btn", "Copy link");
			copy.type = "button";
			copy.addEventListener("click", () => void navigator.clipboard?.writeText(event.url ?? ""));
			this.status.replaceChildren(
				element("div", undefined, event.instructions ?? "Open this link in your browser to sign in:"),
				url,
				copy,
			);
		} else if (event.type === "device_code") {
			this.status.replaceChildren(
				element("div", undefined, `Open ${event.verificationUri ?? "the provider's page"} and enter this code:`),
				element("div", "mono code", event.userCode ?? ""),
			);
		} else if (event.message) {
			this.status.replaceChildren(element("div", "muted", event.message));
		}
	}

	private async login(provider: AuthProvider, method: "oauth" | "api_key"): Promise<void> {
		this.running = provider.id;
		this.render(this.providers);
		this.status.replaceChildren(element("div", "muted", `Signing in to ${provider.name}...`));
		const cancel = element("button", "btn", "Cancel sign-in");
		cancel.type = "button";
		cancel.addEventListener("click", () => this.actions.cancel(provider.id));
		this.status.append(cancel);
		try {
			await this.actions.login(provider, method);
		} finally {
			this.running = undefined;
			this.status.replaceChildren();
			this.render(this.providers);
		}
	}
}
