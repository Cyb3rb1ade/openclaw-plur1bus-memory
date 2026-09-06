"""Unit coverage for the optional byte-pinned BGE ONNX reranker."""
from __future__ import annotations

import hashlib
import io
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

from plur1bus_hermes.bge_onnx import (
    ARTIFACTS, MODEL, ONNX_REPOSITORY, REVISION, Artifact, BgeOnnxError,
    BgeOnnxReranker, default_config, prepare_model, validate_config, verify_model_dir,
)
from plur1bus_hermes.runtime import RerankerBackend
from plur1bus_hermes.provider import Plur1busMemoryProvider


class _Encoding:
    def __init__(self, ids): self.ids, self.attention_mask = ids, [1] * len(ids)


class _Tokenizer:
    def enable_truncation(self, *, max_length): self.max_length = max_length
    def enable_padding(self, **kwargs): self.padding = kwargs
    def encode_batch(self, pairs):
        self.pairs = list(pairs)
        return [_Encoding([0, index + 3, 2]) for index, _pair in enumerate(pairs)]


class _Session:
    def get_inputs(self): return [SimpleNamespace(name="input_ids"), SimpleNamespace(name="attention_mask")]
    def run(self, _output, inputs):
        self.inputs = inputs
        return [np.asarray([[0.2], [0.8]][:len(inputs["input_ids"])], dtype=np.float32)]


class _BlockingSession(_Session):
    def __init__(self):
        self.started, self.release, self.closed = threading.Event(), threading.Event(), False

    def run(self, output, inputs):
        self.started.set()
        if not self.release.wait(2): raise RuntimeError("test timeout")
        return super().run(output, inputs)

    def close(self): self.closed = True


