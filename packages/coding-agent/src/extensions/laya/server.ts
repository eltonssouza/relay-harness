import { DOCKER_MISSING, type DockerRun, dockerError } from "./docker.ts";
import { LAYA_QUESTIONS } from "./questions.ts";
import {
	LAYA_CONTAINER,
	LAYA_CONTAINER_PORT,
	LAYA_IMAGE_PATHS,
	LAYA_IMAGE_REPOSITORY,
	LAYA_MODELS_VOLUME,
} from "./runtime.ts";

const HEALTH_TIMEOUT_MS = 1500;
/** Loading the model on the CPU of a slow machine takes a while. */
const START_TIMEOUT_MS = 180_000;
const POLL_MS = 1000;
const PULL_TIMEOUT_MS = 60 * 60_000;
const COMMAND_TIMEOUT_MS = 60_000;

/** Labels that describe what a server container runs; a container whose labels differ is replaced. */
const LABEL_IMAGE = "relay.laya.image";
const LABEL_MODEL = "relay.laya.model";
const LABEL_ADDRESS = "relay.laya.address";

export type LayaServerState =
	/** Not checked yet in this process. */
	| "unknown"
	/** The docker command is missing or its daemon does not answer. */
	| "no-docker"
	| "installing"
	| "ready"
	| "failed";

export interface LayaServerOptions {
	docker: DockerRun;
	/** The configured System One URL, e.g. `http://127.0.0.1:8737/v1`. */
	baseUrl: () => string;
	/** Image to run. */
	image: () => Promise<string>;
	/** Model to serve, as a path inside the container. */
	model: () => string;
	fetch?: typeof fetch;
}

/** Whether a URL points at this machine, the only place Relay runs a server. */
export function isLocalUrl(url: string): boolean {
	try {
		return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
	} catch {
		return false;
	}
}

/** Host address Docker publishes the server port on, from the configured URL. */
function publishAddress(baseUrl: string): string {
	const url = new URL(baseUrl);
	const host = url.hostname === "[::1]" ? "[::1]" : "127.0.0.1";
	return `${host}:${url.port || "80"}`;
}

/**
 * The Laya server container. `install()` pulls the image when it is missing and keeps one container
 * running with the active model, published on the configured local port only. The container
 * restarts with Docker, so later sessions find it answering. A server that answers without being
 * ours (no container named relay-laya) is used as is, unless it serves other questions than Relay's.
 */
export class LayaServer {
	private readonly options: LayaServerOptions;
	private installing: Promise<boolean> | undefined;
	state: LayaServerState = "unknown";
	/** Why the server is not ready, for `/laya status`. */
	detail: string | undefined;
	/** Image of the running container. */
	image: string | undefined;

	constructor(options: LayaServerOptions) {
		this.options = options;
	}

	/** The server's health answer, when it answers. */
	private async health(): Promise<{ ok?: boolean; decisions?: unknown } | undefined> {
		const request = this.options.fetch ?? globalThis.fetch;
		try {
			const response = await request(new URL("/health", this.options.baseUrl()), {
				signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			});
			if (!response.ok) return undefined;
			const body = (await response.json()) as { ok?: boolean; decisions?: unknown };
			return body.ok === true ? body : undefined;
		} catch {
			return undefined;
		}
	}

	async isUp(): Promise<boolean> {
		return (await this.health()) !== undefined;
	}

	/** Makes the server answer: pulls, creates, replaces or starts the container. Concurrent calls share one run. */
	install(report: (message: string) => void = () => {}, signal?: AbortSignal): Promise<boolean> {
		this.installing ??= this.run(report, signal).finally(() => {
			this.installing = undefined;
		});
		return this.installing;
	}

	private fail(state: "no-docker" | "failed", detail: string): false {
		this.state = state;
		this.detail = detail;
		return false;
	}

