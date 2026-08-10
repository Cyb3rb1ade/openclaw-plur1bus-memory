"""OpenAI-compatible embedding and reranking sidecar for the MTPLX stack.

MTPLX itself serves only ``/v1/chat/completions``, ``/v1/completions`` and
``/v1/messages`` — its runtime is a multi-token-prediction decoder for causal
chat models and has no embedding path. This service fills that gap with the
Qwen3 retrieval models, so a Hermes agent whose chat provider is MTPLX can keep
its PLUR1BUS memory on the same machine without a second general-purpose
inference server running alongside it.

Routes:

* ``GET  /health``          — liveness plus which models are resident
* ``GET  /v1/models``       — OpenAI model list (embedder and reranker)
* ``POST /v1/embeddings``   — OpenAI embeddings, 4096-dim Qwen3 vectors
* ``POST /v1/rerank``       — Cohere/Jina-compatible reranking
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .backends import (
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_RERANKER_MODEL,
    RERANKER_DEFAULT_INSTRUCTION,
    build_embedder,
    build_reranker,
    matches_model,
    model_alias,
)

LOGGER = logging.getLogger("mtplx_embed")

API_KEY_ENV = "MTPLX_EMBED_API_KEY"


class ServiceConfig:
    """Runtime configuration for one sidecar process."""

    def __init__(
        self,
        *,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        reranker_model: str = DEFAULT_RERANKER_MODEL,
        search_dirs: tuple[Path, ...] = (),
        embedding_max_tokens: int = 8192,
        reranker_max_tokens: int = 8192,
        embedding_batch_size: int = 8,
        reranker_batch_size: int = 4,
        query_instruction: str | None = None,
        reranker_instruction: str = RERANKER_DEFAULT_INSTRUCTION,
        backend: str = "auto",
        idle_seconds: int = 300,
    ) -> None:
        self.embedding_model = embedding_model
        self.reranker_model = reranker_model
        self.search_dirs = search_dirs
        self.embedding_max_tokens = embedding_max_tokens
        self.reranker_max_tokens = reranker_max_tokens
        self.embedding_batch_size = embedding_batch_size
        self.reranker_batch_size = reranker_batch_size
        self.query_instruction = query_instruction
        self.reranker_instruction = reranker_instruction
        self.backend = backend
        self.idle_seconds = max(0, int(idle_seconds))


def _authorised(request: Request) -> bool:
    """Check the bearer token when one is configured for this process.

    An unset key means loopback-only trust, matching how the local oMLX and
    MTPLX servers behave for 127.0.0.1 clients.
    """
    expected = os.environ.get(API_KEY_ENV, "")
    if not expected:
        return True
    header = request.headers.get("authorization", "")
    presented = header[7:] if header.lower().startswith("bearer ") else ""
    presented = presented or request.headers.get("x-api-key", "")
    return presented == expected


def _as_text_list(value: Any) -> list[str]:
    """Coerce an OpenAI ``input`` field into a list of strings."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return list(value)
    raise HTTPException(status_code=400, detail="input must be a string or a list of strings")


