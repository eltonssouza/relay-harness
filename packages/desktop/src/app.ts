/**
 * The screen: sessions on the left, the conversation in the middle, and the authorization dialog
 * for the harness's `confirm` requests. Everything comes from `relay --mode rpc`; the screen keeps
 * no agent logic of its own.
 */

import { AccountsDialog, type AuthEvent, type AuthProvider } from "./accounts.ts";
import type { Bridge } from "./bridge.ts";
import { askInput, askSelect } from "./dialogs.ts";
import { HarnessPanel, type HarnessSnapshot } from "./panel.ts";
import { type ChatMessage, chip, element, messageText, relativeTime, renderMessage, settleTool } from "./render.ts";
import { RpcConnection, type RpcEvent } from "./rpc.ts";
import { type HarnessSettings, openSettingsDialog } from "./settings.ts";

interface SessionInfo {
	path: string;
	id: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: string;
}

interface SessionState {
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	isStreaming: boolean;
	sessionFile?: string;
	sessionName?: string;
}

interface ConfirmRequest {
	id: string;
	title: string;
	message: string;
}

/** `[go-expert] Allow destructive operation?` names the subagent that asks. */
export function splitAgentTitle(title: string): { agent?: string; title: string } {
	const match = /^\[([^\]]+)\] (.*)$/s.exec(title);
	return match ? { agent: match[1], title: match[2] } : { title };
}

export class App {
	private readonly rpc: RpcConnection;
	private readonly root: HTMLElement;
	private readonly sessionsList: HTMLElement;
	private readonly messages: HTMLElement;
	private readonly input: HTMLTextAreaElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly abortButton: HTMLButtonElement;
	private readonly status: HTMLElement;
	private readonly modelSelect: HTMLSelectElement;
	private readonly thinkingSelect: HTMLSelectElement;
	private readonly panel: HarnessPanel;
	private readonly toasts: HTMLElement;
	private state: SessionState = { isStreaming: false };
	private streaming?: { node: HTMLElement; text: HTMLElement };
	private readonly confirms: ConfirmRequest[] = [];
	private dialogOpen = false;
	private accounts?: AccountsDialog;

