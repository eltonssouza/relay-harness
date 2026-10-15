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
# Small classifier batches slow down when every logical CPU starts a worker.
torch.set_num_threads(min(4, os.cpu_count() or 1))
agent = laya.load(str(model), device="cpu")
app = FastAPI(title="relay-laya-local")


@app.get("/health")
def health():
    return {"ok": True, "runtime": "native", "model": str(model), "version": manifest["version"]}


@app.post("/v1/systemone")
def system_one(body: dict):
    if "state" not in body or not body.get("questions"):
        raise HTTPException(422, "send 'state' and 'questions'")
    state = body["state"]
    required = state.get("required_model") if isinstance(state, dict) else None
    if required and required != manifest["version"]:
        raise HTTPException(409, "The requested XP checkpoint is not active")
    return agent.predict(body["state"], body["questions"])


uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
