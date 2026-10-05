import { contentText } from "@relay-harness/ai";
import type { AgentMessage } from "../types.ts";

/** Prefix of user-role messages the harness writes itself, so it does not observe its own output. */
export const HARNESS_MESSAGE_PREFIX = "[harness";

/** Plain text of a user, assistant, or tool-result message. Other roles yield an empty string. */
export function messageText(message: AgentMessage): string {
	if (message.role === "user") return contentText(message.content);
	if (message.role === "toolResult") return contentText(message.content);
	if (message.role === "assistant") {
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
	return "";
}

/** Whether `message` was written by the developer rather than by the harness. */
export function isDeveloperMessage(message: AgentMessage): boolean {
	return message.role === "user" && !messageText(message).trimStart().startsWith(HARNESS_MESSAGE_PREFIX);
}

/**
 * Developer-authored prose of a message: drops fenced code and XML-like blocks such as expanded
 * skills (`<skill>`) or attached files (`<file>`), whose wording is not the developer's instruction.
 */
export function developerProse(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, " ")
		.trim();
}

/** Word boundaries that also hold around accented letters, which `\b` treats as non-word characters. */
const WORD_START = String.raw`(?<![\p{L}\p{N}_])`;
const WORD_END = String.raw`(?![\p{L}\p{N}_])`;

/** Case-insensitive Unicode regex matching any of `words` as whole words. Entries may contain regex syntax. */
export function wordsPattern(words: readonly string[]): RegExp {
	return new RegExp(`${WORD_START}(?:${words.join("|")})${WORD_END}`, "iu");
}

/**
 * Case-insensitive Unicode regex for `lead` words, optionally one more word, then `verbs`:
 * "do not use", "não altere", "never directly push".
 */
export function phrasePattern(lead: readonly string[], verbs: readonly string[]): RegExp {
	return new RegExp(
		`${WORD_START}(?:${lead.join("|")})\\s+(?:[\\p{L}']+\\s+)?(?:${verbs.join("|")})${WORD_END}`,
		"iu",
	);
}

/** Truncate to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max - 3)}...`;
}
