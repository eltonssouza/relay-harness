"""Serve Relay's trained checkpoint on CPU using the System One protocol."""

import argparse
import hashlib
import json
import os
from pathlib import Path

# Set these before importing the inference libraries.
os.environ.update({
    "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
    "TOKENIZERS_PARALLELISM": "false", "USE_TF": "0",
})

import laya
import torch
import uvicorn
from fastapi import FastAPI, HTTPException


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("command", choices=["serve"])
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--manifest", type=Path, required=True)
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8737)
args = parser.parse_args()
manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
cache_manifest = {key: value for key, value in manifest.items() if key != "version"}
identity = hashlib.sha256(json.dumps(cache_manifest, sort_keys=True).encode()).hexdigest()[:16]
model = args.root / "checkpoints" / identity


def verify_checkpoint():
    verified = {}
    for entry in manifest["files"]:
        path = (model / entry["path"]).resolve()
        if not path.is_relative_to(model.resolve()):
            raise ValueError("Model path escapes checkpoint directory")
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
        if size != entry["size"] or digest.hexdigest() != entry["sha256"]:
            raise ValueError(f"{entry['path']} does not match the pinned manifest")
        verified[entry["path"]] = digest.hexdigest()
    checkpoint = verified.get("model.safetensors")
    if not checkpoint:
        raise ValueError("The pinned manifest does not identify model.safetensors")
    artifact = hashlib.sha256()
    for entry in sorted(manifest["files"], key=lambda item: item["path"]):
        artifact.update((chr(0).join((entry["path"], str(entry["size"]), verified[entry["path"]])) + chr(10)).encode("utf-8"))
    return checkpoint, artifact.hexdigest()


checkpoint_sha256, artifact_sha256 = verify_checkpoint()
# Small classifier batches slow down when every logical CPU starts a worker.
torch.set_num_threads(min(4, os.cpu_count() or 1))
agent = laya.load(str(model), device="cpu")
if verify_checkpoint() != (checkpoint_sha256, artifact_sha256):
    raise ValueError("Checkpoint files changed while loading")
app = FastAPI(title="relay-laya-local")


@app.get("/health")
def health():
    return {"ok": True, "runtime": "native", "model": str(model), "version": manifest["version"], "sha256": checkpoint_sha256, "artifact_sha256": artifact_sha256}


@app.post("/v1/systemone")
def system_one(body: dict):
    if "state" not in body or not body.get("questions"):
        raise HTTPException(422, "send 'state' and 'questions'")
    state = dict(body["state"]) if isinstance(body["state"], dict) else body["state"]
    # Checkpoint enforcement is transport metadata, not task content for inference.
    required = state.pop("required_model", None) if isinstance(state, dict) else None
    required_sha256 = state.pop("required_checkpoint_sha256", None) if isinstance(state, dict) else None
    required_artifact = state.pop("required_artifact_sha256", None) if isinstance(state, dict) else None
    if required and required != manifest["version"]:
        raise HTTPException(409, "The requested Laya checkpoint is not active")
    if required_sha256 and required_sha256 != checkpoint_sha256:
        raise HTTPException(409, "The requested Laya checkpoint weights are not active")
    if required_artifact and required_artifact != artifact_sha256:
        raise HTTPException(409, "The requested Laya checkpoint configuration is not active")
    result = agent.predict(state, body["questions"])
    if (required or required_sha256 or required_artifact) and result.get("usage", {}).get("truncated"):
        raise HTTPException(422, "The Laya decision context was truncated")
    return result


uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
