"""Command line entry point for the MTPLX embedding and reranking sidecar."""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

import uvicorn

from .backends import (
    DEFAULT_EMBEDDING_MAX_TOKENS,
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_RERANKER_MAX_TOKENS,
    DEFAULT_RERANKER_MODEL,
    RERANKER_DEFAULT_INSTRUCTION,
)
from .server import ServiceConfig, create_app

DEFAULT_PORT = 18086
DEFAULT_SEARCH_DIRS = (
    Path.home() / "mlx-llm" / "omlx-models",
    Path.home() / ".mtplx" / "models",
)


def build_parser() -> argparse.ArgumentParser:
    """Build the argument parser for ``python -m mtplx_embed``."""
    parser = argparse.ArgumentParser(
        prog="mtplx-embed",
        description="OpenAI-compatible Qwen3 embedding and reranking sidecar for MTPLX",
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"bind port (default: {DEFAULT_PORT})")
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--reranker-model", default=DEFAULT_RERANKER_MODEL)
    parser.add_argument(
        "--model-dir",
        action="append",
        default=[],
        help="extra directory searched for local model folders (repeatable)",
    )
    parser.add_argument("--embedding-max-tokens", type=int, default=DEFAULT_EMBEDDING_MAX_TOKENS)
    parser.add_argument("--reranker-max-tokens", type=int, default=DEFAULT_RERANKER_MAX_TOKENS)
    parser.add_argument("--embedding-batch-size", type=int, default=8)
    parser.add_argument("--reranker-batch-size", type=int, default=4)
    parser.add_argument(
        "--query-instruction",
        default=None,
        help="default Qwen3-Embedding instruction; omit to embed raw text (oMLX-compatible)",
    )
    parser.add_argument("--reranker-instruction", default=RERANKER_DEFAULT_INSTRUCTION)
    parser.add_argument(
        "--preload",
        action="store_true",
        help="load both models at startup instead of on first request",
    )
    parser.add_argument("--log-level", default="info")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the sidecar until interrupted."""
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    search_dirs = tuple(Path(value) for value in args.model_dir) + DEFAULT_SEARCH_DIRS
    config = ServiceConfig(
        embedding_model=args.embedding_model,
        reranker_model=args.reranker_model,
        search_dirs=search_dirs,
        embedding_max_tokens=args.embedding_max_tokens,
        reranker_max_tokens=args.reranker_max_tokens,
        embedding_batch_size=args.embedding_batch_size,
        reranker_batch_size=args.reranker_batch_size,
        query_instruction=args.query_instruction,
        reranker_instruction=args.reranker_instruction,
    )
    app = create_app(config)
    if args.preload:
        logging.getLogger("mtplx_embed").info("preloading models")
        dimensions = app.state.embedder.warmup()
        app.state.reranker.warmup()
        logging.getLogger("mtplx_embed").info("preloaded; embedding dimensions=%d", dimensions)
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
