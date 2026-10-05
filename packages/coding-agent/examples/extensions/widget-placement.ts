import type { ExtensionAPI } from "@relay-harness/coding-agent";

export default function widgetPlacementExtension(relay: ExtensionAPI) {
	relay.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