	constructor(root: HTMLElement, bridge: Bridge) {
		this.root = root;
		this.rpc = new RpcConnection(bridge);
		this.rpc.onEvent((event) => this.handleEvent(event));
		bridge.onExit((code) => this.showExit(code));

		const sidebar = element("aside", "side");
		const newSession = element("button", "btn", "New session");
		newSession.type = "button";
		newSession.addEventListener("click", () => void this.newSession());
		this.sessionsList = element("nav", "sessions");
		this.sessionsList.setAttribute("aria-label", "Sessions");
		const accounts = element("button", "btn accounts-button", "Accounts");
		accounts.type = "button";
		accounts.addEventListener("click", () => void this.openAccounts());
		sidebar.append(element("div", "label", "Sessions"), newSession, this.sessionsList, accounts);

		const chat = element("main", "chat");
		const header = element("header", "titlebar");
		this.status = element("span", "crumb");
		this.modelSelect = element("select", "picker");
		this.modelSelect.setAttribute("aria-label", "Model");
		this.modelSelect.addEventListener("change", () => void this.selectModel(this.modelSelect.value));
		this.thinkingSelect = element("select", "picker");
		this.thinkingSelect.setAttribute("aria-label", "Thinking level");
		this.thinkingSelect.addEventListener(
			"change",
			() => void this.changeSetting({ type: "set_thinking_level", level: this.thinkingSelect.value }),
		);
		header.append(
			element("span", "title", "Relay"),
			this.status,
			element("span", "spacer"),
			this.modelSelect,
			this.thinkingSelect,
		);
		this.messages = element("div", "messages");
		this.messages.setAttribute("aria-live", "polite");
		const composer = element("form", "composer");
		this.input = element("textarea", "box");
		this.input.placeholder = "Message Relay (Enter to send, Shift+Enter for a new line)";
		this.input.setAttribute("aria-label", "Message");
		this.sendButton = element("button", "btn primary", "Send");
		this.sendButton.type = "submit";
		this.abortButton = element("button", "btn danger", "Stop");
		this.abortButton.type = "button";
		this.abortButton.hidden = true;
		this.abortButton.addEventListener("click", () => void this.rpc.request({ type: "abort" }));
		const row = element("div", "row");
		row.append(element("span", "spacer"), this.abortButton, this.sendButton);
		composer.append(this.input, row);
		composer.addEventListener("submit", (event) => {
			event.preventDefault();
			void this.send();
		});
		this.input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				void this.send();
			}
		});
		chat.append(header, this.messages, composer);

		this.toasts = element("div", "toasts");
		this.toasts.setAttribute("role", "status");
		this.panel = new HarnessPanel(
			(id) => void this.forgetConstraint(id),
			() => void this.openSettings(),
		);
		root.replaceChildren(sidebar, chat, this.panel.element, this.toasts);
		root.classList.add("app");
	}

	async start(): Promise<void> {
		await Promise.all([
			this.refreshState(),
			this.loadMessages(),
			this.loadSessions(),
			this.refreshHarness(),
			this.loadPickers(),
		]);
	}

	private async refreshState(): Promise<void> {
		this.state = await this.rpc.request<SessionState>({ type: "get_state" });
		this.renderStatus();
	}

	private renderStatus(): void {
		this.status.textContent = this.state.sessionName ?? "";
		const current = this.state.model ? `${this.state.model.provider}/${this.state.model.id}` : "";
		if ([...this.modelSelect.options].some((option) => option.value === current)) this.modelSelect.value = current;
		if (this.state.thinkingLevel) this.thinkingSelect.value = this.state.thinkingLevel;
		this.sendButton.textContent = this.state.isStreaming ? "Steer" : "Send";
		this.abortButton.hidden = !this.state.isStreaming;
	}

	/** Fill the model and thinking-level pickers with what relay offers. */
	private async loadPickers(): Promise<void> {
		const [{ models }, { levels }] = await Promise.all([
			this.rpc.request<{ models: Array<{ provider: string; id: string; name?: string }> }>({
				type: "get_available_models",
			}),
			this.rpc.request<{ levels: string[] }>({ type: "get_available_thinking_levels" }),
		]);
		this.modelSelect.replaceChildren(
			...models.map((model) => {
				const option = element("option", undefined, `${model.name ?? model.id} (${model.provider})`);
				option.value = `${model.provider}/${model.id}`;
				return option;
			}),
		);
		this.thinkingSelect.replaceChildren(
			...levels.map((level) => {
				const option = element("option", undefined, `thinking ${level}`);
				option.value = level;
				return option;
			}),
		);
		this.renderStatus();
	}

	private async selectModel(value: string): Promise<void> {
		const slash = value.indexOf("/");
		if (slash <= 0) return;
		await this.changeSetting({ type: "set_model", provider: value.slice(0, slash), modelId: value.slice(slash + 1) });
	}

	/** Apply a model or thinking change; on failure the pickers show the session's state again. */
	private async changeSetting(command: { type: string; [key: string]: unknown }): Promise<void> {
		try {
			await this.rpc.request(command);
		} catch (error) {
			this.toast(error instanceof Error ? error.message : String(error), "bad");
		}
		await this.refreshState();
	}

	private async refreshHarness(): Promise<void> {
		this.panel.render(await this.rpc.request<HarnessSnapshot>({ type: "get_harness_state" }));
	}

	private async openSettings(): Promise<void> {
		const settings = await this.rpc.request<HarnessSettings>({ type: "get_harness_settings" });
		openSettingsDialog(this.root, settings, async (key, value) => {
			try {
				return await this.rpc.request<HarnessSettings>({ type: "set_harness_setting", key, value });
			} catch (error) {
				this.toast(error instanceof Error ? error.message : String(error), "bad");
				return undefined;
			}
		});
	}

	private async forgetConstraint(id: string): Promise<void> {
		await this.rpc.request({ type: "harness_forget", constraintId: id });
		await this.refreshHarness();
	}

	private async loadMessages(): Promise<void> {
		const { messages } = await this.rpc.request<{ messages: ChatMessage[] }>({ type: "get_messages" });
		this.messages.replaceChildren();
		this.streaming = undefined;
		for (const message of messages) this.appendMessage(message);
	}

	private async loadSessions(): Promise<void> {
		const { sessions } = await this.rpc.request<{ sessions: SessionInfo[] }>({ type: "list_sessions" });
		this.sessionsList.replaceChildren(
			...sessions.map((session) => {
				const item = element("button", "session");
				item.type = "button";
				item.dataset.path = session.path;
				if (session.path === this.state.sessionFile) {
					item.classList.add("active");
					item.setAttribute("aria-current", "true");
				}
				const title = session.name || session.firstMessage || "Empty session";
				item.append(
					element("span", "name", title.length > 60 ? `${title.slice(0, 57)}...` : title),
					element("span", "meta", `${relativeTime(session.modified)} · ${session.messageCount} messages`),
				);
				item.addEventListener("click", () => void this.switchSession(session.path));
				return item;
			}),
		);
	}

	private async switchSession(path: string): Promise<void> {
		if (path === this.state.sessionFile) return;
		const result = await this.rpc.request<{ cancelled: boolean }>({ type: "switch_session", sessionPath: path });
		if (!result.cancelled) await this.start();
	}

	private async newSession(): Promise<void> {
		const result = await this.rpc.request<{ cancelled: boolean }>({ type: "new_session" });
		if (!result.cancelled) await this.start();
	}

	private async send(): Promise<void> {
		const message = this.input.value.trim();
		if (!message) return;
		this.input.value = "";
		try {
			await this.rpc.request({ type: this.state.isStreaming ? "steer" : "prompt", message });
		} catch (error) {
			this.toast(error instanceof Error ? error.message : String(error), "bad");
		}
	}

	private appendMessage(message: ChatMessage): void {
		if (message.role === "toolResult") {
			const block = [...this.messages.querySelectorAll<HTMLElement>("details.tool")].find(
				(node) => node.dataset.toolCallId === message.toolCallId,
			);
			if (block) settleTool(block, message.isError === true, messageText(message));
			return;
		}
		const node = renderMessage(message);
		if (node) this.messages.append(node);
		this.messages.scrollTop = this.messages.scrollHeight;
	}

	private handleEvent(event: RpcEvent): void {
		switch (event.type) {
			case "agent_start":
				this.state.isStreaming = true;
				this.renderStatus();
				break;
			case "agent_end":
				this.state.isStreaming = false;
				this.renderStatus();
				void this.loadSessions();
				void this.refreshHarness();
				break;
			case "tool_execution_start":
				if (event.toolName === "agent" && !event.parentToolCallId) {
					this.panel.agentStarted(String(event.toolCallId), event.args as Record<string, unknown> | undefined);
				}
				break;
			case "tool_execution_update":
				if (event.toolName === "agent") {
					const partial = event.partialResult as ChatMessage | undefined;
					this.panel.agentProgress(String(event.toolCallId), partial ? messageText(partial) : "");
				}
				break;
			case "tool_execution_end":
				if (event.toolName === "agent") this.panel.agentFinished(String(event.toolCallId), event.isError === true);
				break;
			case "message_start": {
				const message = event.message as ChatMessage;
				if (message.role === "assistant") {
					const node = element("div", "msg agent streaming");
					const text = element("p", "text");
					node.append(text);
					this.messages.append(node);
					this.streaming = { node, text };
				}
				break;
			}
			case "message_update": {
				const update = event.assistantMessageEvent as { type: string; delta?: string } | undefined;
				if (update?.type === "text_delta" && this.streaming && update.delta) {
					this.streaming.text.textContent += update.delta;
					this.messages.scrollTop = this.messages.scrollHeight;
				}
				break;
			}
			case "message_end": {
				const message = event.message as ChatMessage;
				if (message.role === "assistant" && this.streaming) {
					const final = renderMessage(message);
					if (final) this.streaming.node.replaceWith(final);
					else this.streaming.node.remove();
					this.streaming = undefined;
				} else {
					this.appendMessage(message);
				}
				break;
			}
			case "auth_event":
				this.accounts?.showEvent(String(event.provider), event.event as AuthEvent);
				break;
			case "extension_ui_request":
				this.handleUiRequest(event);
				break;
		}
	}

	private handleUiRequest(request: RpcEvent): void {
		const id = String(request.id);
		switch (request.method) {
			case "confirm":
				this.confirms.push({ id, title: String(request.title ?? ""), message: String(request.message ?? "") });
				this.showNextConfirm();
				break;
			case "notify":
				this.toast(
					String(request.message ?? ""),
					request.notifyType === "error" ? "bad" : request.notifyType === "warning" ? "warn" : "plain",
				);
				break;
			case "input":
				void askInput(this.root, {
					title: String(request.title ?? ""),
					placeholder: typeof request.placeholder === "string" ? request.placeholder : undefined,
					secret: request.secret === true,
				}).then((value) => this.answer(id, value));
				break;
			case "select":
				void askSelect(
					this.root,
					String(request.title ?? ""),
					Array.isArray(request.options) ? request.options.map(String) : [],
				).then((value) => this.answer(id, value));
				break;
			case "editor":
				// Not offered by this screen yet: answer so the agent does not wait.
				this.rpc.notify({ type: "extension_ui_response", id, cancelled: true });
				break;
		}
	}

	/** Answer an `input` or `select` request; undefined means the developer cancelled. */
	private answer(id: string, value: string | undefined): void {
		this.rpc.notify(
			value === undefined
				? { type: "extension_ui_response", id, cancelled: true }
				: { type: "extension_ui_response", id, value },
		);
	}

	private async openAccounts(): Promise<void> {
		if (this.accounts) return;
		const { providers } = await this.rpc.request<{ providers: AuthProvider[] }>({ type: "get_auth_providers" });
		this.accounts = new AccountsDialog(
			this.root,
			providers,
			{
				login: async (provider, method) => {
					try {
						await this.rpc.request({ type: "login", provider: provider.id, method });
						this.toast(`Signed in to ${provider.name}`, "ok");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (message !== "Login cancelled") this.toast(message, "bad");
					}
					await this.refreshAccounts();
				},
				cancel: (provider) => void this.rpc.request({ type: "cancel_login", provider }),
				logout: async (provider) => {
					await this.rpc.request({ type: "logout", provider: provider.id });
					await this.refreshAccounts();
				},
			},
			() => {
				this.accounts = undefined;
			},
		);
	}

	/** Credentials changed: the providers and the models they make available. */
	private async refreshAccounts(): Promise<void> {
		const { providers } = await this.rpc.request<{ providers: AuthProvider[] }>({ type: "get_auth_providers" });
		this.accounts?.render(providers);
		await this.loadPickers();
	}

	private showNextConfirm(): void {
		if (this.dialogOpen) return;
		const request = this.confirms.shift();
		if (!request) return;
		this.dialogOpen = true;
		const { agent, title } = splitAgentTitle(request.title);
		const [reason, ...rest] = request.message.split("\n\n");
		const overlay = element("div", "overlay");
		const dialog = element("div", "modal");
		dialog.setAttribute("role", "alertdialog");
		dialog.setAttribute("aria-modal", "true");
		dialog.setAttribute("aria-label", title);
		if (agent) dialog.append(element("div", "who", `${agent} (subagent)`));
		dialog.append(element("h2", undefined, title), element("div", "reason", reason ?? ""));
		const command = rest.join("\n\n").trim();
		if (command) dialog.append(element("pre", "mono", command));
		const deny = element("button", "btn danger", "Deny");
		deny.type = "button";
		const allow = element("button", "btn primary", "Allow once");
		allow.type = "button";
		const actions = element("div", "actions");
		actions.append(deny, allow);
		dialog.append(actions);
		overlay.append(dialog);
		const answer = (confirmed: boolean) => {
			this.rpc.notify({ type: "extension_ui_response", id: request.id, confirmed });
			overlay.remove();
			this.dialogOpen = false;
			this.input.focus();
			this.showNextConfirm();
		};
		deny.addEventListener("click", () => answer(false));
		allow.addEventListener("click", () => answer(true));
		dialog.addEventListener("keydown", (event) => {
			if (event.key === "Escape") answer(false);
		});
		this.root.append(overlay);
		// The safe choice has the focus: Enter alone never allows an operation.
		deny.focus();
	}

	private toast(text: string, tone: "ok" | "warn" | "bad" | "plain"): void {
		const node = element("div", "toast");
		node.append(
			chip(tone === "bad" ? "error" : tone === "warn" ? "warning" : "info", tone),
			element("span", undefined, text),
		);
		this.toasts.append(node);
		setTimeout(() => node.remove(), 8000);
	}

	private showExit(code: number | null): void {
		this.state.isStreaming = false;
		this.renderStatus();
		this.messages.append(
			element(
				"div",
				"notice bad",
				`relay stopped${code === null ? "" : ` (exit code ${code})`}. Restart the app to continue.`,
			),
		);
		this.input.disabled = true;
		this.sendButton.disabled = true;
	}
}
