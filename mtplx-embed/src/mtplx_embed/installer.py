"""Opt-in Jina model download and HTTP smoke checks for ``mtplx-embed``."""

from __future__ import annotations

import argparse
import json
import math
import urllib.request
from pathlib import Path
from typing import Any

from .models import (
    JINA_EMBEDDING_MLX,
    JINA_EMBEDDING_TRANSFORMERS,
    JINA_MODEL_REVISIONS,
    JINA_RERANKER_MLX,
    JINA_RERANKER_TRANSFORMERS,
    PINNED_REVISION_FILE,
)


def download_models(*, model_dir: Path, backend: str) -> tuple[str, str]:
    """Download audited Jina revisions into a stable, caller-owned cache."""
    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise RuntimeError("Jina download requires huggingface_hub") from error
    if backend == "mlx":
        embedding, reranker = JINA_EMBEDDING_MLX, JINA_RERANKER_MLX
    elif backend == "transformers":
        embedding, reranker = JINA_EMBEDDING_TRANSFORMERS, JINA_RERANKER_TRANSFORMERS
    else:
        raise ValueError(f"unsupported Jina backend: {backend}")
    model_dir.mkdir(parents=True, exist_ok=True)
    for model in (embedding, reranker):
        destination = model_dir / model
        revision = JINA_MODEL_REVISIONS[model]
        snapshot_download(
            repo_id=model,
            revision=revision,
            local_dir=str(destination),
            local_dir_use_symlinks=False,
        )
        (destination / PINNED_REVISION_FILE).write_text(f"{revision}\n", encoding="ascii")
    return embedding, reranker


def _request(url: str, payload: dict[str, Any] | None = None, api_key: str = "") -> dict[str, Any]:
    """Call a local OpenAI-compatible endpoint and decode its JSON response."""
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.loads(response.read().decode("utf-8"))


def smoke(*, base_url: str, embedding_model: str, reranker_model: str, api_key: str = "") -> None:
    """Assert the required Jina service contract with a small real request."""
    root = base_url.rstrip("/")
    models = _request(f"{root}/models", api_key=api_key)
    model_ids = {str(item.get("id")) for item in models.get("data", []) if isinstance(item, dict)}
    if not model_ids:
        raise RuntimeError("sidecar /v1/models returned no models")
    embedding = _request(f"{root}/embeddings", {
        "model": embedding_model,
        "input": "A compact Jina retrieval smoke test.",
        "encoding_format": "float",
    }, api_key)
    vector = embedding.get("data", [{}])[0].get("embedding", [])
    if not isinstance(vector, list) or len(vector) != 1024:
        raise RuntimeError(f"embedding smoke expected 1024 dimensions, got {len(vector) if isinstance(vector, list) else 'invalid'}")
    norm = math.sqrt(sum(float(value) ** 2 for value in vector))
    if not vector or not 0.99 <= norm <= 1.01:
        raise RuntimeError(f"embedding smoke expected a normalized non-empty vector, norm={norm:.6f}")
    ranked = _request(f"{root}/rerank", {
        "model": reranker_model,
        "query": "Which document discusses Jina retrieval?",
        "documents": ["An unrelated weather report.", "This document discusses Jina retrieval and embeddings."],
        "top_n": 2,
    }, api_key)
    results = ranked.get("results", [])
    if not isinstance(results, list) or not results or results[0].get("index") != 1:
        raise RuntimeError("rerank smoke did not rank the relevant document first")


def main(argv: list[str] | None = None) -> int:
    """Run a download or smoke command for the shell installer."""
    parser = argparse.ArgumentParser(prog="mtplx-embed-installer")
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("download")
    download.add_argument("--model-dir", type=Path, required=True)
    download.add_argument("--backend", choices=("mlx", "transformers"), required=True)
    smoke_parser = commands.add_parser("smoke")
    smoke_parser.add_argument("--base-url", required=True)
    smoke_parser.add_argument("--embedding-model", required=True)
    smoke_parser.add_argument("--reranker-model", required=True)
    smoke_parser.add_argument("--api-key", default="")
    args = parser.parse_args(argv)
    if args.command == "download":
        embedding, reranker = download_models(model_dir=args.model_dir, backend=args.backend)
        print(json.dumps({"embedding": embedding, "reranker": reranker}))
    else:
        smoke(base_url=args.base_url, embedding_model=args.embedding_model, reranker_model=args.reranker_model, api_key=args.api_key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
