import {
	backgroundAnsi,
	foregroundAnsi,
	isAppleTerminalSession,
	type RgbColorValue,
	rgbColor,
} from "@relay-harness/tui";
import { theme } from "../theme/theme.ts";

/** Upper chevron arms, as in assets/relay-model.svg. */
const ARM_TOP = rgbColor(65, 229, 218);
/** Lower chevron arms, a shade darker so the mark reads as lit from above. */
const ARM_LOW = rgbColor(25, 173, 177);
/** The slash, the brightest part of the mark. */
const SLASH = rgbColor(125, 249, 239);
/** The "lay" of the wordmark. */
const WORDMARK_ACCENT = rgbColor(60, 241, 230);
const RESET = "\x1b[0m";

/**
 * The relay mark `</>` as square pixels: 8 columns, 4 rows. `t` is an upper arm, `l` a lower arm, `s` the slash.
 * The easter egg builds its 3D model from the same bitmap.
 */
export const RELAY_LOGO_PIXELS = [".t..s.t.", "t...s..t", "l..s...l", ".l.s..l."];
export const RELAY_LOGO_COLORS: Record<string, RgbColorValue> = { t: ARM_TOP, l: ARM_LOW, s: SLASH };
/** Width of the header logo in terminal cells: one cell per pixel column. */
export const RELAY_LOGO_WIDTH = RELAY_LOGO_PIXELS[0]!.length;

/**
 * The relay logo: 8 cells wide and 2 lines tall. Each cell shows two square pixels with half blocks.
 * The brand colors stay fixed across themes; they follow the terminal's color mode.
 */
export function relayLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const line = (row: number) => {
		let text = "";
		for (let column = 0; column < RELAY_LOGO_WIDTH; column++) {
			const top = RELAY_LOGO_COLORS[RELAY_LOGO_PIXELS[row]![column]!];
			const bottom = RELAY_LOGO_COLORS[RELAY_LOGO_PIXELS[row + 1]![column]!];
			if (top && bottom) {
				text +=
					top === bottom
						? `${foregroundAnsi(top, mode)}█${RESET}`
						: `${foregroundAnsi(top, mode)}${backgroundAnsi(bottom, mode)}▀${RESET}`;
			} else if (top) {
				text += `${foregroundAnsi(top, mode)}▀${RESET}`;
			} else if (bottom) {
				text += `${foregroundAnsi(bottom, mode)}▄${RESET}`;
			} else {
				text += " ";
			}
		}
		return text;
	};
	return [line(0), line(2)];
}

/**
 * Whether the terminal renders the half-block logo correctly. Apple Terminal draws gaps between rows and
 * misaligns the half blocks, so it gets the text wordmark instead.
 */
export function supportsRelayLogo(): boolean {
	return !isAppleTerminalSession();
}

/** The wordmark: "re" in the theme's text color, "lay" in the brand cyan. */
export function relayWordmark(): string {
	const mode = theme.getColorMode();
	return `${theme.bold("re")}${foregroundAnsi(WORDMARK_ACCENT, mode)}\x1b[1mlay${RESET}`;
}