def create_app(config: ServiceConfig) -> FastAPI:
    """Build the FastAPI application for the given configuration."""
    # Which backend a checkpoint needs is read from the checkpoint itself, so
    # pointing --embedding-model at a jina repository is all that is required.
    embedder = build_embedder(
        config.embedding_model,
        search_dirs=config.search_dirs,
        max_tokens=config.embedding_max_tokens,
        batch_size=config.embedding_batch_size,
        backend=config.backend,
    )
    reranker = build_reranker(
        config.reranker_model,
        search_dirs=config.search_dirs,
        max_tokens=config.reranker_max_tokens,
        batch_size=config.reranker_batch_size,
        backend=config.backend,
    )
    app = FastAPI(title="MTPLX Embed", version="1.0.0")
    app.state.config = config
    app.state.embedder = embedder
    app.state.reranker = reranker
    app.state.last_model_use = time.monotonic()
    app.state.idle_task = None

    def _unload_if_idle() -> None:
        if not config.idle_seconds or time.monotonic() - app.state.last_model_use < config.idle_seconds:
            return
        for backend in (embedder, reranker):
            if backend.loaded:
                backend.unload()
        LOGGER.info("unloaded idle retrieval models after %ss", config.idle_seconds)

    @app.on_event("startup")
    async def _start_idle_unloader() -> None:
        async def _run() -> None:
            while True:
                await asyncio.sleep(max(1, min(60, config.idle_seconds or 60)))
                await asyncio.to_thread(_unload_if_idle)
        app.state.idle_task = asyncio.create_task(_run())

    @app.on_event("shutdown")
    async def _stop_idle_unloader() -> None:
        task = app.state.idle_task
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        for backend in (embedder, reranker):
            backend.unload()

    @app.middleware("http")
    async def _authorise(request: Request, call_next):
        if request.url.path.startswith("/v1/") and not _authorised(request):
            return JSONResponse(status_code=401, content={"error": {"message": "invalid api key"}})
        return await call_next(request)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "mtplx-embed",
            "embedding": {
                "model": embedder.reference,
                "loaded": embedder.loaded,
                "dimensions": embedder.dimensions,
            },
            "reranker": {"model": reranker.reference, "loaded": reranker.loaded},
        }

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        created = int(time.time())
        entries = []
        for reference, kind in (
            (embedder.reference, "embedding"),
            (reranker.reference, "rerank"),
        ):
            entries.append(
                {
                    "id": model_alias(reference),
                    "object": "model",
                    "created": created,
                    "owned_by": "mtplx-embed",
                    "root": reference,
                    "capability": kind,
                }
            )
        return {"object": "list", "data": entries}

    @app.post("/v1/embeddings")
    async def embeddings(request: Request) -> dict[str, Any]:
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="request body must be a JSON object")
        requested = str(body.get("model") or "")
        if not matches_model(requested, embedder.reference):
            raise HTTPException(
                status_code=404,
                detail=f"unknown embedding model {requested!r}; served: {model_alias(embedder.reference)}",
            )
        texts = _as_text_list(body.get("input"))
        instruction = body.get("instruction")
        if instruction is None:
            instruction = config.query_instruction
        started = time.perf_counter()
        vectors = await asyncio.to_thread(
            embedder.embed, texts, instruction=str(instruction) if instruction else None
        )
        app.state.last_model_use = time.monotonic()
        LOGGER.info(
            "embedded %d text(s) in %.2fs", len(texts), time.perf_counter() - started
        )
        return {
            "object": "list",
            "data": [
                {"object": "embedding", "index": index, "embedding": vector}
                for index, vector in enumerate(vectors)
            ],
            "model": model_alias(embedder.reference),
            "usage": {"prompt_tokens": 0, "total_tokens": 0},
        }

    @app.post("/v1/rerank")
    async def rerank(request: Request) -> dict[str, Any]:
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="request body must be a JSON object")
        requested = str(body.get("model") or "")
        if not matches_model(requested, reranker.reference):
            raise HTTPException(
                status_code=404,
                detail=f"unknown reranking model {requested!r}; served: {model_alias(reranker.reference)}",
            )
        query = body.get("query")
        if not isinstance(query, str) or not query.strip():
            raise HTTPException(status_code=400, detail="query must be a non-empty string")
        documents = _as_text_list(body.get("documents"))
        instruction = str(body.get("instruction") or config.reranker_instruction)
        started = time.perf_counter()
        scores = await asyncio.to_thread(
            reranker.score, query, documents, instruction=instruction
        )
        app.state.last_model_use = time.monotonic()
        LOGGER.info(
            "reranked %d document(s) in %.2fs", len(documents), time.perf_counter() - started
        )
        ranked = sorted(enumerate(scores), key=lambda item: item[1], reverse=True)
        top_n = body.get("top_n")
        if isinstance(top_n, int) and top_n > 0:
            ranked = ranked[:top_n]
        return_documents = bool(body.get("return_documents"))
        results = []
        for index, score in ranked:
            entry: dict[str, Any] = {"index": index, "relevance_score": score}
            if return_documents:
                entry["document"] = {"text": documents[index]}
            results.append(entry)
        return {
            "id": f"rerank-{int(time.time() * 1000)}",
            "model": model_alias(reranker.reference),
            "results": results,
            "usage": {"total_tokens": 0},
        }

    return app
