import { spawn } from "node:child_process";

export interface DockerResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface DockerRunOptions {
	signal?: AbortSignal;
	timeout?: number;
	/** Each output line as it arrives, with the stream it came from. */
	onLine?: (line: string, stream: "stdout" | "stderr") => void;
}

/** Runs the Docker CLI. Laya's server and trainer take it as an option, so tests can replace it. */
export type DockerRun = (args: string[], options?: DockerRunOptions) => Promise<DockerResult>;

/** Code returned when the `docker` command cannot be started at all. */
export const DOCKER_MISSING = 127;

export const spawnDocker: DockerRun = (args, options = {}) =>
	new Promise((resolve) => {
		const child = spawn("docker", args, {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			signal: options.signal,
			timeout: options.timeout,
		});
		const output = { stdout: "", stderr: "" };
		const pending = { stdout: "", stderr: "" };
		for (const stream of ["stdout", "stderr"] as const) {
			child[stream].setEncoding("utf8").on("data", (chunk: string) => {
				output[stream] += chunk;
				if (!options.onLine) return;
				const lines = (pending[stream] + chunk).split(/\r?\n/);
				pending[stream] = lines.pop() ?? "";
				for (const line of lines) options.onLine(line, stream);
			});
		}
		child.once("error", (error: NodeJS.ErrnoException) => {
			resolve({
				code: error.code === "ENOENT" ? DOCKER_MISSING : 1,
				stdout: output.stdout,
				stderr: error.code === "ENOENT" ? "The docker command was not found." : error.message,
			});
		});
		child.once("close", (code) => {
			for (const stream of ["stdout", "stderr"] as const) {
				if (pending[stream]) options.onLine?.(pending[stream], stream);
			}
			resolve({ code: code ?? 1, ...output });
		});
	});

/** The last lines of a failed command, for an error message. */
export function dockerError(result: DockerResult): string {
	const text = (result.stderr || result.stdout).trim();
	return text.split("\n").slice(-3).join(" ").trim() || `docker exited with code ${result.code}`;
}
