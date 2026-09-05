"""Remote embedding contracts introduced by the 7.10 Hermes integration."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

from plur1bus_hermes.runtime import EmbeddingBackend
from plur1bus_hermes.validation import ValidationError


class RetrievalContracts(unittest.TestCase):
    def test_openai_default_credentials_and_requested_width(self):
        with tempfile.TemporaryDirectory() as root:
            backend = EmbeddingBackend({"provider": "openai-compatible", "model": "text-embedding-3-small", "dimensions": 2}, Path(root))
            response = MagicMock()
            response.__enter__.return_value.read.return_value = b'{"data":[{"embedding":[0.2,0.1]}]}'
            with patch.dict("os.environ", {"OPENAI_API_KEY": "test-only"}, clear=True), patch("urllib.request.urlopen", return_value=response) as request:
                self.assertEqual(backend.embed("test"), [0.2, 0.1])
                sent = request.call_args.args[0]
                self.assertEqual(json.loads(sent.data)["dimensions"], 2)
                self.assertEqual(sent.get_header("Authorization"), "Bearer test-only")
            backend.close()

    def test_explicit_missing_key_does_not_use_another_account(self):
        with tempfile.TemporaryDirectory() as root:
            backend = EmbeddingBackend({"provider": "openai-compatible", "model": "test", "apiKeyEnv": "ABSENT_TEST_KEY"}, Path(root))
            with patch.dict("os.environ", {"OPENAI_API_KEY": "another-account"}, clear=True), patch("urllib.request.urlopen") as request:
                with self.assertRaisesRegex(RuntimeError, "key"):
                    backend.embed("test")
                request.assert_not_called()
            backend.close()

    def test_invalid_known_width_rejected_before_request(self):
        with tempfile.TemporaryDirectory() as root:
            backend = EmbeddingBackend({"provider": "openai-compatible", "model": "text-embedding-3-small", "dimensions": 1537, "apiKey": "test"}, Path(root))
            with patch("urllib.request.urlopen") as request:
                with self.assertRaises(ValidationError):
                    backend.embed("test")
                request.assert_not_called()
            backend.close()

    def test_nonfinite_vector_never_cached(self):
        with tempfile.TemporaryDirectory() as root:
            backend = EmbeddingBackend({"dimensions": 1}, Path(root))
            with patch.object(backend, "_embed_one_uncached", return_value=[float("nan")]):
                with self.assertRaises(ValidationError):
                    backend.embed("test")
            self.assertIsNone(backend._cache.get("test", "passage"))
            backend.close()
