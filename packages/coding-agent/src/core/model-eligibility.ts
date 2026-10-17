/** Models offered by the harness and permitted for requests. Other provider families are unchanged. */
export function isEligibleChatModel(provider: string, id: string): boolean {
	// Gateways may prefix the Claude ID with a vendor path or Bedrock region.
	const claude = id.match(/(?:^|[/.])(claude(?:-|$).*?)$/i)?.[1];
	if (claude) {
		return /^claude-(?:opus|sonnet|haiku)-5[.-]5(?:-\d{8})?(?:-(?:low|medium|high|xhigh)|-v\d+:\d+)?$/i.test(claude);
	}
	if (provider === "openai-codex") {
		return /^(?:gpt-6-astra|gpt-6\.1-sol|gpt-6-luna|gpt-5\.6-terra)$/i.test(id);
	}
	return true;
}
