import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Local Laya runtime: the trained model, a Python environment with the `laya` package, and the
 * script that serves them. The npm package carries none of these (the model is 650 MB, the
 * environment a few GB); `setupLayaRuntime()` fetches them on first use into the agent directory.
 */

export interface LayaModelFile {
	/** Path inside the model directory, with forward slashes. */
	path: string;
	/** Flat file name of the release asset. */
	asset: string;
	size: number;
	sha256: string;
}

export interface LayaModelManifest {
	version: string;
	/** pip requirement for the Laya runtime. */
	layaPackage: string;
	/** Directory URL the assets are downloaded from, ending in a slash. */
	baseUrl: string;
	files: LayaModelFile[];
}

export type ExecFunction = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface LayaPaths {
	home: string;
	model: string;
	venv: string;
	venvPython: string;
	serveScript: string;
	/** Written by native training (`training.ts`) before each run. */
	trainScript: string;
	log: string;
}

export function layaPaths(home: string, manifest: LayaModelManifest): LayaPaths {
	const venv = join(home, "venv");
	return {
		home,
		model: join(home, "models", manifest.version),
		venv,
		venvPython: join(
			venv,
			process.platform === "win32" ? "Scripts" : "bin",
			process.platform === "win32" ? "python.exe" : "python",
		),
		serveScript: join(home, "serve.py"),
		trainScript: join(home, "train.py"),
		log: join(home, "server.log"),
	};
}

export type LayaRuntimeStatus = "ready" | "missing-environment" | "missing-model";

/** Files of the model that are absent or have the wrong size. A full hash check happens at download. */
export function missingModelFiles(manifest: LayaModelManifest, paths: LayaPaths): LayaModelFile[] {
	return manifest.files.filter((file) => {
		const path = join(paths.model, ...file.path.split("/"));
		try {
			return statSync(path).size !== file.size;
		} catch {
			return true;
		}
	});
}

export function runtimeStatus(manifest: LayaModelManifest, paths: LayaPaths): LayaRuntimeStatus {
	if (!existsSync(paths.venvPython) || !existsSync(paths.serveScript)) return "missing-environment";
	return missingModelFiles(manifest, paths).length > 0 ? "missing-model" : "ready";
}

export interface DownloadOptions {
	fetch?: typeof fetch;
	signal?: AbortSignal;
	onProgress?: (file: LayaModelFile, received: number) => void;
}

/**
 * Downloads the files that are missing or wrong, verifying each against its manifest hash before it
 * becomes visible: a download is written to a `.part` file and renamed only when the hash matches.
 */
export async function downloadModel(
	manifest: LayaModelManifest,
	paths: LayaPaths,
	options: DownloadOptions = {},
): Promise<void> {
	const request = options.fetch ?? globalThis.fetch;
	for (const file of missingModelFiles(manifest, paths)) {
		const target = join(paths.model, ...file.path.split("/"));
		const partial = `${target}.part`;
		mkdirSync(dirname(target), { recursive: true });
		const response = await request(new URL(file.asset, manifest.baseUrl), { signal: options.signal });
		if (!response.ok || !response.body) {
			throw new Error(`Downloading ${file.asset} failed: HTTP ${response.status}`);
		}
		const hash = createHash("sha256");
		let received = 0;
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				hash.update(chunk);
				received += chunk.length;
				options.onProgress?.(file, received);
				callback(null, chunk);
			},
		});
		try {
			await pipeline(
				Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
				meter,
				createWriteStream(partial),
				{ signal: options.signal },
			);
			const digest = hash.digest("hex");
			if (received !== file.size || digest !== file.sha256) {
				throw new Error(`${file.asset} does not match the manifest (size ${received}, sha256 ${digest})`);
			}
			renameSync(partial, target);
		} catch (error) {
			rmSync(partial, { force: true });
			throw error;
		}
	}
}

const PYTHON_CANDIDATES: Array<[string, string[]]> = [
	["python3", []],
	["python", []],
	["py", ["-3"]],
];

/** A Python 3.10 to 3.13 interpreter (the range torch publishes wheels for), as command plus leading args. */
export async function findPython(exec: ExecFunction, override?: string): Promise<[string, string[]] | undefined> {
	const candidates: Array<[string, string[]]> = override ? [[override, []]] : PYTHON_CANDIDATES;
	for (const [command, leading] of candidates) {
		try {
			const result = await exec(
				command,
				[...leading, "-c", "import sys; print(sys.version_info[0], sys.version_info[1])"],
				{ timeout: 15_000 },
			);
			const [major, minor] = result.stdout.trim().split(" ").map(Number);
			if (result.code === 0 && major === 3 && minor >= 10 && minor <= 13) return [command, leading];
		} catch {
			// Not installed.
		}
	}
	return undefined;
}

