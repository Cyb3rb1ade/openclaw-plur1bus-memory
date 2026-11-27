"""Offline regression tests and an opt-in probe for the pinned local export."""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np

from plur1bus_hermes import embeddinggemma2 as gemma
from plur1bus_hermes import native_onnx
from plur1bus_hermes.jina_v5_nano import default_config as jina_config


class Tokenizer:
    def __init__(self):
        self.texts = []
        self.truncation = None

    def enable_truncation(self, *, max_length):
        self.truncation = max_length

    def no_padding(self):
        pass

    def token_to_id(self, token):
        return 0 if token == "<pad>" else None

    def encode_batch(self, texts):
        self.texts.extend(texts)
        return [SimpleNamespace(ids=[2, 12, 1]) for _ in texts]


class Session:
    def __init__(self):
        self.feeds = []

    def get_inputs(self):
        return [SimpleNamespace(name=name, type="tensor(int64)") for name in ("input_ids", "attention_mask")] + [
            SimpleNamespace(name=name, type="tensor(float)", shape=["tokens", 512])
            for name in ("image_features", "video_features", "audio_features")
        ]

    def get_outputs(self):
        return [SimpleNamespace(name="sentence_embedding"), SimpleNamespace(name="last_hidden_state")]

    def run(self, outputs, inputs):
        if outputs != ["sentence_embedding"]:
            raise AssertionError(outputs)
        self.feeds.append(inputs)
        return [np.tile(np.arange(1, 769, dtype="float32"), (inputs["input_ids"].shape[0], 1))]


class EmbeddingGemma2Tests(unittest.TestCase):
    def test_exact_pinned_variants_and_jina_compatibility(self):
        target = gemma.default_config("/verified", dimensions=256, dtype="q4")
        self.assertEqual(native_onnx.validate_config(target)["dtype"], "q4")
        self.assertEqual(native_onnx.validate_config(jina_config("/verified", accepted=True))["dimensions"], 768)
        self.assertEqual({gemma.model_artifacts(dtype)[1].path for dtype in ("q8", "q4", "fp32")},
                         {"onnx/model_quantized.onnx", "onnx/model_q4.onnx", "onnx/model.onnx"})
        for changes in ({"revision": "main"}, {"dtype": "dynamic"}, {"dimensions": 257},
                        {"dimensions": 256.0}, {"queryPrefix": "other"},
                        {"maxTokens": 8193}, {"localFilesOnly": False}, {"fallback": {"provider": "other"}}, {"provider": "omlx"}):
            with self.subTest(changes=changes), self.assertRaises(native_onnx.NativeOnnxConfigError):
                native_onnx.validate_config({**target, **changes})

    def test_prefixes_empty_media_inputs_and_matryoshka_projection(self):
        tokenizer, session = Tokenizer(), Session()
        factory = Mock(return_value=session)
        with patch.object(gemma, "verify_model_dir", return_value={"modelDir": "/verified"}):
            encoder = gemma.EmbeddingGemma2Encoder(
                gemma.default_config("/verified", dimensions=128, dtype="q4"),
                tokenizer_factory=lambda _path: tokenizer, session_factory=factory,
            )
            query = encoder.embed("Roter Planet?", purpose="query")
            passages = encoder.embed_many(["Mars", "Venus"])
            self.assertEqual(tokenizer.texts, ["task: search result | query: Roter Planet?",
                                              "title: none | text: Mars", "title: none | text: Venus"])
            self.assertEqual(tokenizer.truncation, 8192)
            self.assertEqual(factory.call_args.kwargs["providers"], ["CPUExecutionProvider"])
            self.assertTrue(Path(factory.call_args.args[0]).as_posix().endswith("/onnx/model_q4.onnx"))
            self.assertEqual(len(passages), 2)
            self.assertEqual(len(query), 128)
            self.assertAlmostEqual(math.hypot(*query), 1.0)
            self.assertAlmostEqual(query[-1] / query[0], 128.0)
            self.assertEqual(session.feeds[0]["attention_mask"].tolist(), [[1, 1, 1]])
            for media in ("image_features", "video_features", "audio_features"):
                self.assertEqual(session.feeds[0][media].shape, (0, 512))
                self.assertEqual(session.feeds[0][media].dtype, np.float32)

    def test_inference_rejects_wrong_shape_nonfinite_or_zero_output(self):
        tokenizer, session = Tokenizer(), Session()
        with patch.object(gemma, "verify_model_dir", return_value={"modelDir": "/verified"}):
            encoder = gemma.EmbeddingGemma2Encoder(gemma.default_config("/verified"),
                tokenizer_factory=lambda _path: tokenizer, session_factory=lambda *_args, **_kwargs: session)
            for invalid in (np.ones((1, 512)), np.zeros((1, 768)), np.full((1, 768), np.nan)):
                with self.subTest(shape=invalid.shape), self.assertRaises(gemma.EmbeddingGemma2Error):
                    session.run = lambda *_args: [invalid]
                    encoder.embed("bad result")

    def test_explicit_preparation_pins_bytes_and_never_overwrites_existing_directory(self):
        data = json.dumps({"model_type": "embedding_gemma2", "architectures": ["EmbeddingGemma2Model"],
                           "text_config": {"embedding_dim": 768, "hidden_size": 512}}).encode()
        paths = (gemma.Artifact("config.json", len(data), hashlib.sha256(data).hexdigest()),)
        with tempfile.TemporaryDirectory() as directory, patch.object(gemma, "model_artifacts", return_value=paths):
            target = Path(directory) / "model"
            opener = Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(data))
            receipt = gemma.prepare_model(target, dtype="q4", opener=opener)
            self.assertEqual(receipt["dtype"], "q4")
            self.assertIn(gemma.REVISION + "/config.json", opener.call_args.args[0].full_url)
            self.assertEqual(gemma.prepare_model(target, dtype="q4", opener=opener), receipt)
            opener.assert_called_once()
            config = target / "config.json"
            config.write_bytes(b"x" * len(data))
            with self.assertRaisesRegex(gemma.EmbeddingGemma2Error, "hash"):
                gemma.prepare_model(target, dtype="q4", opener=opener)
            opener.assert_called_once()
            self.assertEqual(config.read_bytes(), b"x" * len(data))
            failure_destination = Path(directory) / "bad-download"
            corrupt = Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(b"x" * (len(data) + 1)))
            with self.assertRaisesRegex(gemma.EmbeddingGemma2Error, "size"):
                gemma.prepare_model(failure_destination, dtype="q4", opener=corrupt)
            self.assertFalse(failure_destination.exists())
            self.assertEqual([entry.name for entry in Path(directory).iterdir()], ["model"])


