"""Install and serve Relay's pinned Laya checkpoint without Docker or CUDA."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import venv


TORCH_VERSION = "2.14.1"
REQUIREMENTS = [
    "laya==0.3.27",
    "transformers==5.19.0",
    "fastapi==0.143.1",
    "uvicorn==0.54.0",
]


def python_path(root):
    return root / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def file_matches(path, entry):
    if not path.is_file() or path.stat().st_size != entry["size"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == entry["sha256"]


def model_dir(root, manifest):
    # The revision, not a mutable model name, identifies the download cache.
    cache_manifest = {key: value for key, value in manifest.items() if key != "version"}
    identity = hashlib.sha256(json.dumps(cache_manifest, sort_keys=True).encode()).hexdigest()[:16]
    return root / "checkpoints" / identity


def download_model(root, manifest):
    target = model_dir(root, manifest)
    downloaded = 0
    for entry in manifest["files"]:
        path = target / entry["path"]
        if not path.resolve().is_relative_to(target.resolve()):
            raise ValueError("Model path escapes checkpoint directory")
        if file_matches(path, entry):
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + ".partial")
        print(f"downloading {entry['path']} ({entry['size'] / 1e6:.1f} MB)", flush=True)
        try:
            with urllib.request.urlopen(manifest["baseUrl"] + entry["asset"], timeout=60) as response:
                with partial.open("wb") as output:
                    for chunk in iter(lambda: response.read(1024 * 1024), b""):
                        output.write(chunk)
                        downloaded += len(chunk)
            if not file_matches(partial, entry):
                raise ValueError(f"{entry['path']} does not match the pinned manifest")
            partial.replace(path)
        finally:
            partial.unlink(missing_ok=True)
    return target, downloaded


def setup(root, manifest):
    if not (3, 10) <= sys.version_info[:2] <= (3, 13):
        raise RuntimeError("Local Laya requires Python 3.10 through 3.13")
    if manifest["layaPackage"] != "laya[serve]==0.3.27":
        raise RuntimeError("Update the local runtime requirements for this Laya package version")
    root.mkdir(parents=True, exist_ok=True)
    python = python_path(root)
    signature = json.dumps([TORCH_VERSION, REQUIREMENTS])
    marker = root / "dependencies.json"
    if not python.is_file():
        print("creating the isolated Python environment", flush=True)
        venv.create(root / "venv", with_pip=True)
    if not marker.is_file() or marker.read_text(encoding="utf-8") != signature:
        print("installing CPU-only PyTorch and Laya (no CUDA packages)", flush=True)
        pip = [str(python), "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--only-binary=:all:"]
        subprocess.run(pip + [f"torch=={TORCH_VERSION}", "--index-url", "https://download.pytorch.org/whl/cpu", "--report", str(root / "torch-install.json")], check=True)
        subprocess.run(pip + REQUIREMENTS + [f"torch=={TORCH_VERSION}", "--index-url", "https://pypi.org/simple", "--report", str(root / "laya-install.json")], check=True)
        marker.write_text(signature, encoding="utf-8")
    target, downloaded = download_model(root, manifest)
    print(json.dumps({"model": str(target), "model_download_bytes": downloaded}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["setup"])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    model_manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    setup(args.root, model_manifest)
