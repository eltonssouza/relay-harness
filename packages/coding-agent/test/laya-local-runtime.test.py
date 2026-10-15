"""Offline checks for native checkpoint download integrity and cache reuse."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "local_runtime", Path(__file__).resolve().parents[1] / "resources/laya/local-runtime.py"
)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class LocalRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = b"trained-checkpoint"
        self.manifest = {
            "version": "test", "baseUrl": "https://example.invalid/pinned/",
            "files": [{"path": "encoder/model", "asset": "encoder/model",
                       "size": len(self.data), "sha256": hashlib.sha256(self.data).hexdigest()}],
        }

    def test_verified_download_is_reused_offline(self):
        with patch.object(runtime.urllib.request, "urlopen", return_value=io.BytesIO(self.data)) as fetch:
            model, count = runtime.download_model(self.root, self.manifest)
            self.assertEqual(count, len(self.data))
            self.assertEqual((model / "encoder/model").read_bytes(), self.data)
            fetch.assert_called_once_with("https://example.invalid/pinned/encoder/model", timeout=60)
        with patch.object(runtime.urllib.request, "urlopen", side_effect=AssertionError("network")):
            self.assertEqual(runtime.download_model(self.root, self.manifest), (model, 0))

    def test_corrupt_download_never_becomes_active(self):
        with patch.object(runtime.urllib.request, "urlopen", return_value=io.BytesIO(b"x" * len(self.data))):
            with self.assertRaisesRegex(ValueError, "pinned manifest"):
                runtime.download_model(self.root, self.manifest)
        target = runtime.model_dir(self.root, self.manifest) / "encoder/model"
        self.assertFalse(target.exists())
        self.assertFalse(target.with_name("model.partial").exists())

    def test_failed_update_preserves_existing_file(self):
        target = runtime.model_dir(self.root, self.manifest) / "encoder/model"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"previous file")
        with patch.object(runtime.urllib.request, "urlopen", return_value=io.BytesIO(b"bad")):
            with self.assertRaises(ValueError):
                runtime.download_model(self.root, self.manifest)
        self.assertEqual(target.read_bytes(), b"previous file")

    def test_same_size_corruption_is_detected_and_repaired(self):
        target = runtime.model_dir(self.root, self.manifest) / "encoder/model"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"x" * len(self.data))
        with patch.object(runtime.urllib.request, "urlopen", return_value=io.BytesIO(self.data)):
            runtime.download_model(self.root, self.manifest)
        self.assertEqual(target.read_bytes(), self.data)

    def test_revision_has_separate_cache(self):
        changed = {**self.manifest, "baseUrl": "https://example.invalid/another-revision/"}
        self.assertNotEqual(runtime.model_dir(self.root, self.manifest), runtime.model_dir(self.root, changed))

    def test_renaming_model_reuses_cached_weights_without_network(self):
        with patch.object(runtime.urllib.request, "urlopen", return_value=io.BytesIO(self.data)):
            model, _ = runtime.download_model(self.root, self.manifest)
        renamed = {**self.manifest, "version": "relay-laya-v4"}
        with patch.object(runtime.urllib.request, "urlopen", side_effect=AssertionError("network")):
            self.assertEqual(runtime.download_model(self.root, renamed), (model, 0))

    def test_path_cannot_escape_checkpoint_directory(self):
        self.manifest["files"][0]["path"] = "../../escape"
        with self.assertRaisesRegex(ValueError, "escapes"):
            runtime.download_model(self.root, self.manifest)

    def test_runtime_version_must_match_manifest(self):
        with self.assertRaisesRegex(RuntimeError, "requirements"):
            runtime.setup(self.root, {**self.manifest, "layaPackage": "laya[serve]==99.0.0"})

    def test_server_rejects_another_xp_checkpoint_before_inference(self):
        # Exercise the actual endpoint functions without loading weights or opening a port.
        class HttpError(Exception):
            def __init__(self, status, detail):
                self.status_code = status
                super().__init__(detail)

        app = MagicMock()
        app.get.return_value = lambda function: function
        app.post.return_value = lambda function: function
        fastapi = MagicMock(FastAPI=MagicMock(return_value=app), HTTPException=HttpError)
        laya = MagicMock()
        manifest_path = self.root / "manifest.json"
        manifest_path.write_text(json.dumps({**self.manifest, "version": "relay-laya-v4"}))
        argv = ["local-serve.py", "serve", "--root", str(self.root), "--manifest", str(manifest_path)]
        with patch.dict(sys.modules, {"laya": laya, "torch": MagicMock(), "uvicorn": MagicMock(), "fastapi": fastapi}), patch.object(sys, "argv", argv), patch.dict(runtime.os.environ):
            endpoints = runpy.run_path(str(Path(__file__).resolve().parents[1] / "resources/laya/local-serve.py"))
            self.assertEqual(endpoints["health"]()["version"], "relay-laya-v4")
            body = {"state": {"required_model": "relay-laya-v3"}, "questions": {"decision": {"type": "bool"}}}
            with self.assertRaises(HttpError) as rejected:
                endpoints["system_one"](body)
            self.assertEqual(rejected.exception.status_code, 409)
            laya.load.return_value.predict.assert_not_called()
            body["state"]["required_model"] = "relay-laya-v4"
            endpoints["system_one"](body)
            laya.load.return_value.predict.assert_called_once_with(body["state"], body["questions"])


if __name__ == "__main__":
    unittest.main()
