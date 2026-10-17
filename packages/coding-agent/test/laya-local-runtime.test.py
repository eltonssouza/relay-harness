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
        renamed = {**self.manifest, "version": "relay-laya-v5"}
        with patch.object(runtime.urllib.request, "urlopen", side_effect=AssertionError("network")):
            self.assertEqual(runtime.download_model(self.root, renamed), (model, 0))

    def test_path_cannot_escape_checkpoint_directory(self):
        self.manifest["files"][0]["path"] = "../../escape"
        with self.assertRaisesRegex(ValueError, "escapes"):
            runtime.download_model(self.root, self.manifest)

    def test_runtime_version_must_match_manifest(self):
        with self.assertRaisesRegex(RuntimeError, "requirements"):
            runtime.setup(self.root, {**self.manifest, "layaPackage": "laya[serve]==99.0.0"})

    # Regression #70: checkpoint enforcement must not contaminate task content for inference.
    def test_server_rejects_another_checkpoint_before_inference(self):
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
        server_manifest = {**self.manifest, "version": "relay-laya-v5", "files": [
            *self.manifest["files"],
            {"path": "model.safetensors", "asset": "model.safetensors",
             "size": len(self.data), "sha256": hashlib.sha256(self.data).hexdigest()},
        ]}
        manifest_path.write_text(json.dumps(server_manifest))
        artifact_input = "".join(chr(0).join((entry["path"], str(entry["size"]), entry["sha256"])) + chr(10)
                                 for entry in sorted(server_manifest["files"], key=lambda item: item["path"]))
        artifact_sha256 = hashlib.sha256(artifact_input.encode("utf-8")).hexdigest()
        package = Path(__file__).resolve().parents[1]
        docker_source = (package / "src/extensions/laya/runtime.ts").read_text(encoding="utf-8")
        docker_script = self.root / "docker-serve.py"
        docker_script.write_text(docker_source.split("export const SERVE_SCRIPT = `", 1)[1].split("`;", 1)[0], encoding="utf-8")
        scripts = [
            (package / "resources/laya/local-serve.py", ["serve", "--root", str(self.root), "--manifest", str(manifest_path)]),
            (docker_script, ["--model", "/opt/laya/model"]),
        ]
        real_open = Path.open

        def checkpoint_open(path, *arguments, **keywords):
            if path.name in ("model", "model.safetensors"):
                return io.BytesIO(self.data)
            return real_open(path, *arguments, **keywords)

        for script, arguments in scripts:
            with self.subTest(server=script.name), patch.dict(sys.modules, {"laya": laya, "torch": MagicMock(), "uvicorn": MagicMock(), "fastapi": fastapi}), patch.object(sys, "argv", [str(script), *arguments]), patch.dict(runtime.os.environ), patch.object(Path, "read_text", return_value=manifest_path.read_text()), patch.object(Path, "open", checkpoint_open):
                laya.reset_mock()
                laya.load.return_value.predict.return_value = {"answers": {}, "usage": {"truncated": False}}
                endpoints = runpy.run_path(str(script))
                self.assertEqual(endpoints["health"]()["version"], "relay-laya-v5")
                self.assertEqual(endpoints["health"]()["sha256"], hashlib.sha256(self.data).hexdigest())
                self.assertEqual(endpoints["health"]()["artifact_sha256"], artifact_sha256)
                body = {"state": {"required_model": "relay-laya-v3", "goal": "Document release notes", "nested": {"required_model": "semantic-data"}}, "questions": {"decision": {"type": "noul"}}}
                with self.assertRaises(HttpError) as rejected:
                    endpoints["system_one"](body)
                self.assertEqual(rejected.exception.status_code, 409)
                laya.load.return_value.predict.assert_not_called()
                body["state"]["required_model"] = "relay-laya-v5"
                body["state"]["required_checkpoint_sha256"] = "0" * 64
                with self.assertRaises(HttpError) as wrong_weights:
                    endpoints["system_one"](body)
                self.assertEqual(wrong_weights.exception.status_code, 409)
                laya.load.return_value.predict.assert_not_called()
                body["state"]["required_checkpoint_sha256"] = hashlib.sha256(self.data).hexdigest()
                body["state"]["required_artifact_sha256"] = "0" * 64
                with self.assertRaises(HttpError) as wrong_configuration:
                    endpoints["system_one"](body)
                self.assertEqual(wrong_configuration.exception.status_code, 409)
                laya.load.return_value.predict.assert_not_called()
                body["state"]["required_artifact_sha256"] = artifact_sha256
                endpoints["system_one"](body)
                laya.load.return_value.predict.assert_called_once_with(
                    {"goal": "Document release notes", "nested": {"required_model": "semantic-data"}}, body["questions"]
                )
                self.assertEqual(body["state"]["required_model"], "relay-laya-v5")
                self.assertEqual(body["state"]["required_checkpoint_sha256"], hashlib.sha256(self.data).hexdigest())
                self.assertEqual(body["state"]["required_artifact_sha256"], artifact_sha256)
                laya.load.return_value.predict.return_value = {"answers": {}, "usage": {"truncated": True}}
                with self.assertRaises(HttpError) as truncated:
                    endpoints["system_one"](body)
                self.assertEqual(truncated.exception.status_code, 422)
                # Requests pinned to a checkpoint require the full observation; ordinary routing permits truncation.
                ordinary = {**body, "state": {"goal": "Document release notes"}}
                self.assertTrue(endpoints["system_one"](ordinary)["usage"]["truncated"])
                for damaged in ("model", "model.safetensors"):
                    def corrupt_open(path, *arguments, **keywords):
                        if path.name == damaged:
                            return io.BytesIO(b"x" * len(self.data))
                        return checkpoint_open(path, *arguments, **keywords)

                    with self.subTest(corrupt=damaged), patch.object(Path, "open", corrupt_open):
                        laya.reset_mock()
                        with self.assertRaisesRegex(ValueError, "pinned manifest"):
                            runpy.run_path(str(script))
                        laya.load.assert_not_called()
                for missing_file in ("model", "model.safetensors"):
                    def missing_open(path, *arguments, **keywords):
                        if path.name == missing_file:
                            raise FileNotFoundError(path)
                        return checkpoint_open(path, *arguments, **keywords)

                    with self.subTest(missing=missing_file), patch.object(Path, "open", missing_open):
                        laya.reset_mock()
                        with self.assertRaises(FileNotFoundError):
                            runpy.run_path(str(script))
                        laya.load.assert_not_called()
                missing = {**server_manifest, "files": self.manifest["files"]}
                with patch.object(Path, "read_text", return_value=json.dumps(missing)):
                    laya.reset_mock()
                    with self.assertRaisesRegex(ValueError, "does not identify model.safetensors"):
                        runpy.run_path(str(script))
                    laya.load.assert_not_called()
                for changed_during_load in ("model", "model.safetensors"):
                    def changed_after_load_open(path, *arguments, **keywords):
                        if laya.load.called and path.name == changed_during_load:
                            return io.BytesIO(b"x" * len(self.data))
                        return checkpoint_open(path, *arguments, **keywords)

                    with self.subTest(changed_during_load=changed_during_load), patch.object(Path, "open", changed_after_load_open):
                        laya.reset_mock()
                        sys.modules["uvicorn"].reset_mock()
                        with self.assertRaisesRegex(ValueError, "pinned manifest"):
                            runpy.run_path(str(script))
                        sys.modules["uvicorn"].run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