class BgeOnnxTests(unittest.TestCase):
    def test_profile_is_exact_and_static_validation_is_offline(self):
        self.assertEqual((MODEL, ONNX_REPOSITORY, REVISION), ("BAAI/bge-reranker-v2-m3", "onnx-community/bge-reranker-v2-m3-ONNX", "6f5ff65298512715a1e669753bc754d2bc8f367b"))
        artifacts = {item.path: (item.size, item.sha256) for item in ARTIFACTS}
        self.assertEqual(artifacts["onnx/model_quantized.onnx"], (570727094, "912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d"))
        self.assertEqual(artifacts["tokenizer.json"], (17082900, "8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3"))
        self.assertEqual(validate_config(default_config("/does-not-exist"))["maxTokens"], 512)
        with self.assertRaisesRegex(BgeOnnxError, "localFilesOnly"):
            validate_config({**default_config("/x"), "localFilesOnly": False})

    def test_explicit_download_is_atomic_hash_checked_and_never_replaces_existing_directory(self):
        config = json.dumps({"model_type": "xlm-roberta", "architectures": ["XLMRobertaForSequenceClassification"]}).encode()
        artifact = Artifact("config.json", len(config), hashlib.sha256(config).hexdigest())
        class Response(io.BytesIO): pass
        with tempfile.TemporaryDirectory() as directory, patch("plur1bus_hermes.bge_onnx.ARTIFACTS", (artifact,)):
            target = Path(directory) / "model"
            opener = Mock(side_effect=lambda *_args, **_kwargs: Response(config))
            self.assertTrue(prepare_model(target, opener=opener)["prepared"])
            self.assertIn(ONNX_REPOSITORY, opener.call_args.args[0].full_url)
            self.assertIn(REVISION, opener.call_args.args[0].full_url)
            self.assertTrue(prepare_model(target, opener=opener)["prepared"])
            self.assertEqual(opener.call_count, 1)
            (target / "config.json").write_bytes(b"x" * len(config))
            with self.assertRaisesRegex(BgeOnnxError, "hash"):
                prepare_model(target, opener=opener)
            self.assertEqual(opener.call_count, 1)

    def test_symlinked_artifact_is_rejected_when_the_platform_allows_symlinks(self):
        config = json.dumps({"model_type": "xlm-roberta", "architectures": ["XLMRobertaForSequenceClassification"]}).encode()
        artifact = Artifact("config.json", len(config), hashlib.sha256(config).hexdigest())
        with tempfile.TemporaryDirectory() as directory, patch("plur1bus_hermes.bge_onnx.ARTIFACTS", (artifact,)):
            target = Path(directory) / "model"; target.mkdir()
            outside = Path(directory) / "outside"; outside.write_bytes(config)
            try:
                (target / "config.json").symlink_to(outside)
            except (PermissionError, OSError) as error:
                self.skipTest(f"symlink privilege unavailable: {error}")
            with self.assertRaisesRegex(BgeOnnxError, "symbolic link"):
                verify_model_dir(target)

    def test_pair_scoring_is_bounded_finite_and_preserves_count(self):
        tokenizer, session = _Tokenizer(), _Session()
        with patch("plur1bus_hermes.bge_onnx.verify_model_dir", return_value={"prepared": True}):
            reranker = BgeOnnxReranker(default_config("/verified"), tokenizer_factory=lambda _p: tokenizer,
                                        session_factory=lambda *_a, **_k: session)
            scores = reranker.score_many([("query", "one"), ("query", "two")])
        self.assertEqual(scores, [0.20000000298023224, 0.800000011920929])
        self.assertEqual(tokenizer.max_length, 512)
        self.assertEqual(tokenizer.padding["pad_id"], 1)
        self.assertEqual(tokenizer.pairs, [("query", "one"), ("query", "two")])
        self.assertEqual(session.inputs["input_ids"].shape[0], 2)
        with self.assertRaisesRegex(BgeOnnxError, "1..8"):
            reranker.score_many([("q", "d")] * 9)
        with self.assertRaisesRegex(BgeOnnxError, "non-empty"):
            reranker.score_many([("q", " ")])

    def test_bad_outputs_fail_and_runtime_keeps_original_rows_with_a_warning(self):
        session = _Session(); session.run = lambda *_args: [np.asarray([[float("nan")]])]
        with patch("plur1bus_hermes.bge_onnx.verify_model_dir", return_value={"prepared": True}):
            reranker = BgeOnnxReranker(default_config("/verified"), tokenizer_factory=lambda _p: _Tokenizer(),
                                        session_factory=lambda *_a, **_k: session)
            with self.assertRaisesRegex(BgeOnnxError, "non-finite"):
                reranker.score_many([("q", "d")])
        rows = [{"content": "one"}]
        with patch("plur1bus_hermes.runtime.RerankerBackend._rerank_local_onnx", side_effect=BgeOnnxError("bad bytes")), self.assertLogs("plur1bus_hermes.runtime", "WARNING"):
            self.assertEqual(RerankerBackend(default_config("/verified"), Path("/tmp")).rerank("q", rows), rows)

    def test_provider_availability_needs_no_torch_for_onnx_reranker_with_remote_embedding(self):
        config = {"embedding": {"provider": "omlx", "model": "remote-embed", "dimensions": 768},
                  "reranker": default_config("/verified")}
        provider = object.__new__(Plur1busMemoryProvider)
        provider.config, provider._closed = config, False
        requested: list[str] = []
        def find_spec(name):
            requested.append(name)
            return object()
        with patch.object(provider, "_runtime_config", return_value=config), patch(
            "plur1bus_hermes.provider.importlib.util.find_spec", side_effect=find_spec,
        ):
            self.assertTrue(provider.is_available())
        self.assertNotIn("sentence_transformers", requested)
        self.assertNotIn("torch", requested)

    def test_default_preparation_uses_certifi_in_a_per_request_context_but_injected_openers_stay_plain(self):
        from plur1bus_hermes import bge_onnx
        context = Mock()
        with patch("plur1bus_hermes.bge_onnx.urlopen") as urlopen, \
             patch("plur1bus_hermes.bge_onnx.ssl.create_default_context", return_value=context), \
             patch("plur1bus_hermes.bge_onnx.importlib.import_module", return_value=SimpleNamespace(where=lambda: "/certifi.pem")):
            bge_onnx._verified_opener(urlopen)("request", timeout=4)
        context.load_verify_locations.assert_called_once_with(cafile="/certifi.pem")
        urlopen.assert_called_once_with("request", timeout=4, context=context)
        injected = Mock()
        self.assertIs(bge_onnx._verified_opener(injected), injected)

    def test_reparse_redirect_detection_rejects_junction_metadata_and_artifact_components(self):
        from plur1bus_hermes import bge_onnx
        reparse = SimpleNamespace(is_symlink=lambda: False,
                                  lstat=lambda: SimpleNamespace(st_file_attributes=0x400))
        self.assertTrue(bge_onnx._redirected(reparse))
        with patch("plur1bus_hermes.bge_onnx._redirected", side_effect=lambda value: value.name == "onnx"):
            with self.assertRaisesRegex(BgeOnnxError, "junction"):
                bge_onnx._reject_redirected_components(Path("/safe/model"), Path("/safe/model/onnx/model.onnx"))

    def test_close_waits_for_active_scoring_before_releasing_onnx_session(self):
        session, closed = _BlockingSession(), threading.Event()
        with patch("plur1bus_hermes.bge_onnx.verify_model_dir", return_value={"prepared": True}):
            reranker = BgeOnnxReranker(default_config("/verified"), tokenizer_factory=lambda _p: _Tokenizer(),
                                        session_factory=lambda *_a, **_k: session)
            scoring = threading.Thread(target=lambda: reranker.score_many([("q", "d")]))
            scoring.start(); self.assertTrue(session.started.wait(1))
            closer = threading.Thread(target=lambda: (reranker.close(), closed.set()))
            closer.start(); time.sleep(0.05)
            self.assertFalse(closed.is_set(), "close must not invalidate an active inference")
            self.assertFalse(session.closed)
            session.release.set()
            scoring.join(2); closer.join(2)
        self.assertFalse(scoring.is_alive()); self.assertTrue(closed.is_set()); self.assertTrue(session.closed)


if __name__ == "__main__": unittest.main()
