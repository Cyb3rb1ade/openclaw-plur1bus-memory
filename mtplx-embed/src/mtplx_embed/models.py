"""Audited immutable revisions for opt-in Jina model-code repositories."""

from __future__ import annotations


JINA_EMBEDDING_TRANSFORMERS = "jinaai/jina-embeddings-v5-text-small"
JINA_RERANKER_TRANSFORMERS = "jinaai/jina-reranker-v3.5"
JINA_EMBEDDING_MLX = "jinaai/jina-embeddings-v5-text-small-mlx"
JINA_RERANKER_MLX = "jinaai/jina-reranker-v3.5-mlx"

JINA_MODEL_REVISIONS = {
    JINA_EMBEDDING_TRANSFORMERS: "dd76d535f5447ca3897a9c893fb1e612ead98192",
    JINA_RERANKER_TRANSFORMERS: "e8a93f33f0b22108f8c2364f8484ce3422552fbc",
    JINA_EMBEDDING_MLX: "fe69cad2caa9a4adc37eaecc9d12c7be304caa36",
    JINA_RERANKER_MLX: "3dd4ac901ccdcac85abe3815df0a0aaaf44e4a21",
}

PINNED_REVISION_FILE = ".plur1bus-hf-revision"
