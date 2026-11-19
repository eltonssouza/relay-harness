/**
 * Messages as DOM. Every piece of model, tool or session text is set with `textContent`, never
 * parsed as HTML, so a model cannot inject markup or script into the screen.
 */

export interface Block {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

export interface ChatMessage {
	role: string;
	content?: string | Block[];
	origin?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	errorMessage?: string;
	stopReason?: string;
}

export function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function chip(text: string, tone: "ok" | "warn" | "bad" | "accent" | "plain"): HTMLSpanElement {
	return element("span", `chip ${tone}`, text);
}

/** Text of a message's text blocks. */
export function messageText(message: ChatMessage): string {
	if (typeof message.content === "string") return message.content;
	return (message.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

/** The argument that says what a tool call does: its command, path or pattern, else its JSON. */
export function toolSummary(args: Record<string, unknown> | undefined): string {
	for (const key of ["command", "path", "file_path", "pattern", "subagent_type", "request", "url", "query"]) {
		const value = args?.[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	const json = JSON.stringify(args ?? {});
	return json.length > 160 ? `${json.slice(0, 157)}...` : json;
}

/** A tool call block; its result fills in later through {@link settleTool}. */
export function toolBlock(block: Block): HTMLElement {
	const details = element("details", "tool");
	details.dataset.toolCallId = block.id ?? "";
	const summary = element("summary");
	summary.append(chip(block.name ?? "tool", "plain"), element("span", "arg mono", toolSummary(block.arguments)));
	const status = chip("running", "accent");
	status.dataset.role = "status";
	summary.append(status);
	details.append(summary);
	return details;
}

const PREVIEW_LINES = 40;

/** Mark a tool block finished and attach the start of its output. */
export function settleTool(block: HTMLElement, isError: boolean, output: string): void {
	const status = block.querySelector<HTMLElement>('[data-role="status"]');
	if (status) {
		status.className = `chip ${isError ? "bad" : "ok"}`;
		status.textContent = isError ? "error" : "done";
	}
	block.querySelector("pre")?.remove();
	if (output.trim() === "") return;
	const lines = output.split("\n");
	const shown = lines.slice(0, PREVIEW_LINES).join("\n");
	block.append(
		element(
			"pre",
			"mono",
			lines.length > PREVIEW_LINES ? `${shown}\n... ${lines.length - PREVIEW_LINES} more lines` : shown,
		),
	);
}

/** The DOM of one message, or undefined for a tool result (it fills its tool block instead). */
export function renderMessage(message: ChatMessage): HTMLElement | undefined {
	if (message.role === "user") {
		const text = messageText(message);
		if (message.origin === "harness") return element("div", "notice", text);
		const node = element("div", "msg user", text);
		if (message.origin === "agent" || message.origin === "extension") node.dataset.origin = message.origin;
		return node;
	}
	if (message.role === "assistant") {
		const node = element("div", "msg agent");
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block.type === "text" && block.text) node.append(element("p", "text", block.text));
			else if (block.type === "thinking" && block.thinking) {
				const thinking = element("details", "thinking");
				thinking.append(element("summary", undefined, "Thinking"), element("p", "text", block.thinking));
				node.append(thinking);
			} else if (block.type === "toolCall") node.append(toolBlock(block));
		}
		if (message.stopReason === "error" && message.errorMessage) {
			node.append(element("div", "notice bad", message.errorMessage));
		}
		return node;
	}
	if (message.role === "toolResult") return undefined;
	const text = messageText(message);
	return text ? element("div", "note", `${message.role}: ${text}`) : undefined;
}

/** "3 min ago", "yesterday", or the date. */
export function relativeTime(value: string | number | Date, now = Date.now()): string {
	const time = new Date(value).getTime();
	if (Number.isNaN(time)) return "";
	const minutes = Math.round((now - time) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	if (hours < 48) return "yesterday";
	return new Date(time).toLocaleDateString();
}
