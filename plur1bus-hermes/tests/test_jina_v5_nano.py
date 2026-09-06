"""Unit tests for local-only Jina v5 Nano ONNX mechanics (no model download)."""

from __future__ import annotations

import math
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

from plur1bus_hermes.jina_v5_nano import (
    ARTIFACTS, DOCUMENT_PREFIX, LICENSE, MATRYOSHKA_DIMENSIONS, MODEL_ID,
    OUTPUT_DIMENSIONS, QUERY_PREFIX, REVISION, JinaV5NanoEncoder,
    Artifact, JinaV5NanoError, default_config, prepare_model, validate_config, verify_model_dir,
)


class _Encoding:
    def __init__(self, ids):
        self.ids = ids


class _Tokenizer:
    def __init__(self):
        self.texts = []

    def encode_batch(self, texts):
        self.texts = list(texts)
        result = []
        for text in texts:
            if "first" in text:
                result.append(_Encoding([10, 11]))
            elif "second" in text:
                result.append(_Encoding([20]))
            else:
                result.append(_Encoding(list(range(600))[:getattr(self, "truncation", 600)]))
        return result

    def token_to_id(self, token):
        return 0 if token == "[PAD]" else None

    def enable_truncation(self, *, max_length):
        self.truncation = max_length

    def no_padding(self):
        self.padding_disabled = True


class _Session:
    def __init__(self, *, nonfinite=False):
        self.inputs = None
        self.nonfinite = nonfinite

    def get_inputs(self):
        return [SimpleNamespace(name="input_ids"), SimpleNamespace(name="attention_mask")]

    def get_outputs(self):
        return [SimpleNamespace(name="last_hidden_state")]

    def run(self, _outputs, inputs):
        self.inputs = inputs
        batch, sequence = inputs["input_ids"].shape
        hidden = np.zeros((batch, sequence, OUTPUT_DIMENSIONS), dtype=np.float32)
        for row in range(batch):
            for position in range(sequence):
                hidden[row, position, 0] = 100 * row + position + 1
                hidden[row, position, 1] = 2
        if self.nonfinite:
            hidden[0, -1, 0] = float("nan")
        return [hidden]


