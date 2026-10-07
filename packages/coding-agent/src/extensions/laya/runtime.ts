import { createHash } from "node:crypto";
import { TRAIN_SCRIPT } from "./train-script.ts";

/**
 * Laya runs in Docker, never on the host: an image carries Python, torch, the `laya` package, the
 * shipped model and the scripts that serve and train it. Relay pulls the image, keeps one server
 * container running and starts a short-lived container for each training. The host only keeps
 * Relay's own data (training exercises, the model registry, telemetry).
 */

export interface LayaModelFile {
	/** Path inside the model directory, with forward slashes. */
	path: string;
	/** File name in the model repository. */
	asset: string;
	size: number;
	sha256: string;
}

export interface LayaModelManifest {
	version: string;
	/** pip requirement for the Laya runtime. */
	layaPackage: string;
	/** Directory URL the model files are downloaded from when the image is built, ending in a slash. */
	baseUrl: string;
	files: LayaModelFile[];
}

/** Registry the images are published to. */
export const LAYA_IMAGE_REPOSITORY = "ghcr.io/eltonssouza/relay-laya";
/** The server container, kept running between Relay sessions. */
export const LAYA_CONTAINER = "relay-laya";
/** The container of a running training; removed when it ends. */
export const LAYA_TRAIN_CONTAINER = "relay-laya-train";
/** Volume with the models trained from sessions. */
export const LAYA_MODELS_VOLUME = "relay-laya-models";
/** Port the server listens on inside its container. */
export const LAYA_CONTAINER_PORT = 8000;

/** Paths inside the image and its containers. */
export const LAYA_IMAGE_PATHS = {
	shippedModel: "/opt/laya/model",
	trainedModels: "/data/models",
	serveScript: "/opt/laya/serve.py",
	trainScript: "/opt/laya/train.py",
	workspace: "/workspace",
} as const;

/** `cpu` runs everywhere; `cuda` carries the CUDA build of torch for machines with an NVIDIA GPU. */
export type LayaImageVariant = "cpu" | "cuda";

const TORCH_INDEX: Record<LayaImageVariant, string> = {
	cpu: "https://download.pytorch.org/whl/cpu",
	cuda: "https://download.pytorch.org/whl/cu128",
};

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

/** Downloads the shipped model while the image is built, checking every file against the manifest. */
export const FETCH_MODEL_SCRIPT = `import hashlib
import json
import pathlib
import sys
import urllib.request

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
target = pathlib.Path(sys.argv[2])
for file in manifest["files"]:
    path = target / file["path"]
    path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(manifest["baseUrl"] + file["asset"]) as response, open(path, "wb") as out:
        while chunk := response.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)
            out.write(chunk)
    if size != file["size"] or digest.hexdigest() != file["sha256"]:
        sys.exit(f"{file['asset']} does not match the manifest (size {size}, sha256 {digest.hexdigest()})")
    print(f"{file['path']} ok", flush=True)
`;

function dockerfile(manifest: LayaModelManifest, variant: LayaImageVariant): string {
	const paths = LAYA_IMAGE_PATHS;
	return `FROM python:3.11-slim
LABEL org.opencontainers.image.source="https://github.com/eltonssouza/relay-harness"
LABEL org.opencontainers.image.description="Laya routing model for Relay (${variant})"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 PIP_NO_CACHE_DIR=1 \\
    PIP_DISABLE_PIP_VERSION_CHECK=1 USE_TF=0 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false
RUN pip install --upgrade pip && pip install torch --index-url ${TORCH_INDEX[variant]}
RUN pip install "${manifest.layaPackage}" fastapi uvicorn
RUN useradd --create-home laya && mkdir -p ${paths.trainedModels} && chown laya ${paths.trainedModels}
COPY fetch_model.py model.json /opt/laya/
RUN python /opt/laya/fetch_model.py /opt/laya/model.json ${paths.shippedModel}
COPY serve.py train.py /opt/laya/
USER laya
EXPOSE ${LAYA_CONTAINER_PORT}
CMD ["python", "${paths.serveScript}", "--model", "${paths.shippedModel}", "--host", "0.0.0.0", "--port", "${LAYA_CONTAINER_PORT}"]
`;
}

/** Files of the image's build context, by name. */
export function layaImageContext(manifest: LayaModelManifest, variant: LayaImageVariant): Record<string, string> {
	return {
		Dockerfile: dockerfile(manifest, variant),
		"fetch_model.py": FETCH_MODEL_SCRIPT,
		"model.json": `${JSON.stringify({ baseUrl: manifest.baseUrl, files: manifest.files }, null, 2)}\n`,
		"serve.py": SERVE_SCRIPT,
		"train.py": TRAIN_SCRIPT,
	};
}

/**
 * Image tag: the model version, the variant and a hash of the build context. Changing a script, a
 * dependency or the model gives a new tag, so a Relay version always runs the image built from its
 * own sources, and an unchanged context reuses the published image.
 */
export function layaImageTag(manifest: LayaModelManifest, variant: LayaImageVariant): string {
	const hash = createHash("sha256");
	for (const [name, content] of Object.entries(layaImageContext(manifest, variant)).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		hash.update(`${name}\0${content}\0`);
	}
	return `${manifest.version}-${variant}-${hash.digest("hex").slice(0, 12)}`;
}

export function layaImage(manifest: LayaModelManifest, variant: LayaImageVariant): string {
	return `${LAYA_IMAGE_REPOSITORY}:${layaImageTag(manifest, variant)}`;
}

/** Container path of a model trained from sessions. */
export function trainedModelPath(name: string): string {
	return `${LAYA_IMAGE_PATHS.trainedModels}/${name}`;
}