@unittest.skipUnless(os.environ.get("PLUR1BUS_REAL_GEMMA2_DIRECTORY"), "set a directory with the pinned ONNX assets")
class RealEmbeddingGemma2Tests(unittest.TestCase):
    def test_text_graphs_rank_mars_and_preserve_truncation_direction(self):
        root = Path(os.environ["PLUR1BUS_REAL_GEMMA2_DIRECTORY"])
        sentences = [
            "Venus is often called Earth's twin because of its similar size and proximity.",
            "Mars, known for its reddish appearance, is often referred to as the Red Planet.",
            "Jupiter, the largest planet in our solar system, has a prominent red spot.",
            "Saturn, famous for its rings, is sometimes mistaken for the Red Planet.",
        ]
        dtypes = os.environ.get("PLUR1BUS_REAL_GEMMA2_DTYPES", "q8").split(",")
        for dtype in dtypes:
            with self.subTest(dtype=dtype):
                encoder = gemma.EmbeddingGemma2Encoder(gemma.default_config(root, dtype=dtype))
                try:
                    query = encoder.embed("Which planet is known as the Red Planet?", purpose="query")
                    vectors = encoder.embed_many(sentences)
                    scores = np.asarray(vectors) @ np.asarray(query)
                    self.assertEqual(int(np.argmax(scores)), 1)
                    self.assertGreater(scores[1], 0.7)
                    self.assertAlmostEqual(math.hypot(*query), 1.0, places=6)
                finally:
                    encoder.close()
                small = gemma.EmbeddingGemma2Encoder(gemma.default_config(root, dimensions=256, dtype=dtype))
                try:
                    narrow = small.embed(sentences[1])
                    self.assertEqual(len(narrow), 256)
                    self.assertAlmostEqual(math.hypot(*narrow), 1.0, places=6)
                    wide_prefix = np.asarray(vectors[1][:256])
                    self.assertGreater(np.asarray(narrow) @ wide_prefix / np.linalg.norm(wide_prefix), 0.999)
                finally:
                    small.close()

    def test_hermes_runtime_captures_and_recalls_with_gemma_vectors(self):
        from plur1bus_hermes.runtime import Plur1busRuntime

        model_root = Path(os.environ["PLUR1BUS_REAL_GEMMA2_DIRECTORY"])
        config = {"embedding": gemma.default_config(model_root, dimensions=256),
                  "reranker": {"provider": "disabled"}, "recall": {"queryRefinement": False}}
        with tempfile.TemporaryDirectory() as directory:
            runtime = Plur1busRuntime(Path(directory), config, "default")
            try:
                # Domain side effects have their own gates. Exercise the actual
                # writer, query path and CPU encoder with a real LanceDB table.
                runtime._domain.on_memory = lambda *_args, **_kwargs: None
                runtime._remember("Mars is known for its reddish appearance.", "session", "user")
                table, _ = runtime._table(create=False)
                self.assertEqual(table.schema.field("vector").type.list_size, 256)
                self.assertIn("Mars is known", runtime.recall("Which planet looks red?"))
            finally:
                runtime.shutdown()