class JinaV5NanoTests(unittest.TestCase):
    def test_explicit_download_verifies_and_existing_artifacts_are_never_replaced(self):
        data = json.dumps({"model_type": "eurobert", "architectures": ["EuroBertModel"], "hidden_size": 768}).encode()
        artifact = Artifact("config.json", len(data), hashlib.sha256(data).hexdigest())
        class Response(io.BytesIO):
            headers = {}
        with tempfile.TemporaryDirectory() as directory, patch("plur1bus_hermes.jina_v5_nano.ARTIFACTS", (artifact,)):
            target = Path(directory) / "model"
            opener = Mock(side_effect=lambda *_args, **_kwargs: Response(data))
            self.assertTrue(prepare_model(target, accepted=True, opener=opener)["prepared"])
            self.assertIn(REVISION, opener.call_args.args[0].full_url)
            self.assertTrue(prepare_model(target, accepted=True, opener=opener)["prepared"])
            self.assertEqual(opener.call_count, 1)
            (target / "config.json").write_bytes(b"x" * len(data))
            with self.assertRaisesRegex(JinaV5NanoError, "hash"):
                prepare_model(target, accepted=True, opener=opener)
            self.assertEqual(opener.call_count, 1)
            (target / "config.json").unlink()
            outside = Path(directory) / "outside"
            outside.write_bytes(data)
            (target / "config.json").symlink_to(outside)
            with self.assertRaisesRegex(JinaV5NanoError, "symbolic link"):
                verify_model_dir(target, accepted=True)

    def test_onnx_options_survive_close_reload(self):
        ort = SimpleNamespace(InferenceSession=Mock(side_effect=lambda *_args, **_kwargs: _Session()),
                              SessionOptions=lambda: SimpleNamespace(),
                              GraphOptimizationLevel=SimpleNamespace(ORT_DISABLE_ALL="disabled"))
        with patch("plur1bus_hermes.jina_v5_nano.prepare_local_jina_v5_nano"), patch(
            "plur1bus_hermes.jina_v5_nano.importlib.import_module", return_value=ort,
        ):
            encoder = JinaV5NanoEncoder(default_config("/verified", accepted=True), tokenizer_factory=lambda _path: _Tokenizer())
            encoder.load()
            encoder.close()
            encoder.load()
            encoder.close()
        self.assertEqual(ort.InferenceSession.call_count, 2)
        for call in ort.InferenceSession.call_args_list:
            self.assertEqual(call.kwargs["sess_options"].graph_optimization_level, "disabled")
            self.assertEqual(call.kwargs["providers"], ["CPUExecutionProvider"])

    def test_sentence_embedding_precedes_hidden_states_and_shape_fails_closed(self):
        session = _Session()
        session.get_outputs = lambda: [SimpleNamespace(name="sentence_embedding"), SimpleNamespace(name="last_hidden_state")]
        session.run = lambda *_args: [np.ones((1, 768)), np.full((1, 1, 768), float("nan"))]
        with patch("plur1bus_hermes.jina_v5_nano.prepare_local_jina_v5_nano"), patch.object(
            JinaV5NanoEncoder, "_padding_token", return_value="[PAD]",
        ):
            encoder = JinaV5NanoEncoder(default_config("/verified", dimensions=32, accepted=True),
                                        tokenizer_factory=lambda _path: _Tokenizer(), session_factory=lambda *_args, **_kwargs: session)
            self.assertAlmostEqual(encoder.embed("first")[0], 1 / math.sqrt(32))
            session.run = lambda *_args: [np.ones((2, 768))]
            with self.assertRaisesRegex(JinaV5NanoError, "shape"):
                encoder.embed("first")

    def test_pinned_upstream_profile_is_exact(self):
        self.assertEqual(MODEL_ID, "jinaai/jina-embeddings-v5-text-nano-retrieval")
        self.assertEqual(REVISION, "ac5d898c8d382b17167c33e5c8af644a3519b47d")
        self.assertEqual({item.path: (item.size, item.sha256) for item in ARTIFACTS}, {
            "config.json": (1361, "367857e3a726df6f1997bcb8443a4351e68b29c65f996e5874a4b3e7c5661a16"),
            "onnx/model_quantized.onnx": (131365, "ac93a7417c216e5076e37da2b3599f7ef16513934098a477680440c09f735a08"),
            "onnx/model_quantized.onnx_data": (247006208, "ee7870eb143a7353be08b33f79992a51de3e32b41f684ccd82953a710c2f2f9c"),
            "tokenizer.json": (17210235, "98d4a1d32152d6cedf85b5e88f3b205106dca1fe72aaab34e0ac13c238421069"),
            "tokenizer_config.json": (487, "6c4640d432db970b2436a4386d3ee992b99e756b62c37446c3f581c8d09cbb05"),
        })
        self.assertEqual(MATRYOSHKA_DIMENSIONS, frozenset({32, 64, 128, 256, 512, 768}))

    def test_license_gate_and_preparation_never_download(self):
        config = default_config("/not-a-model", accepted=False)
        with self.assertRaisesRegex(JinaV5NanoError, LICENSE):
            JinaV5NanoEncoder(config).prepare()
        with self.assertRaisesRegex(JinaV5NanoError, LICENSE):
            prepare_model("/not-a-model", accepted=False)

    def test_static_validation_never_reads_model_and_rejects_float_caps(self):
        checked = validate_config(default_config("/does-not-exist", dimensions=768, accepted=True))
        self.assertEqual(Path(checked["modelDir"]), Path("/does-not-exist"))
        with self.assertRaisesRegex(JinaV5NanoError, "maximum"):
            validate_config({**default_config("/x", accepted=True), "maxTokens": 512.0})

    def test_explicit_downloader_failure_cleans_private_staging_and_never_creates_target(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "model"
            def offline(*_args, **_kwargs):
                raise OSError("offline")
            with self.assertRaises(OSError):
                prepare_model(target, accepted=True, opener=offline)
            self.assertFalse(target.exists())
            self.assertEqual(list(target.parent.glob(".model.jina-v5-*")), [])

    def test_last_token_pooling_prefixes_truncation_and_normalization(self):
        tokenizer, session = _Tokenizer(), _Session()
        config = default_config("/verified", dimensions=32, accepted=True)
        with patch("plur1bus_hermes.jina_v5_nano.prepare_local_jina_v5_nano", return_value={"prepared": True}), \
             patch.object(JinaV5NanoEncoder, "_padding_token", return_value="[PAD]"):
            encoder = JinaV5NanoEncoder(config, tokenizer_factory=lambda _path: tokenizer, session_factory=lambda _path, **_kwargs: session)
            documents = encoder.embed_many(["first", "second"], purpose="passage")
            self.assertEqual(len(documents), 2)
            self.assertEqual(len(documents[0]), 32)
            self.assertAlmostEqual(math.sqrt(sum(value * value for value in documents[0])), 1.0)
            # First row uses position 1, while second row uses position 0; this
            # catches accidental pooling of the final padded column.
            self.assertLess(documents[1][0], documents[0][0])
            query = encoder.embed("lookup", purpose="query")
            self.assertEqual(tokenizer.texts, [QUERY_PREFIX + "lookup"])
            self.assertEqual(len(query), 32)
            self.assertLessEqual(session.inputs["input_ids"].shape[1], 512)
            self.assertEqual(tokenizer.truncation, 512)
            self.assertTrue(tokenizer.padding_disabled)

    def test_rejects_prefix_override_bad_dimension_nonfinite_and_bad_purpose(self):
        with self.assertRaisesRegex(JinaV5NanoError, "prefixes"):
            JinaV5NanoEncoder({**default_config("/x", accepted=True), "queryPrefix": ""})
        with self.assertRaisesRegex(JinaV5NanoError, "dimensions"):
            JinaV5NanoEncoder(default_config("/x", dimensions=33, accepted=True))
        tokenizer, session = _Tokenizer(), _Session(nonfinite=True)
        with patch("plur1bus_hermes.jina_v5_nano.prepare_local_jina_v5_nano", return_value={"prepared": True}), \
             patch.object(JinaV5NanoEncoder, "_padding_token", return_value="[PAD]"):
            encoder = JinaV5NanoEncoder(default_config("/verified", accepted=True),
                                        tokenizer_factory=lambda _path: tokenizer, session_factory=lambda _path, **_kwargs: session)
            with self.assertRaisesRegex(JinaV5NanoError, "non-finite"):
                encoder.embed("value")
            with self.assertRaisesRegex(JinaV5NanoError, "purpose"):
                encoder.embed("value", purpose="classification")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
