"""Native Nano routing gates, without downloading or opening model weights."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from plur1bus_hermes.jina_v5_nano import default_config
from plur1bus_hermes.operator_cli import main
from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.runtime import EmbeddingBackend
from plur1bus_hermes.validation import ValidationError


class NanoIntegrationTests(unittest.TestCase):
    def test_native_encoder_routes_purposes_and_closes(self):
        with tempfile.TemporaryDirectory() as temp, patch("plur1bus_hermes.jina_v5_nano.JinaV5NanoEncoder") as factory:
            factory.return_value.embed.return_value = [1.0] + [0.0] * 31
            backend = EmbeddingBackend(default_config(Path(temp) / "model", 32, True), Path(temp))
            try:
                self.assertEqual(len(backend.embed("document")), 32)
                backend.embed("question", purpose="query")
                self.assertEqual(factory.call_count, 1)
                self.assertEqual(factory.return_value.embed.call_args.kwargs, {"purpose": "query"})
            finally:
                backend.close()
            factory.return_value.close.assert_called_once()

    def test_license_and_config_validation_precedes_even_cache_hits(self):
        with tempfile.TemporaryDirectory() as temp:
            config = default_config(Path(temp) / "model", 32, True)
            backend = EmbeddingBackend(config, Path(temp))
            try:
                with patch.object(backend._cache, "get_or_compute", return_value=[1.0] * 32) as cache:
                    backend.embed("cached")
                    config["licenseAccepted"] = False
                    with self.assertRaisesRegex(ValidationError, "CC-BY-NC"):
                        backend.embed("cached")
                    self.assertEqual(cache.call_count, 1)
            finally:
                backend.close()

    def test_generic_transformer_and_fallback_cannot_bypass_native_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            config = default_config(Path(temp) / "model", accepted=True)
            variants = [
                {**config, "provider": "local-transformers"},
                {**config, "provider": "openai-compatible"},
                {**config, "provider": "omlx"},
                {**config, "fallback": {"provider": "local-transformers", "dimensions": 768}},
                {"provider": "openai-compatible", "dimensions": 768, "fallback": config},
            ]
            for candidate in variants:
                with self.subTest(candidate=candidate):
                    backend = EmbeddingBackend(candidate, Path(temp))
                    try:
                        with self.assertRaises(ValidationError):
                            backend.embed("never download")
                    finally:
                        backend.close()

    def test_provider_accepts_native_dependencies_without_sentence_transformers(self):
        config = {"embedding": default_config("/models/nano", accepted=True), "reranker": {"provider": "disabled"}}
        provider = object.__new__(Plur1busMemoryProvider)
        provider.config = config
        provider._closed = False
        with patch.object(provider, "_runtime_config", return_value=config), patch(
            "plur1bus_hermes.provider.importlib.util.find_spec",
            side_effect=lambda name: None if name == "sentence_transformers" else object(),
        ):
            provider._validate_runtime_config()
            self.assertTrue(provider.is_available())
        with patch.object(provider, "_runtime_config", return_value=config), patch(
            "plur1bus_hermes.provider.importlib.util.find_spec", return_value=None,
        ):
            self.assertFalse(provider.is_available())
            self.assertIn("onnxruntime", provider.unavailable_reason())

    def test_model_plan_no_acceptance_never_downloads_or_changes_config(self):
        with tempfile.TemporaryDirectory() as temp, patch("plur1bus_hermes.operator_cli.runtime_view"), patch(
            "plur1bus_hermes.jina_v5_nano.prepare_model"
        ) as prepare:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = main(["--hermes-home", temp, "--agent", "default", "embedding-model", "plan", "--model-dir", str(Path(temp) / "model")])
            self.assertEqual(result, 0)
            report = json.loads(output.getvalue())
            self.assertFalse(report["licenseAccepted"])
            self.assertEqual(report["newInstallSelection"]["model"], "intfloat/multilingual-e5-base")
            self.assertTrue(report["activeConfigurationUnchanged"])
            prepare.assert_not_called()
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_existing_nano_setup_does_not_inject_e5_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            target = home / "plugins" / "plur1bus" / "config.json"
            target.parent.mkdir(parents=True)
            config = {"embedding": default_config(home / "models", accepted=True)}
            target.write_text(json.dumps(config))
            provider = object.__new__(Plur1busMemoryProvider)
            provider.save_config({}, str(home))
            saved = json.loads(target.read_text())
            self.assertNotIn("fallback", saved["embedding"])
            for key, value in config["embedding"].items():
                self.assertEqual(saved["embedding"][key], value)