	private async run(report: (message: string) => void, signal?: AbortSignal): Promise<boolean> {
		const { docker } = this.options;
		const baseUrl = this.options.baseUrl();
		if (!isLocalUrl(baseUrl)) {
			// A remote server is not Relay's to manage.
			const up = await this.isUp();
			return up ? this.ready() : this.fail("failed", `${baseUrl} does not answer`);
		}
		this.state = "installing";
		this.detail = undefined;

		const version = await docker(["version", "--format", "{{.Server.Version}}"], {
			signal,
			timeout: COMMAND_TIMEOUT_MS,
		});
		if (version.code !== 0) {
			return this.fail(
				"no-docker",
				version.code === DOCKER_MISSING
					? "Docker is not installed"
					: `Docker does not answer; start Docker Desktop or the Docker service (${dockerError(version)})`,
			);
		}

		const container = await this.inspect(signal);
		const foreign = container ? undefined : await this.health();
		if (foreign) {
			// Someone else's server on this port: use it, unless it says it answers other questions,
			// like a laya-trainer server of another project.
			const decisions = Array.isArray(foreign.decisions) ? foreign.decisions : undefined;
			if (decisions && !Object.keys(LAYA_QUESTIONS).every((name) => decisions.includes(name))) {
				return this.fail(
					"failed",
					`another Laya server, which answers other questions, uses ${publishAddress(baseUrl)}; stop it or set laya.baseUrl to a free port`,
				);
			}
			return this.ready();
		}

		const image = await this.options.image();
		const present = await docker(["image", "inspect", "--format", "{{.Id}}", image], { signal });
		if (present.code !== 0) {
			report("downloading the Laya image (a few GB, only the first time)");
			// Docker Desktop's containerd store reports "Download complete" per layer while it downloads
			// and "Pull complete" only when it extracts, and also completes blobs that are not layers.
			// A layer counts once, when it is downloaded or already present.
			const layers = new Set<string>();
			const done = new Set<string>();
			const pull = await docker(["pull", image], {
				signal,
				timeout: PULL_TIMEOUT_MS,
				onLine: (line) => {
					const match = /^([0-9a-f]{12}): (Pulling fs layer|Already exists|Download complete|Pull complete)$/.exec(
						line.trim(),
					);
					if (!match) return;
					const [, id, status] = match;
					if (status === "Pulling fs layer" || status === "Already exists") layers.add(id);
					if (status !== "Pulling fs layer" && layers.has(id) && !done.has(id)) done.add(id);
					else if (status !== "Pulling fs layer") return;
					report(`downloading the Laya image: ${done.size}/${layers.size} layers`);
				},
			});
			if (pull.code !== 0) return this.fail("failed", `Pulling ${image} failed: ${dockerError(pull)}`);
		}

		const labels = {
			[LABEL_IMAGE]: image,
			[LABEL_MODEL]: this.options.model(),
			[LABEL_ADDRESS]: publishAddress(baseUrl),
		};
		const matches = container && Object.entries(labels).every(([key, value]) => container.labels[key] === value);
		if (container && !matches) {
			const removed = await docker(["rm", "--force", LAYA_CONTAINER], { signal, timeout: COMMAND_TIMEOUT_MS });
			if (removed.code !== 0)
				return this.fail("failed", `Replacing the Laya container failed: ${dockerError(removed)}`);
		}
		if (!matches) {
			report("starting the Laya server");
			const created = await docker(this.runArgs(image, labels), { signal, timeout: COMMAND_TIMEOUT_MS });
			// Another Relay created it at the same time: use theirs, it runs the same image and model.
			if (created.code !== 0 && !(await this.inspect(signal))) {
				return this.fail("failed", `Starting the Laya container failed: ${dockerError(created)}`);
			}
		} else if (container && !container.running) {
			report("starting the Laya server");
			const started = await docker(["start", LAYA_CONTAINER], { signal, timeout: COMMAND_TIMEOUT_MS });
			if (started.code !== 0)
				return this.fail("failed", `Starting the Laya container failed: ${dockerError(started)}`);
		}

		// A running container that matches is only checked; nothing new to report.
		if (!matches || !container?.running) report("loading the Laya model");
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (Date.now() < deadline && !signal?.aborted) {
			if (await this.isUp()) {
				this.image = image;
				await this.removeOtherImages(image);
				return this.ready();
			}
			const current = await this.inspect(signal);
			if (!current?.running) {
				const logs = await docker(["logs", "--tail", "5", LAYA_CONTAINER], { signal, timeout: COMMAND_TIMEOUT_MS });
				return this.fail("failed", `The Laya container stopped: ${dockerError(logs)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
		return this.fail("failed", "The Laya server did not answer in time (see docker logs relay-laya)");
	}

	private ready(): true {
		this.state = "ready";
		this.detail = undefined;
		return true;
	}

	private runArgs(image: string, labels: Record<string, string>): string[] {
		return [
			"run",
			"--detach",
			"--name",
			LAYA_CONTAINER,
			"--restart",
			"unless-stopped",
			"--publish",
			`${labels[LABEL_ADDRESS]}:${LAYA_CONTAINER_PORT}`,
			"--volume",
			`${LAYA_MODELS_VOLUME}:${LAYA_IMAGE_PATHS.trainedModels}`,
			...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
			image,
			"python",
			LAYA_IMAGE_PATHS.serveScript,
			"--model",
			labels[LABEL_MODEL],
			"--host",
			"0.0.0.0",
			"--port",
			String(LAYA_CONTAINER_PORT),
		];
	}

	private async inspect(
		signal?: AbortSignal,
	): Promise<{ running: boolean; labels: Record<string, string> } | undefined> {
		const result = await this.options.docker(
			["container", "inspect", "--format", "{{json .State.Running}} {{json .Config.Labels}}", LAYA_CONTAINER],
			{ signal, timeout: COMMAND_TIMEOUT_MS },
		);
		if (result.code !== 0) return undefined;
		const [running, ...labels] = result.stdout.trim().split(" ");
		try {
			return {
				running: running === "true",
				labels: (JSON.parse(labels.join(" ")) as Record<string, string> | null) ?? {},
			};
		} catch {
			return { running: running === "true", labels: {} };
		}
	}

	/** Frees the disk taken by images of earlier Relay versions. */
	private async removeOtherImages(image: string): Promise<void> {
		const listed = await this.options.docker(
			["image", "ls", LAYA_IMAGE_REPOSITORY, "--format", "{{.Repository}}:{{.Tag}}"],
			{ timeout: COMMAND_TIMEOUT_MS },
		);
		if (listed.code !== 0) return;
		const others = listed.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((ref) => ref && ref !== image && !ref.endsWith(":<none>"));
		// An image still used by a training container is kept; rmi fails on it.
		if (others.length > 0) await this.options.docker(["rmi", ...others], { timeout: COMMAND_TIMEOUT_MS });
	}

	/** Stops the server container; the next install starts it again. */
	async stop(): Promise<void> {
		await this.options.docker(["stop", LAYA_CONTAINER], { timeout: COMMAND_TIMEOUT_MS });
		if (this.state === "ready") this.state = "unknown";
	}

	describe(): string {
		switch (this.state) {
			case "ready":
				return `running in Docker${this.image ? ` (${this.image}, model ${this.options.model()})` : ""}`;
			case "installing":
				return "installing in Docker";
			case "no-docker":
				return `not available: ${this.detail}`;
			case "failed":
				return `failed: ${this.detail}`;
			default:
				return "not checked yet";
		}
	}
}
