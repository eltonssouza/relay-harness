#!/usr/bin/env node
/**
 * Draws Relay's app icon (two chevrons on a rounded teal square) at every size the installers
 * need and writes `src-tauri/icons/`: PNGs for Linux and the window, `icon.ico` for Windows and
 * `icon.icns` for macOS. No image tools: the shapes are computed per pixel and encoded here.
 *
 *   node scripts/make-icons.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
const TEAL = [31, 111, 102];

/** Distance from (x, y) to the segment a-b. */
function segment(x, y, ax, ay, bx, by) {
	const dx = bx - ax;
	const dy = by - ay;
	const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
	return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** RGBA pixels of the icon at `size`, drawn on a 64-unit grid and anti-aliased at the edges. */
function draw(size) {
	const pixels = Buffer.alloc(size * size * 4);
	const unit = size / 64;
	const radius = 14 * unit;
	const min = 2 * unit;
	const max = size - 2 * unit;
	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			const x = px + 0.5;
			const y = py + 0.5;
			const cx = Math.min(Math.max(x, min + radius), max - radius);
			const cy = Math.min(Math.max(y, min + radius), max - radius);
			const outside = Math.hypot(x - cx, y - cy) - radius;
			const coverage = Math.max(0, Math.min(1, 0.5 - outside));
			if (coverage === 0) continue;
			const g = x / unit;
			const h = y / unit;
			const distance = Math.min(
				segment(g, h, 17, 18, 31, 32),
				segment(g, h, 31, 32, 17, 46),
				segment(g, h, 33, 18, 47, 32),
				segment(g, h, 47, 32, 33, 46),
			);
			const white = Math.max(0, Math.min(1, (4.2 - distance) * unit));
			const i = (py * size + px) * 4;
			for (let channel = 0; channel < 3; channel++) {
				pixels[i + channel] = Math.round(TEAL[channel] + (255 - TEAL[channel]) * white);
			}
			pixels[i + 3] = Math.round(255 * coverage);
		}
	}
	return pixels;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body) >>> 0);
	return Buffer.concat([length, body, crc]);
}

function png(size) {
	const pixels = draw(size);
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // RGBA
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** An ICO file holding PNG images (Windows Vista and later read them). */
function ico(sizes) {
	const images = sizes.map((size) => ({ size, data: png(size) }));
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(({ size, data }, index) => {
		const entry = 6 + 16 * index;
		header[entry] = size >= 256 ? 0 : size;
		header[entry + 1] = size >= 256 ? 0 : size;
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(data.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += data.length;
	});
	return Buffer.concat([header, ...images.map((image) => image.data)]);
}

/** An ICNS file with PNG entries: ic07 (128), ic08 (256), ic09 (512). */
function icns() {
	const entries = [
		["ic07", 128],
		["ic08", 256],
		["ic09", 512],
	].map(([type, size]) => {
		const data = png(size);
		const head = Buffer.alloc(8);
		head.write(type, 0, "ascii");
		head.writeUInt32BE(data.length + 8, 4);
		return Buffer.concat([head, data]);
	});
	const body = Buffer.concat(entries);
	const head = Buffer.alloc(8);
	head.write("icns", 0, "ascii");
	head.writeUInt32BE(body.length + 8, 4);
	return Buffer.concat([head, body]);
}

mkdirSync(OUTPUT, { recursive: true });
const files = {
	"32x32.png": png(32),
	"128x128.png": png(128),
	"128x128@2x.png": png(256),
	"icon.png": png(512),
	"icon.ico": ico([16, 32, 48, 256]),
	"icon.icns": icns(),
};
for (const [name, data] of Object.entries(files)) writeFileSync(join(OUTPUT, name), data);
console.log(`wrote ${Object.keys(files).join(", ")} to ${OUTPUT}`);
