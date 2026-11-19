/**
 * The screen: sessions on the left, the conversation in the middle, and the authorization dialog
 * for the harness's `confirm` requests. Everything comes from `relay --mode rpc`; the screen keeps
 * no agent logic of its own.
 */

import type { Bridge } from "./bridge.ts";
import { type ChatMessage, chip, element, messageText, relativeTime, renderMessage, settleTool } from "./render.ts";
import { RpcConnection, type RpcEvent } from "./rpc.ts";

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
	private readonly toasts: HTMLElement;
	private state: SessionState = { isStreaming: false };
	private streaming?: { node: HTMLElement; text: HTMLElement };
	private readonly confirms: ConfirmRequest[] = [];
	private dialogOpen = false;

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
		sidebar.append(element("div", "label", "Sessions"), newSession, this.sessionsList);

		const chat = element("main", "chat");
		const header = element("header", "titlebar");
		this.status = element("span", "crumb");
		header.append(element("span", "title", "Relay"), this.status);
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
		root.replaceChildren(sidebar, chat, this.toasts);
		root.classList.add("app");
	}

	async start(): Promise<void> {
		await Promise.all([this.refreshState(), this.loadMessages(), this.loadSessions()]);
	}

	private async refreshState(): Promise<void> {
		this.state = await this.rpc.request<SessionState>({ type: "get_state" });
		this.renderStatus();
	}

	private renderStatus(): void {
		const model = this.state.model ? `${this.state.model.provider}/${this.state.model.id}` : "no model";
		const parts = [this.state.sessionName, model, this.state.thinkingLevel && `thinking ${this.state.thinkingLevel}`];
		this.status.textContent = parts.filter(Boolean).join(" · ");
		this.sendButton.textContent = this.state.isStreaming ? "Steer" : "Send";
		this.abortButton.hidden = !this.state.isStreaming;
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
			case "select":
			case "input":
			case "editor":
				// Not offered by this screen yet: answer so the agent does not wait.
				this.rpc.notify({ type: "extension_ui_response", id, cancelled: true });
				break;
		}
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
