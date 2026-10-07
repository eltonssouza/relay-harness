import { describe, expect, it } from "vitest";
import type { DockerResult, DockerRun, DockerRunOptions } from "../src/extensions/laya/docker.ts";
import { DOCKER_MISSING } from "../src/extensions/laya/docker.ts";
import { LAYA_MODEL_MANIFEST } from "../src/extensions/laya/model-manifest.ts";
import {
	LAYA_IMAGE_PATHS,
	LAYA_IMAGE_REPOSITORY,
	type LayaModelManifest,
	layaImage,
	layaImageContext,
	layaImageTag,
} from "../src/extensions/laya/runtime.ts";
import { isLocalUrl, LayaServer } from "../src/extensions/laya/server.ts";

const manifest: LayaModelManifest = {
	version: "v-test",
	layaPackage: "laya[serve]==0.0.0",
	baseUrl: "https://example.test/models/",
	files: [{ path: "model.safetensors", asset: "model.safetensors", size: 5, sha256: "a".repeat(64) }],
};

const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "error"): DockerResult => ({ code: 1, stdout: "", stderr });

/** A Docker CLI stand-in: answers each command with the first handler whose prefix matches. */
function fakeDocker(handlers: Array<[string[], (args: string[], options?: DockerRunOptions) => DockerResult]>) {
	const calls: string[][] = [];
	const docker: DockerRun = async (args, options) => {
		calls.push(args);
		const handler = handlers.find(([prefix]) => prefix.every((part, i) => args[i] === part));
		return handler ? handler[1](args, options) : fail(`unexpected: docker ${args.join(" ")}`);
	};
	return { docker, calls };
}

/** Health checks answer only while `state.up` is true. */
function health(state: { up: boolean }): typeof fetch {
	return (async () => {
		if (!state.up) throw new Error("ECONNREFUSED");
		return new Response(JSON.stringify({ ok: true }));
	}) as typeof fetch;
}

const IMAGE = `${LAYA_IMAGE_REPOSITORY}:v1-cpu-abc`;

function server(docker: DockerRun, state: { up: boolean }, model: string = LAYA_IMAGE_PATHS.shippedModel) {
	return new LayaServer({
		docker,
		baseUrl: () => "http://127.0.0.1:8000/v1",
		image: async () => IMAGE,
		model: () => model,
		fetch: health(state),
	});
}

const labels = (model: string = LAYA_IMAGE_PATHS.shippedModel) =>
	JSON.stringify({ "relay.laya.image": IMAGE, "relay.laya.model": model, "relay.laya.address": "127.0.0.1:8000" });

