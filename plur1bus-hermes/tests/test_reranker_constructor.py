"""Exercise the supported Sentence Transformers 3.x constructor contract."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from plur1bus_hermes.runtime import RerankerBackend


class RerankerConstructorTests(unittest.TestCase):
    def test_cache_dir_and_bounded_input_use_real_constructor_keyword_names(self):
        calls = []
        def encoder(model_name, *, cache_dir, max_length, trust_remote_code, revision, local_files_only):
            calls.append((model_name, cache_dir, max_length, trust_remote_code, revision, local_files_only))
            return SimpleNamespace(predict=lambda pairs: [0.2, 0.9])
        with tempfile.TemporaryDirectory() as temporary, patch.dict(
            "sys.modules", {"sentence_transformers": SimpleNamespace(CrossEncoder=encoder)}
        ):
            backend = RerankerBackend({"provider": "local-transformers", "model": "BAAI/bge-reranker-v2-m3"}, Path(temporary))
            rows = backend._rerank_with(backend.config, "query", [{"content": "other"}, {"content": "match"}])
            self.assertEqual(rows[0]["content"], "match")
            self.assertEqual(calls[0][1], str(Path(temporary) / "plur1bus" / "models"))
            self.assertEqual(calls[0][2:], (512, False, None, False))
            pinned = {**backend.config, "revision": "pinned-revision", "localFilesOnly": True}
            backend._rerank_with(pinned, "query", [{"content": "other"}, {"content": "match"}])
            self.assertEqual(calls[1][2:], (512, False, "pinned-revision", True))
