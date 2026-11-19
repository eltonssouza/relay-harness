#!/usr/bin/env node
/** Copy the page and the stylesheet next to the compiled scripts in `dist/`, which Tauri serves. */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "dist"), { recursive: true });
for (const file of ["index.html", "styles.css"]) copyFileSync(join(root, "src", file), join(root, "dist", file));