export interface SetupOptions {
	exec: ExecFunction;
	home: string;
	manifest: LayaModelManifest;
	python?: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	report: (message: string) => void;
}

const PIP_TIMEOUT_MS = 30 * 60_000;

async function run(
	exec: ExecFunction,
	command: string,
	args: string[],
	options: { signal?: AbortSignal; timeout?: number },
	failure: string,
): Promise<void> {
	const result = await exec(command, args, options);
	if (result.code !== 0) {
		throw new Error(`${failure}: ${(result.stderr || result.stdout).trim().split("\n").slice(-4).join(" ")}`);
	}
}

/** Torch wheel index: a CUDA build only where an NVIDIA GPU exists, the small CPU build otherwise. */
async function torchArgs(exec: ExecFunction): Promise<string[]> {
	if (process.platform === "darwin") return ["torch"];
	let gpu = false;
	try {
		gpu = (await exec("nvidia-smi", ["-L"], { timeout: 10_000 })).code === 0;
	} catch {
		// No NVIDIA driver.
	}
	return ["torch", "--index-url", `https://download.pytorch.org/whl/${gpu ? "cu128" : "cpu"}`];
}

/** Creates the environment, installs torch and Laya, writes the server script and downloads the model. */
export async function setupLayaRuntime(options: SetupOptions): Promise<LayaPaths> {
	const { exec, report, signal } = options;
	const paths = layaPaths(options.home, options.manifest);
	mkdirSync(paths.home, { recursive: true });

	const importable = async () =>
		existsSync(paths.venvPython) &&
		(await exec(paths.venvPython, ["-c", "import laya, torch, fastapi, uvicorn"], { timeout: 120_000 })).code === 0;

	if (!(await importable())) {
		const python = await findPython(exec, options.python);
		if (!python) {
			throw new Error("Laya needs Python 3.10 to 3.13. Install it, or set laya.python to its path.");
		}
		report("Creating the Python environment");
		await run(
			exec,
			python[0],
			[...python[1], "-m", "venv", paths.venv],
			{ signal, timeout: 120_000 },
			"Creating the environment failed",
		);
		const pip = [paths.venvPython, "-m", "pip", "install", "-q", "--disable-pip-version-check"] as const;
		// Distribution pythons seed old pips (Debian 12: 23.0) that reject current wheel metadata on
		// the torch index and fall back to source builds that cannot finish there.
		report("Updating pip");
		await run(
			exec,
			pip[0],
			[...pip.slice(1), "--upgrade", "pip"],
			{ signal, timeout: PIP_TIMEOUT_MS },
			"Updating pip failed",
		);
		report("Installing torch (large download)");
		await run(
			exec,
			pip[0],
			[...pip.slice(1), ...(await torchArgs(exec))],
			{ signal, timeout: PIP_TIMEOUT_MS },
			"Installing torch failed",
		);
		report("Installing Laya");
		await run(
			exec,
			pip[0],
			[...pip.slice(1), options.manifest.layaPackage, "fastapi", "uvicorn"],
			{ signal, timeout: PIP_TIMEOUT_MS },
			"Installing Laya failed",
		);
	}
	writeFileSync(paths.serveScript, SERVE_SCRIPT, "utf8");

	let lastReported = 0;
	await downloadModel(options.manifest, paths, {
		fetch: options.fetch,
		signal,
		onProgress: (file, received) => {
			if (file.size < 10_000_000 || received - lastReported < 25_000_000) return;
			lastReported = received;
			report(`Downloading the Laya model: ${file.asset} ${Math.round((received / file.size) * 100)}%`);
		},
	});
	return paths;
}

/** Serves the model with the System One protocol Relay's `typesafe-system-one` classifier speaks. */
export const SERVE_SCRIPT = `import argparse

import laya
import torch
import uvicorn
from fastapi import FastAPI, HTTPException

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8000)
args = parser.parse_args()

agent = laya.load(args.model, device="cuda" if torch.cuda.is_available() else "cpu")
app = FastAPI(title="relay-laya")


@app.get("/health")
def health():
    return {"ok": True, "model": args.model}


@app.post("/v1/systemone")
def system_one(body: dict):
    if "state" not in body or not body.get("questions"):
        raise HTTPException(422, "send 'state' and 'questions'")
    return agent.predict(body["state"], body["questions"])


uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
`;
