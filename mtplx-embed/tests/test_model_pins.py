"""Offline regressions for immutable Jina model-code revisions."""

from __future__ import annotations

import re
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from mtplx_embed.backends import (
    JinaTransformersEmbedder,
    JinaTransformersReranker,
    _resolve_pinned_model_path,
)
from mtplx_embed.installer import download_models
from mtplx_embed.models import JINA_MODEL_REVISIONS, PINNED_REVISION_FILE


EXPECTED_REVISIONS = {
    "jinaai/jina-embeddings-v5-text-small": "dd76d535f5447ca3897a9c893fb1e612ead98192",
    "jinaai/jina-reranker-v3.5": "e8a93f33f0b22108f8c2364f8484ce3422552fbc",
    "jinaai/jina-embeddings-v5-text-small-mlx": "fe69cad2caa9a4adc37eaecc9d12c7be304caa36",
    "jinaai/jina-reranker-v3.5-mlx": "3dd4ac901ccdcac85abe3815df0a0aaaf44e4a21",
}


class ModelPinTests(unittest.TestCase):
    def test_all_configured_jina_repositories_use_audited_full_shas(self) -> None:
        self.assertEqual(JINA_MODEL_REVISIONS, EXPECTED_REVISIONS)
        for revision in JINA_MODEL_REVISIONS.values():
            self.assertRegex(revision, re.compile(r"^[0-9a-f]{40}$"))

    def test_installer_passes_pins_to_every_snapshot_download(self) -> None:
        def fake_snapshot_download(**kwargs):
            Path(kwargs["local_dir"]).mkdir(parents=True, exist_ok=True)
            return kwargs["local_dir"]

        snapshot_download = Mock(side_effect=fake_snapshot_download)
        module = SimpleNamespace(snapshot_download=snapshot_download)
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            sys.modules, {"huggingface_hub": module}
        ):
            download_models(model_dir=Path(directory), backend="transformers")
            download_models(model_dir=Path(directory), backend="mlx")

        calls = {
            call.kwargs["repo_id"]: call.kwargs["revision"]
            for call in snapshot_download.call_args_list
        }
        self.assertEqual(calls, EXPECTED_REVISIONS)

    def test_runtime_snapshot_resolution_passes_mlx_pins(self) -> None:
        snapshot_download = Mock(return_value="/tmp/pinned-snapshot")
        module = SimpleNamespace(snapshot_download=snapshot_download)
        mlx_repositories = [
            "jinaai/jina-embeddings-v5-text-small-mlx",
            "jinaai/jina-reranker-v3.5-mlx",
        ]
        with patch.dict(sys.modules, {"huggingface_hub": module}):
            for repository in mlx_repositories:
                resolved = _resolve_pinned_model_path(
                    repository, EXPECTED_REVISIONS[repository], ()
                )
                self.assertEqual(resolved, "/tmp/pinned-snapshot")

        calls = {
            call.kwargs["repo_id"]: call.kwargs["revision"]
            for call in snapshot_download.call_args_list
        }
        self.assertEqual(
            calls,
            {repository: EXPECTED_REVISIONS[repository] for repository in mlx_repositories},
        )

    def test_runtime_accepts_only_a_matching_local_revision_marker(self) -> None:
        repository = "jinaai/jina-embeddings-v5-text-small-mlx"
        revision = EXPECTED_REVISIONS[repository]
        snapshot_download = Mock(return_value="/tmp/pinned-fallback")
        module = SimpleNamespace(snapshot_download=snapshot_download)
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            sys.modules, {"huggingface_hub": module}
        ):
            model_path = Path(directory) / repository
            model_path.mkdir(parents=True)
            marker = model_path / PINNED_REVISION_FILE
            marker.write_text(f"{revision}\n", encoding="ascii")
            self.assertEqual(
                _resolve_pinned_model_path(repository, revision, (Path(directory),)),
                str(model_path),
            )
            snapshot_download.assert_not_called()

            marker.write_text(f"{'0' * 40}\n", encoding="ascii")
            self.assertEqual(
                _resolve_pinned_model_path(repository, revision, (Path(directory),)),
                "/tmp/pinned-fallback",
            )
            snapshot_download.assert_called_once_with(
                repo_id=repository, revision=revision
            )

    def test_runtime_rejects_unpinned_remote_model_code(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "audited immutable revision"):
            _resolve_pinned_model_path("example/unpinned-model-code", None, ())

    def test_transformers_remote_code_loads_use_pinned_revisions(self) -> None:
        loaded_model = SimpleNamespace(eval=Mock())
        auto_model = SimpleNamespace(from_pretrained=Mock(return_value=loaded_model))
        transformers_module = SimpleNamespace(AutoModel=auto_model)
        snapshot_download = Mock(return_value="/tmp/pinned-snapshot")
        hub_module = SimpleNamespace(snapshot_download=snapshot_download)
        repositories = [
            "jinaai/jina-embeddings-v5-text-small",
            "jinaai/jina-reranker-v3.5",
        ]
        with patch.dict(
            sys.modules,
            {"huggingface_hub": hub_module, "transformers": transformers_module},
        ):
            JinaTransformersEmbedder(repositories[0]).ensure_loaded()
            JinaTransformersReranker(repositories[1]).ensure_loaded()

        calls = auto_model.from_pretrained.call_args_list
        self.assertEqual([call.args[0] for call in calls], ["/tmp/pinned-snapshot"] * 2)
        self.assertEqual(
            [call.kwargs["revision"] for call in calls],
            [EXPECTED_REVISIONS[repository] for repository in repositories],
        )
        self.assertTrue(all(call.kwargs["trust_remote_code"] for call in calls))
        self.assertTrue(all(call.kwargs["local_files_only"] for call in calls))
        self.assertEqual(
            {
                call.kwargs["repo_id"]: call.kwargs["revision"]
                for call in snapshot_download.call_args_list
            },
            {repository: EXPECTED_REVISIONS[repository] for repository in repositories},
        )


if __name__ == "__main__":
    unittest.main()