describe("laya image", () => {
	it("tags the image with the model version, the variant and a hash of its build context", () => {
		const cpu = layaImageTag(manifest, "cpu");
		expect(cpu).toMatch(/^v-test-cpu-[0-9a-f]{12}$/);
		expect(layaImageTag(manifest, "cpu")).toBe(cpu);
		expect(layaImageTag(manifest, "cuda")).toMatch(/^v-test-cuda-/);
		// A different model or Laya version is a different image.
		expect(layaImageTag({ ...manifest, layaPackage: "laya[serve]==0.0.1" }, "cpu")).not.toBe(cpu);
		expect(layaImage(manifest, "cpu")).toBe(`${LAYA_IMAGE_REPOSITORY}:${cpu}`);
	});

	it("builds Python, torch, Laya and the shipped model into the image", () => {
		const cpu = layaImageContext(manifest, "cpu");
		expect(cpu.Dockerfile).toContain("https://download.pytorch.org/whl/cpu");
		expect(cpu.Dockerfile).toContain('pip install "laya[serve]==0.0.0"');
		expect(cpu.Dockerfile).toContain(`fetch_model.py /opt/laya/model.json ${LAYA_IMAGE_PATHS.shippedModel}`);
		expect(layaImageContext(manifest, "cuda").Dockerfile).toContain("https://download.pytorch.org/whl/cu128");
		expect(JSON.parse(cpu["model.json"])).toEqual({ baseUrl: manifest.baseUrl, files: manifest.files });
		expect(cpu["train.py"]).toContain("def cmd_learn(a):");
		expect(cpu["serve.py"]).toContain('@app.post("/v1/systemone")');
	});

	it("ships a manifest that matches the model layout the server loads", () => {
		const paths = LAYA_MODEL_MANIFEST.files.map((file) => file.path);
		expect(paths).toEqual(
			expect.arrayContaining([
				"model.safetensors",
				"rl_agent_config.json",
				"encoder/config.json",
				"tokenizer/tokenizer.json",
			]),
		);
		for (const file of LAYA_MODEL_MANIFEST.files) {
			expect(file.asset).toBe(file.path);
			expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(LAYA_MODEL_MANIFEST.baseUrl).toMatch(/^https:\/\/.+\/$/);
	});
});

describe("laya server container", () => {
	it("only manages servers on this machine", () => {
		expect(isLocalUrl("http://127.0.0.1:8000/v1")).toBe(true);
		expect(isLocalUrl("http://localhost:8000/v1")).toBe(true);
		expect(isLocalUrl("https://laya.example.com/v1")).toBe(false);
	});

	it("reports a missing or stopped Docker", async () => {
		const missing = fakeDocker([[["version"], () => ({ code: DOCKER_MISSING, stdout: "", stderr: "not found" })]]);
		const withoutDocker = server(missing.docker, { up: false });
		expect(await withoutDocker.install()).toBe(false);
		expect(withoutDocker.state).toBe("no-docker");
		expect(withoutDocker.describe()).toBe("not available: Docker is not installed");

		const stopped = fakeDocker([[["version"], () => fail("Cannot connect to the Docker daemon")]]);
		const withStoppedDocker = server(stopped.docker, { up: false });
		expect(await withStoppedDocker.install()).toBe(false);
		expect(withStoppedDocker.describe()).toContain("Docker does not answer");
	});

	it("pulls the image, starts the container on the local port and frees older images", async () => {
		const state = { up: false };
		const reports: string[] = [];
		const { docker, calls } = fakeDocker([
			[["version"], () => ok("29.0.0")],
			[["container", "inspect"], () => fail("No such container")],
			[["image", "inspect"], () => fail("No such image")],
			[
				["pull"],
				(_args, options) => {
					for (const line of [
						"a1: Pulling fs layer",
						"b2: Pulling fs layer",
						"a1: Pull complete",
						"b2: Pull complete",
					]) {
						options?.onLine?.(line, "stdout");
					}
					return ok();
				},
			],
			[
				["run"],
				() => {
					state.up = true;
					return ok("container-id");
				},
			],
			[["image", "ls"], () => ok(`${IMAGE}\n${LAYA_IMAGE_REPOSITORY}:v1-cpu-old\n`)],
			[["rmi"], () => ok()],
		]);
		const laya = server(docker, state);

		expect(await laya.install((message) => reports.push(message))).toBe(true);

		expect(laya.state).toBe("ready");
		expect(reports).toContain("downloading the Laya image: 2/2 layers");
		const run = calls.find((args) => args[0] === "run");
		expect(run).toEqual(
			expect.arrayContaining([
				"--detach",
				"--restart",
				"unless-stopped",
				"--publish",
				"127.0.0.1:8000:8000",
				"--volume",
				`relay-laya-models:${LAYA_IMAGE_PATHS.trainedModels}`,
				IMAGE,
				"--model",
				LAYA_IMAGE_PATHS.shippedModel,
			]),
		);
		expect(calls.find((args) => args[0] === "rmi")).toEqual(["rmi", `${LAYA_IMAGE_REPOSITORY}:v1-cpu-old`]);
	});

	it("starts a stopped container that runs the right image and model", async () => {
		const state = { up: false };
		const { docker, calls } = fakeDocker([
			[["version"], () => ok("29.0.0")],
			[["container", "inspect"], () => ok(`false ${labels()}`)],
			[["image", "inspect"], () => ok("sha256:1")],
			[
				["start"],
				() => {
					state.up = true;
					return ok();
				},
			],
			[["image", "ls"], () => ok(IMAGE)],
		]);
		expect(await server(docker, state).install()).toBe(true);
		expect(calls.map((args) => args[0])).not.toContain("pull");
		expect(calls.map((args) => args[0])).not.toContain("run");
		expect(calls).toContainEqual(["start", "relay-laya"]);
	});

	it("leaves a running container that matches alone and reports nothing", async () => {
		const reports: string[] = [];
		const { docker, calls } = fakeDocker([
			[["version"], () => ok("29.0.0")],
			[["container", "inspect"], () => ok(`true ${labels()}`)],
			[["image", "inspect"], () => ok("sha256:1")],
			[["image", "ls"], () => ok(IMAGE)],
		]);
		expect(await server(docker, { up: true }).install((message) => reports.push(message))).toBe(true);
		expect(reports).toEqual([]);
		expect(calls.map((args) => args[0])).toEqual(["version", "container", "image", "image"]);
	});

	it("replaces the container when the active model changes", async () => {
		const state = { up: true };
		const trained = "/data/models/local-1";
		const { docker, calls } = fakeDocker([
			[["version"], () => ok("29.0.0")],
			[["container", "inspect"], () => ok(`true ${labels()}`)],
			[["image", "inspect"], () => ok("sha256:1")],
			[["rm"], () => ok()],
			[["run"], () => ok("container-id")],
			[["image", "ls"], () => ok(IMAGE)],
		]);
		expect(await server(docker, state, trained).install()).toBe(true);
		expect(calls).toContainEqual(["rm", "--force", "relay-laya"]);
		const run = calls.find((args) => args[0] === "run");
		expect(run?.[run.indexOf("--model") + 1]).toBe(trained);
	});

	it("uses a server that already answers when the container is not Relay's", async () => {
		const { docker, calls } = fakeDocker([
			[["version"], () => ok("29.0.0")],
			[["container", "inspect"], () => fail("No such container")],
		]);
		expect(await server(docker, { up: true }).install()).toBe(true);
		expect(calls.map((args) => args[0])).toEqual(["version", "container"]);
	});

	it("refuses a server on the port that answers other questions", async () => {
		const { docker, calls } = fakeDocker([
			[["version"], () => ok("29.0.0")],
			[["container", "inspect"], () => fail("No such container")],
		]);
		const laya = new LayaServer({
			docker,
			baseUrl: () => "http://127.0.0.1:8000/v1",
			image: async () => IMAGE,
			model: () => LAYA_IMAGE_PATHS.shippedModel,
			// A laya-trainer server of another project.
			fetch: (async () =>
				new Response(JSON.stringify({ ok: true, decisions: ["natureza", "intencao"] }))) as typeof fetch,
		});
		expect(await laya.install()).toBe(false);
		expect(laya.describe()).toContain("another Laya server, which answers other questions, uses 127.0.0.1:8000");
		expect(calls.map((args) => args[0])).not.toContain("run");
	});

	it("fails with the container's last log lines when it stops while loading", async () => {
		let inspections = 0;
		const { docker } = fakeDocker([
			[["version"], () => ok("29.0.0")],
			// Missing at first, created, then found stopped.
			[["container", "inspect"], () => (inspections++ === 0 ? fail("No such container") : ok(`false ${labels()}`))],
			[["image", "inspect"], () => ok("sha256:1")],
			[["run"], () => ok("container-id")],
			[["logs"], () => ({ code: 0, stdout: "", stderr: "RuntimeError: model.safetensors is corrupt" })],
		]);
		const laya = server(docker, { up: false });
		expect(await laya.install()).toBe(false);
		expect(laya.describe()).toBe("failed: The Laya container stopped: RuntimeError: model.safetensors is corrupt");
	});
});
