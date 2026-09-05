"""Local PLUR1BUS storage, embedding, and reranking runtime for Hermes."""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import urllib.error
import urllib.request
import uuid
from concurrent.futures import Future, wait
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .cache import EmbeddingCache
from .domain import Plur1busDomain
from .epistemic import (
    decide_epistemic_status_for_capture,
    ensure_epistemic_cutoff,
)
from .inject_budget import apply_global_inject_budget
from .llm_cache import LlmResultCache
from .semantic_input import prepare_semantic_input
from .namespaces import (
    binding_from_scope,
    normalize_scope_context,
    resolve_namespace_routes,
    scope_where_clause,
)
from .shared_pools import (
    SharedPoolStore,
    SharedPrincipal,
)
from .cognition import parse_temporal_range
from .query_refinement import refine_query
from .llm_backend import InternalLlmBackend
from .validation import ValidationError, safe_agent_id, safe_memory_id, resolve_inside
from .valid_time import (
    has_disjoint_validity_windows,
    is_entry_live,
    is_entry_valid_at,
    is_missing_validity_column_error,
    normalize_timestamp,
    normalize_validity_window,
    validity_label,
    validity_where_clause,
)
from .runtime_scheduler import AdmissionRejected, BoundedExecutor
from .durable_merge import build_proposal, persist_proposal
from .writer_lock import serialized_memory_write


def _utcnow() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


OMLX_BASE_URL = "http://127.0.0.1:8000/v1"

_JINA_V3_MODEL = "jinaai/jina-embeddings-v3"
_JINA_V3_MATRYOSHKA_DIMENSIONS = frozenset({32, 64, 128, 256, 512, 768, 1024})

LOGGER = logging.getLogger(__name__)

# Mirror of upstream PLUR1BUS MAX_POSTPROCESSING_RETRIES (7.2.1 parity).
MAX_CAPTURE_RETRIES = 5

_CAPTURE_SCOPE_STRING_COLUMNS = (
    "scopeType",
    "ownerKey",
    "workspaceIdentity",
    "ownerPlatform",
    "ownerUser",
    "chatScope",
)

_ACL_BINDING_STRING_COLUMNS = (
    "agentId",
    "scopeType",
    "workspace",
    "workspaceIdentity",
    "platform",
    "user",
    "userId",
    "chat",
    "chatId",
    "account",
    "ownerKey",
    "scopeKey",
)


def _omlx_config(config: dict[str, Any]) -> dict[str, Any]:
    """Apply safe local oMLX defaults without persisting a credential."""
    return {
        **config,
        "baseUrl": str(config.get("baseUrl") or OMLX_BASE_URL),
        "apiKeyEnv": str(config.get("apiKeyEnv") or "OMLX_API_KEY"),
    }


def _request_json(url: str, payload: dict[str, Any], config: dict[str, Any], *, default_key_env: str) -> dict[str, Any]:
    """Post an OpenAI-compatible request and return its JSON response."""
    key = os.environ.get(str(config.get("apiKeyEnv", default_key_env)), "") or str(config.get("apiKey", ""))
    if not key and url.startswith("http://127.0.0.1:"):
        key = "local"
    if not key:
        raise RuntimeError("oMLX API key is not configured")
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "x-api-key": key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=float(config.get("timeoutSeconds", 15))) as response:
            loaded = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.HTTPError, urllib.error.URLError) as error:
        raise RuntimeError("oMLX request failed") from error
    if not isinstance(loaded, dict):
        raise RuntimeError("oMLX returned an invalid response")
    return loaded


class EmbeddingBackend:
    """Embedding backend with a dimension-checked local failure fallback."""

    def __init__(self, config: dict[str, Any], hermes_home: Path) -> None:
        self.config = config
        self.hermes_home = hermes_home
        self._models: dict[str, Any] = {}
        self._lock = threading.RLock()
        try:
            self._cache = EmbeddingCache(config, hermes_home)
        except Exception as error:
            # The cache is never authoritative.  In particular, a damaged
            # SQLite cache must not stop embedding/capture from starting.
            LOGGER.warning("embedding cache persistence disabled: %s", type(error).__name__)
            self._cache = EmbeddingCache({**config, "cachePersist": False}, hermes_home)

    def embed(self, text: str, *, purpose: str = "passage") -> list[float]:
        return self.embed_many([text], purpose=purpose)[0]

    def _embed_one_uncached(self, text: str, *, purpose: str) -> list[float]:
        try:
            return self._embed_with(self.config, text, purpose=purpose)
        except Exception as primary_error:
            fallback = self.config.get("fallback")
            if not isinstance(fallback, dict):
                raise primary_error
            vector = self._embed_with(fallback, text, purpose=purpose)
            primary_dimensions = int(self.config.get("dimensions", len(vector)))
            if len(vector) != primary_dimensions:
                raise ValidationError("embedding fallback returned incompatible dimensions")
            return vector

    def embed_many(self, texts: list[str], *, purpose: str = "passage") -> list[list[float]]:
        """Embed a batch through oMLX when possible, preserving input order.

        ``purpose`` must be "query" for a search string and "passage" for
        stored text. Qwen3-Embedding is trained asymmetrically — a query
        carries an instruction, a passage does not — so passing the wrong
        value here silently degrades recall rather than raising: a query sent
        as "passage" still returns a vector, just one that embeds it as more
        stored text instead of a question. Measured on real memories, this was
        the difference between the answering document ranking 347th and 1st.
        """
        if purpose not in {"query", "passage"}:
            raise ValidationError("embedding purpose must be query or passage")
        if not texts:
            return []
        if len(texts) == 1:
            return [self._cache.get_or_compute(
                texts[0], lambda: self._embed_one_uncached(texts[0], purpose=purpose), purpose,
            )]
        results: list[list[float] | None] = [self._cache.get(text, purpose) for text in texts]
        missing_indexes = [index for index, value in enumerate(results) if value is None]
        if not missing_indexes:
            return [value for value in results if value is not None]
        missing_texts = [texts[index] for index in missing_indexes]
        if self.config.get("provider") != "omlx":
            computed = [self._embed_one_uncached(text, purpose=purpose) for text in missing_texts]
        else:
            try:
                computed = self._embed_omlx_many(self.config, missing_texts, purpose=purpose)
            except Exception as primary_error:
                fallback = self.config.get("fallback")
                if not isinstance(fallback, dict):
                    raise primary_error
                computed = [
                    self._embed_with(fallback, text, purpose=purpose) for text in missing_texts
                ]
        for index, text, vector in zip(missing_indexes, missing_texts, computed, strict=True):
            if not vector or any(not math.isfinite(float(value)) for value in vector):
                raise ValidationError("embedding returned an empty or non-finite vector")
            expected = int(self.config.get("dimensions", len(vector)))
            if len(vector) != expected:
                raise ValidationError(f"embedding dimensions mismatch: expected {expected}, got {len(vector)}")
            results[index] = vector
            self._cache.set(text, vector, purpose)
        return [value for value in results if value is not None]

    def close(self) -> None:
        """Release loaded local models and persistent cache handles."""
        with self._lock:
            self._models.clear()
        self._cache.close()

    def _embed_with(self, config: dict[str, Any], text: str, *, purpose: str) -> list[float]:
        provider = config.get("provider", "local-transformers")
        if provider == "local-transformers":
            return self._embed_local(config, text, purpose=purpose)
        if provider == "omlx":
            return self._embed_omlx(config, text, purpose=purpose)
        if provider == "openai-compatible":
            return self._embed_remote(config, text, purpose=purpose)
        raise ValidationError(f"unsupported embedding provider: {provider}")

    def _embed_local(self, config: dict[str, Any], text: str, *, purpose: str) -> list[float]:
        model_name = str(config.get("model", "intfloat/multilingual-e5-base"))
        if model_name == _JINA_V3_MODEL:
            return self._embed_local_jina_v3(config, text, purpose=purpose)
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as error:
            raise RuntimeError("local embeddings require sentence-transformers") from error
        cache_dir = Path(str(config.get("cacheDir") or self.hermes_home / "plur1bus" / "models"))
        with self._lock:
            model = self._models.get(model_name)
            if model is None:
                model = SentenceTransformer(model_name, cache_folder=str(cache_dir))
                self._models[model_name] = model
        # e5-family models are asymmetric like Qwen3: "query: " on questions,
        # "passage: " on stored text. Applying the query prefix to everything
        # was the local-provider half of the same bug fixed for omlx below.
        prefix = str(config.get("queryPrefix" if purpose == "query" else "passagePrefix",
                                 "query: " if purpose == "query" else "passage: "))
        vector = model.encode(prefix + text, normalize_embeddings=True)
        result = [float(value) for value in vector.tolist()]
        expected = int(config.get("dimensions", len(result)))
        if len(result) != expected:
            raise ValidationError(f"embedding dimensions mismatch: expected {expected}, got {len(result)}")
        return result

    def _embed_local_jina_v3(
        self, config: dict[str, Any], text: str, *, purpose: str
    ) -> list[float]:
        """Fail closed until every Jina v3 remote-code dependency is pinned."""
        if config.get("acceptNonCommercialLicense") is not True:
            raise RuntimeError(
                "jinaai/jina-embeddings-v3 requires explicit acceptance of its "
                "CC-BY-NC-4.0 license before local use"
            )
        dimensions = int(config.get("dimensions", 1024))
        if dimensions not in _JINA_V3_MATRYOSHKA_DIMENSIONS:
            raise ValidationError(
                "jinaai/jina-embeddings-v3 dimensions must be one of "
                "32, 64, 128, 256, 512, 768, 1024"
            )
        raise RuntimeError(
            "jinaai/jina-embeddings-v3 local loading is unsupported: its pinned "
            "model revision delegates remote code to a separately versioned repository "
            "that has not been independently audited and pinned"
        )

    def _embed_remote(self, config: dict[str, Any], text: str, *, purpose: str) -> list[float]:
        key = str(config.get("apiKey") or "")
        if not key:
            explicit_env = config.get("apiKeyEnv")
            key = os.environ.get(str(explicit_env), "") if explicit_env else (
                os.environ.get("PLUR1BUS_EMBEDDING_API_KEY", "")
                or os.environ.get("OPENAI_API_KEY", "")
            )
        if not key:
            raise RuntimeError("remote embedding API key is not configured")
        base_url = str(config.get("baseUrl") or "https://api.openai.com/v1").rstrip("/")
        body = {"model": config["model"], "input": text, "encoding_format": "float"}
        # OpenAI v3 models support requested dimensions; other compatible
        # servers are probed by validating their actual vector below.
        if config["model"] in {"text-embedding-3-small", "text-embedding-3-large"} and "dimensions" in config:
            width = int(config["dimensions"])
            maximum = 1536 if config["model"] == "text-embedding-3-small" else 3072
            if width < 1 or width > maximum:
                raise ValidationError("invalid dimensions for OpenAI embedding model")
            body["dimensions"] = width
        instruction = config.get("queryInstruction")
        if purpose == "query" and instruction:
            body["instruction"] = instruction
        request = urllib.request.Request(
            f"{base_url}/embeddings",
            data=json.dumps(body).encode("utf-8"),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=float(config.get("timeoutSeconds", 15))) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.HTTPError, urllib.error.URLError) as error:
            raise RuntimeError("remote embedding request failed") from error
        vector = [float(value) for value in payload["data"][0]["embedding"]]
        expected = int(config.get("dimensions", len(vector)))
        if len(vector) != expected:
            raise ValidationError(f"embedding dimensions mismatch: expected {expected}, got {len(vector)}")
        return vector

    def _embed_omlx(self, config: dict[str, Any], text: str, *, purpose: str) -> list[float]:
        """Embed text through oMLX's local OpenAI-compatible endpoint."""
        return self._embed_omlx_many(config, [text], purpose=purpose)[0]

    def _embed_omlx_many(
        self, config: dict[str, Any], texts: list[str], *, purpose: str = "passage"
    ) -> list[list[float]]:
        """Embed multiple texts through one oMLX request.

        Qwen3-Embedding and jina-embeddings-v5 are both trained asymmetrically:
        a query carries an instruction (or, for jina, a different adapter
        selected server-side), a stored passage carries none. Sending queries
        bare — the bug this fixes — let a rare decisive term ("Sklerose", 7 of
        13104 rows) get averaged away by whatever name dominated the sentence;
        the answering memory ranked 347th instead of 1st.
        """
        settings = _omlx_config(config)
        body = {"model": settings["model"], "input": texts, "encoding_format": "float"}
        instruction = settings.get("queryInstruction") or config.get("queryInstruction")
        if purpose == "query" and instruction:
            body["instruction"] = instruction
        payload = _request_json(
            f"{settings['baseUrl'].rstrip('/')}/embeddings",
            body,
            settings,
            default_key_env="OMLX_API_KEY",
        )
        values = payload.get("data")
        if not isinstance(values, list) or len(values) != len(texts):
            raise RuntimeError("oMLX returned an incomplete embedding batch")
        indexed = sorted(values, key=lambda item: int(item.get("index", 0)))
        vectors = [[float(value) for value in item["embedding"]] for item in indexed]
        expected = int(settings.get("dimensions", len(vectors[0])))
        if any(len(vector) != expected for vector in vectors):
            raise ValidationError(f"embedding dimensions mismatch: expected {expected}")
        return vectors


class RerankerBackend:
    """Local or Cohere reranker with an optional local fallback."""

    def __init__(self, config: dict[str, Any], hermes_home: Path) -> None:
        self.config = config
        self.hermes_home = hermes_home
        self._models: dict[str, Any] = {}
        self._lock = threading.RLock()

    def rerank(self, query: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not rows or self.config.get("provider", "disabled") == "disabled":
            return rows
        try:
            return self._rerank_with(self.config, query, rows)
        except Exception as primary_error:
            if self.config.get("fallbackProvider") != "local-transformers":
                return rows
            try:
                return self._rerank_with({"provider": "local-transformers", "model": self.config.get("fallbackModel", "BAAI/bge-reranker-v2-m3")}, query, rows)
            except Exception as fallback_error:
                # JS parity (reranker-chained): fail open with unreranked rows.
                LOGGER.warning(
                    "reranker primary (%s) and local fallback (%s) failed; returning unreranked results",
                    primary_error,
                    fallback_error,
                )
                return rows

    def _rerank_with(self, config: dict[str, Any], query: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if config.get("provider") == "cohere":
            return self._rerank_cohere(config, query, rows)
        if config.get("provider") in {"omlx", "openai-compatible"}:
            return self._rerank_omlx(config, query, rows)
        if config.get("provider") != "local-transformers":
            raise RuntimeError("unsupported reranking provider")
        try:
            from sentence_transformers import CrossEncoder
        except ImportError as error:
            raise RuntimeError("local reranking requires sentence-transformers") from error
        model_name = str(config.get("model", "BAAI/bge-reranker-v2-m3"))
        cache_dir = Path(str(config.get("cacheDir") or self.hermes_home / "plur1bus" / "models"))
        with self._lock:
            model = self._models.get(model_name)
            if model is None:
                model = CrossEncoder(model_name, cache_folder=str(cache_dir))
                self._models[model_name] = model
        scores = model.predict([(query, str(row.get("content", ""))) for row in rows])
        ranked = [dict(row, rerankScore=float(score)) for row, score in zip(rows, scores, strict=True)]
        return sorted(ranked, key=lambda row: row["rerankScore"], reverse=True)

    def _rerank_cohere(self, config: dict[str, Any], query: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        key = os.environ.get(str(config.get("apiKeyEnv", "PLUR1BUS_RERANKER_API_KEY")), "")
        if not key:
            raise RuntimeError("Cohere reranking API key is not configured")
        request = urllib.request.Request(
            "https://api.cohere.com/v2/rerank",
            data=json.dumps({"model": config.get("model", "rerank-v3.5"), "query": query, "documents": [str(row.get("content", "")) for row in rows], "top_n": len(rows)}).encode("utf-8"),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=float(config.get("timeoutSeconds", 10))) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.HTTPError, urllib.error.URLError) as error:
            raise RuntimeError("Cohere reranking request failed") from error
        ranked = []
        for result in payload.get("results", []):
            index = result.get("index")
            if isinstance(index, int) and 0 <= index < len(rows):
                ranked.append(dict(rows[index], rerankScore=float(result.get("relevance_score", 0))))
        return ranked or rows

    def _rerank_omlx(self, config: dict[str, Any], query: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Rank candidate cards through oMLX's Cohere/Jina-compatible endpoint."""
        settings = _omlx_config(config)
        documents = [str(row.get("content", "")) for row in rows]
        payload = _request_json(
            f"{settings['baseUrl'].rstrip('/')}/rerank",
            {
                "model": settings["model"],
                "query": query,
                "documents": documents,
                "top_n": len(rows),
                "return_documents": False,
            },
            settings,
            default_key_env="OMLX_API_KEY",
        )
        ranking = payload.get("results", [])
        scores: dict[int, float] = {}
        for entry in ranking:
            if isinstance(entry, dict) and isinstance(entry.get("index"), int):
                index = entry["index"]
                if 0 <= index < len(rows) and index not in scores:
                    scores[index] = float(entry.get("relevance_score", entry.get("score", 0)))
        if len(scores) != len(rows):
            raise RuntimeError("oMLX reranker returned an incomplete ranking")
        return sorted(
            [dict(row, rerankScore=scores[index]) for index, row in enumerate(rows)],
            key=lambda row: row["rerankScore"],
            reverse=True,
        )


class Plur1busRuntime:
    """Agent-isolated LanceDB storage with asynchronous capture and recall."""

    def __init__(self, data_dir: Path, config: dict[str, Any], agent_id: str, scope: Any = None) -> None:
        self.data_dir = data_dir
        self.config = config
        self.agent_id = safe_agent_id(agent_id)
        self.request_scope = normalize_scope_context(scope)
        if scope is None and config.get("scopeType"):
            self.request_scope["scopeType"] = config["scopeType"]
        if (
            str(self.request_scope.get("scopeType") or "agent-private") != "agent-private"
            and not self.request_scope.get("workspace")
            and config.get("workspaceId")
        ):
            self.request_scope["workspace"] = config["workspaceId"]
        self.scope_binding = binding_from_scope(self.agent_id, self.request_scope)
        self.scope_key = self.scope_binding.key
        self._writer_route, self._recall_routes = resolve_namespace_routes(
            data_dir, self.agent_id, config
        )
        self._shared_pools = SharedPoolStore(
            data_dir,
            SharedPrincipal(
                workspace=str(
                    self.request_scope.get("workspace")
                    or self.agent_id
                ),
                platform=str(self.request_scope.get("platform") or ""),
                account=str(self.request_scope.get("account") or ""),
                user=str(self.request_scope.get("user") or ""),
            ),
        )
        embedding_config = dict(config.get("embedding", {}))
        # Upstream top-level embedding-cache settings remain accepted while
        # explicit native ``embedding.cache*`` values take precedence.
        runtime_config = config.get("runtime") if isinstance(config.get("runtime"), dict) else {}
        upstream_embedding_cache = {
            "embeddingCacheMaxEntries": "cacheMaxEntries",
            "embeddingCachePersist": "cachePersist",
            "embeddingCacheMaxBytes": "cacheMaxBytes",
        }
        for upstream, native in upstream_embedding_cache.items():
            if native not in embedding_config and upstream in runtime_config:
                embedding_config[native] = runtime_config[upstream]
            elif native not in embedding_config and upstream in config:
                embedding_config[native] = config[upstream]
        cache_ttl_ms = runtime_config.get("embeddingCacheTtlMs", config.get("embeddingCacheTtlMs"))
        if "cacheTtlSeconds" not in embedding_config and cache_ttl_ms is not None:
            try:
                embedding_config["cacheTtlSeconds"] = max(1, int(cache_ttl_ms) // 1000)
            except (TypeError, ValueError):
                LOGGER.warning("invalid runtime.embeddingCacheTtlMs ignored")
        cache_enabled = runtime_config.get("embeddingCacheEnabled", config.get("embeddingCacheEnabled"))
        if cache_enabled is False:
            embedding_config["cacheMaxEntries"] = 0
        scope = str(runtime_config.get("embeddingCacheScope", config.get("embeddingCacheScope") or "agent"))
        embedding_config["_scopeId"] = "shared" if scope == "shared" else self.agent_id
        self._embedding = EmbeddingBackend(embedding_config, data_dir)
        self._reranker = RerankerBackend(dict(config.get("reranker", {})), data_dir.parent)
        self._domain = Plur1busDomain(data_dir, self.agent_id, config)
        llm_cache_config = dict(config.get("llmResultCache", {}))
        for upstream, native in {
            "llmResultCacheTtlMs": "ttlMs", "llmResultCacheMaxEntries": "maxEntries",
            "llmResultCachePersist": "persist", "llmResultCacheMaxBytes": "maxBytes",
        }.items():
            if native not in llm_cache_config and upstream in runtime_config:
                llm_cache_config[native] = runtime_config[upstream]
        if runtime_config.get("llmResultCacheEnabled") is False:
            llm_cache_config["maxEntries"] = 0
        try:
            self._llm_cache = LlmResultCache(
                data_dir,
                self.agent_id,
                ttl_ms=llm_cache_config.get("ttlMs", 86_400_000),
                max_entries=llm_cache_config.get("maxEntries", 256),
                persist=llm_cache_config.get("persist", False),
                max_bytes=llm_cache_config.get("maxBytes", 67_108_864),
                cache_version=llm_cache_config.get("cacheVersion", "1"),
            )
        except Exception as error:
            # Cache is an optimisation: an unavailable persistent cache must
            # never prevent capture/recall from starting.
            LOGGER.warning("LLM result cache persistence disabled: %s", type(error).__name__)
            self._llm_cache = LlmResultCache(data_dir, self.agent_id, persist=False)
        self._internal_llm = InternalLlmBackend(config, self.agent_id, cache=self._llm_cache)
        self._domain.set_llm_backend(self._internal_llm)
        # Restore-safe epistemic cutoff, created on the first upgrade before
        # the first write (upstream 7.4.0 contract). A broken cutoff fails
        # closed: `observed` captures degrade to `untrusted`, never the reverse.
        self._epistemic_cutoff = ensure_epistemic_cutoff(data_dir)
        queue_depth = runtime_config.get("maxQueueDepthCapturePerAgent", 10)
        queue_timeout_ms = runtime_config.get("captureTimeoutMs", 60_000)
        self._executor = BoundedExecutor(
            max_workers=1,  # memory mutations remain single-writer
            max_queue=queue_depth,
            queue_timeout_ms=queue_timeout_ms,
            thread_name_prefix="plur1bus-capture",
        )
        self._futures: set[Future[None]] = set()
        self._lock = threading.RLock()
        self._retry_inflight: set[tuple[str, str, str, str, str, str, str, str]] = set()

    def capture_async(self, user: str, assistant: str, session_id: str, *, importance: float | None = None,
                      valid_from: Any = None, valid_until: Any = None, expires_at: Any = None,
                      ttl: Any = None) -> None:
        self._resubmit_capture_retries()
        self._submit_capture(
            {"user": user, "assistant": assistant, "sessionId": session_id, "importance": importance,
             "validFrom": valid_from, "validUntil": valid_until, "expiresAt": expires_at, "ttl": ttl},
            attempts=0,
        )

    def _submit_capture(self, payload: dict[str, Any], attempts: int, *, from_retry: bool = False) -> None:
        try:
            future = self._executor.submit(
                self._capture_turn,
                str(payload.get("user") or ""),
                str(payload.get("assistant") or ""),
                str(payload.get("sessionId") or ""),
                payload.get("importance"),
                payload.get("validFrom"), payload.get("validUntil"), payload.get("expiresAt"), payload.get("ttl"),
            )
        except AdmissionRejected as error:
            # Queue pressure did not execute the capture, so preserve the
            # backend-attempt count and retry it durably later.
            self._log_capture_error(error)
            if from_retry:
                with self._lock:
                    self._retry_inflight.discard(self._retry_key(payload))
            else:
                self._record_capture_retry(payload, attempts)
            return
        with self._lock:
            self._futures.add(future)
        future.add_done_callback(
            lambda done: self._finish_capture_future(done, payload, attempts, from_retry=from_retry)
        )

    def _finish_capture_future(self, future: Future[None], payload: dict[str, Any], attempts: int,
                               *, from_retry: bool = False) -> None:
        with self._lock:
            self._futures.discard(future)
        try:
            future.result()
        except Exception as error:
            self._log_capture_error(error)
            # Expiry happened before the worker began, not as a failed
            # storage attempt; do not burn the bounded backend retry budget.
            self._record_capture_retry(
                payload, attempts if isinstance(error, AdmissionRejected) else attempts + 1,
            )
        else:
            if from_retry:
                self._remove_capture_retry(payload)
        finally:
            if from_retry:
                with self._lock:
                    self._retry_inflight.discard(self._retry_key(payload))

    def _capture_retry_path(self) -> Path:
        return self.data_dir / "state" / "capture-retry.jsonl"

    @staticmethod
    def _retry_key(entry: dict[str, Any]) -> tuple[str, str, str, str, str, str, str, str]:
        return (
            str(entry.get("user") or ""),
            str(entry.get("assistant") or ""),
            str(entry.get("sessionId") or ""),
            str(entry.get("importance") if entry.get("importance") is not None else ""),
            str(entry.get("validFrom") or ""), str(entry.get("validUntil") or ""),
            str(entry.get("expiresAt") or ""), str(entry.get("ttl") or ""),
        )

    def _read_capture_retries(self) -> list[dict[str, Any]]:
        """Read pending capture retries, skipping corrupt lines instead of failing."""
        try:
            text = self._capture_retry_path().read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        entries = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict):
                entries.append(entry)
        return entries

    def _write_capture_retries(self, entries: list[dict[str, Any]]) -> None:
        """Atomically rewrite the retry queue via a tmp file and os.replace."""
        path = self._capture_retry_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
        fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("".join(json.dumps(entry, sort_keys=True) + "\n" for entry in entries))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    def _resubmit_capture_retries(self) -> None:
        """Requeue pending retries through the normal capture future path.

        Entries remain on disk until their future reports success. Failed work
        updates its attempt count in place; an in-memory key set prevents a
        second resubmission of the same durable entry while it is in flight.
        """
        with self._lock:
            entries = self._read_capture_retries()
            if not entries:
                return
            pending = []
            dead_letters = []
            for entry in entries:
                try:
                    attempts = int(entry.get("attempts", 0))
                except (TypeError, ValueError):
                    attempts = 0
                if attempts >= MAX_CAPTURE_RETRIES:
                    LOGGER.warning(
                        "capture retry exhausted after %d attempts; giving up on session %s",
                        attempts,
                        entry.get("sessionId"),
                    )
                    dead_letters.append({**entry, "deadLetterAt": _utcnow(), "reason": "max_attempts"})
                    continue
                if self._retry_key(entry) in self._retry_inflight:
                    continue
                pending.append((entry, attempts))
                self._retry_inflight.add(self._retry_key(entry))
            if dead_letters:
                self._append_capture_dead_letters(dead_letters)
                dead_keys = {self._retry_key(entry) for entry in dead_letters}
                self._write_capture_retries([
                    entry for entry in entries if self._retry_key(entry) not in dead_keys
                ])
        for entry, attempts in pending:
            self._submit_capture(entry, attempts, from_retry=True)

    def _append_capture_dead_letters(self, entries: list[dict[str, Any]]) -> None:
        """Durably retain exhausted capture evidence instead of discarding it."""
        path = self.data_dir / "state" / "capture-retry-dead-letter.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        os.chmod(path, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            for entry in entries:
                handle.write(json.dumps(entry, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    def _remove_capture_retry(self, payload: dict[str, Any]) -> None:
        key = self._retry_key(payload)
        with self._lock:
            self._write_capture_retries([
                entry for entry in self._read_capture_retries()
                if self._retry_key(entry) != key
            ])

    def _record_capture_retry(self, payload: dict[str, Any], attempts: int) -> None:
        """Requeue a failed capture payload, or give up once attempts hit the cap."""
        key = self._retry_key(payload)
        with self._lock:
            entries = [
                entry
                for entry in self._read_capture_retries()
                if self._retry_key(entry) != key
            ]
            if attempts >= MAX_CAPTURE_RETRIES:
                LOGGER.warning(
                    "capture retry exhausted after %d attempts; giving up on session %s",
                    attempts,
                    key[2],
                )
                self._append_capture_dead_letters([{
                    "user": key[0], "assistant": key[1], "sessionId": key[2],
                    "attempts": attempts, "deadLetterAt": _utcnow(), "reason": "max_attempts",
                }])
            else:
                entries.append({
                    "user": key[0],
                    "assistant": key[1],
                    "sessionId": key[2],
                    "importance": payload.get("importance"),
                    "validFrom": payload.get("validFrom"), "validUntil": payload.get("validUntil"),
                    "expiresAt": payload.get("expiresAt"), "ttl": payload.get("ttl"),
                    "attempts": attempts,
                    "lastErrorAt": _utcnow(),
                })
            self._write_capture_retries(entries)

    def recall(self, query: str, limit: int = 5, explain: bool = False, *, valid_at: Any = None,
               session_id: str = "", full_text: bool = False) -> str:
        """Recall active, unexpired memories, optionally at an asserted valid time."""
        parsed_valid_at = None
        if valid_at is not None:
            parsed_valid_at = normalize_timestamp(valid_at)
            if not parsed_valid_at:
                raise ValueError("validAt must be an absolute ISO-8601 or epoch-ms timestamp")
        prepared = prepare_semantic_input(query)
        if prepared["requiresSource"]:
            return str(prepared["message"])
        semantic_query = str(prepared["text"])
        adaptive_limit = min(12, max(limit, 8 if len(semantic_query) > 1200 else limit))
        vector = self._embedding.embed(semantic_query, purpose="query")
        recall_tables = self._recall_tables()
        if not recall_tables:
            return ""
        rows = []
        temporal_range = parse_temporal_range(semantic_query)
        where_clause = f"{scope_where_clause(self.scope_binding)} AND status = 'active'"
        if temporal_range:
            where_clause += (
                f" AND createdAt >= '{temporal_range['start']}'"
                f" AND createdAt < '{temporal_range['end']}'"
            )
        temporal_where = where_clause
        now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
        expiry_where = (
            f"{temporal_where} AND (expiresAt IS NULL OR expiresAt = 0 OR expiresAt > {now_ms})"
        )
        where_clause = expiry_where
        if parsed_valid_at is not None:
            where_clause += f" AND {validity_where_clause(parsed_valid_at)}"
        for namespace, recall_table in recall_tables:
            namespace_rows = self._search_recall_rows(
                recall_table, vector, where_clause, expiry_where, temporal_where,
                adaptive_limit * 3, parsed_valid_at,
            )
            for row in namespace_rows:
                row["_namespace"] = namespace
            rows.extend(namespace_rows)
        try:
            rows.extend(self._shared_pools.recall_rows(
                vector, adaptive_limit * 2, valid_at=parsed_valid_at, now_ms=now_ms,
            ))
        except TypeError as error:
            # Compatibility for externally injected pre-7.10 pool adapters;
            # native SharedPoolStore always receives the lifecycle predicates.
            if "valid_at" not in str(error) and "now_ms" not in str(error):
                raise
            rows.extend(self._shared_pools.recall_rows(vector, adaptive_limit * 2))
        poor_first_pass = not rows or all(
            row.get("_distance") is not None
            and float(row["_distance"]) > 0.65
            for row in rows
        )
        recall_config = self.config.get("recall", {})
        refinement = recall_config.get("queryRefinement", {}) if isinstance(recall_config, dict) else {}
        refinement_enabled = refinement is not False and not (
            isinstance(refinement, dict) and refinement.get("enabled") is False
        )
        refined_query = self._refine_query(semantic_query, refinement) if refinement_enabled else ""
        if poor_first_pass and refined_query and refined_query != semantic_query.lower():
            refined_vector = self._embedding.embed(refined_query, purpose="query")
            for namespace, recall_table in recall_tables:
                refined_rows = self._search_recall_rows(
                    recall_table, refined_vector, where_clause, expiry_where, temporal_where,
                    adaptive_limit * 2, parsed_valid_at,
                )
                for row in refined_rows:
                    row["_namespace"] = namespace
                    row["_queryVariant"] = "refined"
                rows.extend(refined_rows)
        rows = [
            row for row in rows
            if is_entry_live(row, now_ms) and is_entry_valid_at(row, parsed_valid_at)
        ]
        rows = self._reranker.rerank(semantic_query, rows)[:adaptive_limit]
        deduplicated = []
        seen_content: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            canonical = " ".join(
                str(row.get("content") or "").lower().split()
            )
            prior = seen_content.get(canonical, [])
            # Historical text duplicates survive only if known bounds prove
            # they describe non-overlapping periods.
            if not canonical or any(not has_disjoint_validity_windows(row, old) for old in prior):
                continue
            seen_content.setdefault(canonical, []).append(row)
            deduplicated.append(row)
        if session_id:
            rows = self._domain.boost_recall(
                deduplicated, recall_tables[0][1], adaptive_limit + 3,
                session_id=session_id,
            )
        else:
            rows = self._domain.boost_recall(
                deduplicated, recall_tables[0][1], adaptive_limit + 3,
            )
        # Boosters are additive read paths, so enforce the lifecycle gates
        # again after they contribute rows.
        rows = [
            row for row in rows
            if is_entry_live(row, now_ms) and is_entry_valid_at(row, parsed_valid_at)
        ]
        recalled = "\n".join(
            f"- {str(row['content']) if full_text else str(row['content'])[:2000]} {validity_label(row)}".rstrip()
            for row in rows
            if row.get("content")
        )
        overlay = self._domain.recall_overlay(semantic_query, rows)
        explanation = self._domain.explain_recall(rows) if explain else ""
        cognitive_blocks = "\n\n".join(self._domain.cognitive_prompt_blocks(
            acl_bindings=self.scope_binding.as_dict(), scope_key=self.scope_key,
        ))
        compression = (
            "<memory-input-compression>"
            f"original={prepared['originalLength']} compressed={len(semantic_query)}"
            "</memory-input-compression>"
            if prepared["compressed"]
            else ""
        )
        # Global inject budget (upstream 7.4.0 `recall.globalInjectMaxChars`,
        # default 17000): the memory context yields before any downstream
        # structural block; the compression marker is non-droppable, and block
        # order plus priority are preserved. Time/reminder blocks never travel
        # through this string in Hermes, so nothing downstream can be eaten.
        recall_config = self.config.get("recall")
        max_chars = (
            recall_config.get("globalInjectMaxChars")
            if isinstance(recall_config, dict)
            else None
        )
        if max_chars is None:
            max_chars = 17_000
        return apply_global_inject_budget(
            blocks=[
                {"name": "memories", "text": recalled, "droppable": True},
                {"name": "overlay", "text": overlay, "droppable": True},
                {"name": "explanation", "text": explanation, "droppable": True},
                {"name": "cognitive", "text": cognitive_blocks, "droppable": True},
                {"name": "compression", "text": compression, "droppable": False},
            ],
            max_chars=max_chars,
        )

    @staticmethod
    def _search_recall_rows(table: Any, vector: list[float], where_clause: str,
                            expiry_where_clause: str, legacy_where_clause: str, limit: int,
                            valid_at: int | None) -> list[dict[str, Any]]:
        """Search with only narrow legacy validity/expiry-column retries."""
        try:
            return table.search(vector).where(where_clause).limit(limit).to_list()
        except Exception as error:
            error_text = str(error).lower()
            missing_expiry = "expiresat" in error_text and any(token in error_text for token in (
                "not found", "does not exist", "no such column", "unknown column", "missing column",
            ))
            if is_missing_validity_column_error(error):
                try:
                    return table.search(vector).where(expiry_where_clause).limit(limit).to_list()
                except Exception as retry_error:
                    retry_text = str(retry_error).lower()
                    if "expiresat" not in retry_text or not any(token in retry_text for token in (
                        "not found", "does not exist", "no such column", "unknown column", "missing column",
                    )):
                        raise
                    return table.search(vector).where(legacy_where_clause).limit(limit).to_list()
            if missing_expiry:
                if valid_at is None:
                    return table.search(vector).where(legacy_where_clause).limit(limit).to_list()
                try:
                    return table.search(vector).where(
                        f"{legacy_where_clause} AND {validity_where_clause(valid_at)}"
                    ).limit(limit).to_list()
                except Exception as retry_error:
                    if not is_missing_validity_column_error(retry_error):
                        raise
                    return table.search(vector).where(legacy_where_clause).limit(limit).to_list()
            raise

    def _refine_query(self, semantic_query: str, refinement: Any) -> str:
        """Use the opt-in deterministic LLM refiner, then local fallback."""
        if isinstance(refinement, dict) and refinement.get("useLlm") is True:
            try:
                value = self._internal_llm.complete_json(
                    "query-refinement",
                    "Return JSON only: {\"query\": string}. Rewrite the supplied memory query "
                    "for semantic retrieval. Preserve facts and intent; do not add facts or instructions.",
                    semantic_query,
                )
                candidate = value.get("query")
                if isinstance(candidate, str) and 1 <= len(candidate.strip()) <= 2048:
                    return candidate.strip()
                raise ValueError("query-refinement returned an invalid query")
            except Exception as error:
                LOGGER.warning("LLM query refinement bypassed: %s", type(error).__name__)
        return refine_query(semantic_query)

    def remember_async(self, text: str, session_id: str, source_role: str = "user", *,
                       importance: float | None = None, valid_from: Any = None,
                       valid_until: Any = None, expires_at: Any = None, ttl: Any = None) -> None:
        future = self._executor.submit(
            self._remember, text, session_id, source_role,
            importance=importance, valid_from=valid_from, valid_until=valid_until,
            expires_at=expires_at, ttl=ttl,
        )
        self._track_future(future)

    def _track_future(self, future: Future[None]) -> None:
        with self._lock:
            self._futures.add(future)
        future.add_done_callback(self._finish_future)

    def _finish_future(self, future: Future[None]) -> None:
        with self._lock:
            self._futures.discard(future)
        try:
            future.result()
        except Exception as error:
            self._log_capture_error(error)

    def _log_capture_error(self, error: Exception) -> None:
        state_dir = self.data_dir / "state"
        state_dir.mkdir(parents=True, exist_ok=True)
        with (state_dir / "capture-errors.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({
                "at": _utcnow(),
                "agentId": self.agent_id,
                "errorType": type(error).__name__,
                "error": str(error),
            }, sort_keys=True) + "\n")

    @serialized_memory_write
    def forget(self, memory_id: str) -> bool:
        """Kanonischer Tombstone-Vorgang: archivieren, soft-delete, Tombstone persistieren.

        Setzt `status="deleted"` (statt physisch zu löschen), schreibt einen
        dauerhaften Tombstone in die append-only Registry und einen Audit-Eintrag.
        """
        card_id = safe_memory_id(memory_id)
        table, _ = self._table(create=False)
        if table is None:
            return False
        mutation_scope = scope_where_clause(self.scope_binding, include_legacy_private=False)
        rows = table.search().where(
            f"id = '{card_id}' AND {mutation_scope}"
        ).limit(1).to_list()
        if not rows:
            return False
        card = rows[0]
        if not self._card_matches_scope(card):
            return False
        from .tombstone import (
            append_tombstone_to_registry,
            archive_card_atomically,
            archive_path_for,
            build_tombstone,
        )

        archive_ref = archive_path_for(self.data_dir, self.agent_id, self.scope_key, card_id)
        # Crash-Recovery/Idempotenz: bereits deleted → fehlenden committed
        # Tombstone und Audit nachtragen, statt einen zweiten widersprüchlichen
        # Delete zu erzeugen.
        if str(card.get("status") or "") == "deleted":
            try:
                archive_card_atomically(archive_ref, card)
                from .tombstone import backfill_committed_tombstone

                backfill = backfill_committed_tombstone(
                    self.data_dir, card,
                    agent_id=self.agent_id,
                    actor=self.request_scope.get("user") or "hermes",
                    actor_type="human",
                    reason="user forget",
                    source_op="forget",
                    archive_ref=str(archive_ref),
                    scope_key=self.scope_key,
                    acl_bindings=self.scope_binding.as_dict(),
                )
            except Exception as error:
                raise RuntimeError(f"tombstone backfill failed: {error}") from error
            # Audit IMMER schreiben (auch bei alreadyCommitted), damit ein zuvor
            # fehlgeschlagener Audit-Schreibvorgang nicht dauerhaft unerfasst bleibt.
            # _append_jsonl propagiert OSError → Forget schlägt fail-closed fehl.
            self._domain.audit_mutation({
                "event": "memory.deleted",
                "agentId": self.agent_id,
                "memoryId": card_id,
                "canonicalOriginId": str(card.get("canonicalOriginId") or card_id),
                "tombstoneId": backfill["tombstone"]["tombstoneId"],
                "archivePath": str(archive_ref),
                "contentFingerprint": backfill["tombstone"]["contentFingerprint"],
                "scopeKey": self.scope_key,
                "aclBindings": self.scope_binding.as_dict(),
                "cardIdentity": {
                    "memoryId": card_id,
                    "canonicalOriginId": str(card.get("canonicalOriginId") or card_id),
                },
                "ownership": {
                    "agentId": self.agent_id,
                    "scopeKey": self.scope_key,
                    "aclBindings": self.scope_binding.as_dict(),
                },
                "result": "already_tombstoned" if backfill["alreadyCommitted"] else "committed",
            })
            return True
        archive_card_atomically(archive_ref, card)

        tombstone = build_tombstone(
            card=card,
            agent_id=self.agent_id,
            actor=self.request_scope.get("user") or "hermes",
            actor_type="human",
            reason="user forget",
            source_op="forget",
            archive_ref=str(archive_ref),
            archive_path=str(archive_ref),
            scope_key=self.scope_key,
            acl_bindings=self.scope_binding.as_dict(),
        )
        try:
            append_tombstone_to_registry(self.data_dir, self.agent_id, {**tombstone, "status": "attempted"})
        except OSError:
            return False
        final_rows = table.search().where(
            f"id = '{card_id}' AND {mutation_scope} AND status = 'active'"
        ).limit(1).to_list()
        if not final_rows or not self._card_matches_scope(final_rows[0]):
            append_tombstone_to_registry(self.data_dir, self.agent_id, {**tombstone, "status": "failed"})
            return False
        try:
            table.update(
                where=f"id = '{card_id}' AND {mutation_scope} AND status = 'active'",
                values={"status": "deleted"},
            )
        except Exception:
            append_tombstone_to_registry(self.data_dir, self.agent_id, {**tombstone, "status": "failed"})
            raise
        settled_rows = table.search().where(
            f"id = '{card_id}' AND {mutation_scope}"
        ).limit(2).to_list()
        if (
            len(settled_rows) != 1
            or not self._card_matches_scope(settled_rows[0])
            or str(settled_rows[0].get("status") or "") != "deleted"
        ):
            append_tombstone_to_registry(
                self.data_dir,
                self.agent_id,
                {**tombstone, "status": "failed"},
            )
            return False
        append_tombstone_to_registry(
            self.data_dir,
            self.agent_id,
            {
                **tombstone,
                "status": "attempted",
                "deleteSettledAt": _utcnow(),
                "settlement": "soft_deleted",
            },
        )
        append_tombstone_to_registry(self.data_dir, self.agent_id, {**tombstone, "status": "committed"})
        self._domain.audit_mutation({
            "event": "memory.deleted",
            "agentId": self.agent_id,
            "memoryId": card_id,
            "canonicalOriginId": str(card.get("canonicalOriginId") or card_id),
            "tombstoneId": tombstone["tombstoneId"],
            "archivePath": str(archive_ref),
            "contentFingerprint": tombstone["contentFingerprint"],
            "scopeKey": self.scope_key,
            "aclBindings": self.scope_binding.as_dict(),
            "cardIdentity": {
                "memoryId": card_id,
                "canonicalOriginId": str(card.get("canonicalOriginId") or card_id),
            },
            "ownership": {
                "agentId": self.agent_id,
                "scopeKey": self.scope_key,
                "aclBindings": self.scope_binding.as_dict(),
            },
            "result": "committed",
        })
        return True

    def _card_matches_scope(self, card: dict[str, Any]) -> bool:
        """Verify ownership again in Python before a destructive mutation."""
        if str(card.get("agentId") or "") != self.agent_id:
            return False
        if str(card.get("scopeKey") or "") != self.scope_key:
            return False
        if card.get("ownerKey") and str(card.get("ownerKey")) != self.scope_binding.owner_key:
            return False
        scope_type = self.scope_binding.scope_type
        if str(card.get("scopeType") or scope_type) != scope_type:
            return False
        if scope_type == "workspace" and str(card.get("workspaceIdentity") or "") != self.scope_binding.workspace:
            return False
        if scope_type == "user" and str(card.get("ownerUser") or "") != self.scope_binding.user:
            return False
        if scope_type == "chat" and str(card.get("chatScope") or "") != self.scope_binding.chat:
            return False
        return True

    def correct_async(self, memory_id: str, replacement: str, session_id: str) -> bool:
        """Admit one complete correction transaction without holding a caller lock."""
        memory_id = safe_memory_id(memory_id)
        try:
            future = self._executor.submit(self._correct_locked, memory_id, replacement, session_id)
        except AdmissionRejected:
            return False
        try:
            return bool(future.result())
        except Exception as error:
            self._log_capture_error(error)
            return False

    @serialized_memory_write
    def _correct_locked(self, memory_id: str, replacement: str, session_id: str) -> bool:
        """Keep revalidation and retirement in the same cooperating-writer lock."""
        card_id = safe_memory_id(memory_id)
        table, _ = self._table(create=False)
        if table is None:
            return False
        rows = table.search().where(
            f"id = '{card_id}' AND {scope_where_clause(self.scope_binding, include_legacy_private=False)}"
        ).limit(1).to_list()
        # Same lifecycle guard as OpenClaw correctCard(): a confirmation may
        # outlive /forget, so never turn an already deleted row into a new
        # active replacement.
        if not rows or str(rows[0].get("status") or "") == "deleted" or not self._card_matches_scope(rows[0]):
            return False
        # Admit and finish the replacement before archiving the source.  A
        # bounded queue must never turn a successful /forget into a missing
        # correction merely because capture admission was saturated.
        source = dict(rows[0])
        replacement_id = self._remember(
            replacement, session_id, "correction",
            valid_from=rows[0].get("validFrom"),
            valid_until=rows[0].get("validUntil"),
            expires_at=rows[0].get("expiresAt"),
        )
        if not replacement_id:
            return False
        # A callback can outlive the confirmation.  Read the exact source
        # again immediately before delete; never archive a changed/deleted
        # card merely because its ID is the same.
        current_rows = table.search().where(
            f"id = '{card_id}' AND {scope_where_clause(self.scope_binding, include_legacy_private=False)}"
        ).limit(1).to_list()
        if not current_rows or not self._same_correction_source(source, current_rows[0]):
            self._abandon_correction_replacement(str(replacement_id), "source_revalidation_failed")
            return False
        if self.forget(memory_id):
            return True
        self._abandon_correction_replacement(str(replacement_id), "source_archive_failed")
        return False

    def _abandon_correction_replacement(self, replacement_id: str, reason: str) -> None:
        """Archive a replacement when its source cannot safely be retired."""
        table, _ = self._table(create=False)
        if table is None:
            raise RuntimeError("cannot archive orphaned correction without memory table")
        rows = table.search().where(
            f"id = '{replacement_id}' AND {scope_where_clause(self.scope_binding, include_legacy_private=False)}"
        ).limit(1).to_list()
        if not rows or not self._card_matches_scope(rows[0]):
            raise RuntimeError("cannot locate orphaned correction replacement")
        from .tombstone import archive_card_atomically, archive_path_for

        archive_ref = archive_path_for(
            self.data_dir, self.agent_id, self.scope_key, replacement_id,
        )
        archive_card_atomically(archive_ref, rows[0])
        table.update(
            where=(f"id = '{replacement_id}' AND "
                   f"{scope_where_clause(self.scope_binding, include_legacy_private=False)} "
                   "AND status = 'active'"),
            values={"status": "archived"},
        )
        settled = table.search().where(
            f"id = '{replacement_id}' AND {scope_where_clause(self.scope_binding, include_legacy_private=False)}"
        ).limit(1).to_list()
        if not settled or str(settled[0].get("status") or "") != "archived":
            raise RuntimeError("orphaned correction replacement archive did not settle")
        self._domain.audit_mutation({
            "event": "memory.correction_abandoned",
            "agentId": self.agent_id,
            "memoryId": replacement_id,
            "scopeKey": self.scope_key,
            "aclBindings": self.scope_binding.as_dict(),
            "reason": reason,
            "archivePath": str(archive_ref),
            "result": "archived",
        })

    def _same_correction_source(self, expected: dict[str, Any], current: dict[str, Any]) -> bool:
        """Refuse a confirmation-race deletion if the source changed in place."""
        if str(current.get("status") or "") != "active" or not self._card_matches_scope(current):
            return False
        if str(current.get("content") or "") != str(expected.get("content") or ""):
            return False
        return (
            normalize_validity_window(current.get("validFrom"), current.get("validUntil"))
            == normalize_validity_window(expected.get("validFrom"), expected.get("validUntil"))
            and normalize_timestamp(current.get("expiresAt")) == normalize_timestamp(expected.get("expiresAt"))
        )

    def resolve_memory_id(self, reference: str) -> str | None:
        """Resolve an exact UUID or a conservative semantic active-card reference."""
        try:
            return safe_memory_id(reference)
        except ValueError:
            pass
        prepared = prepare_semantic_input(reference)
        if prepared["requiresSource"]:
            raise ValueError(str(prepared["message"]))
        vector = self._embedding.embed(str(prepared["text"]), purpose="query")
        table, _ = self._table(create=False)
        if table is None:
            return None
        rows = table.search(vector).where(
            f"{scope_where_clause(self.scope_binding)} AND status = 'active'"
        ).limit(5).to_list()
        if not rows:
            return None
        rows = self._reranker.rerank(str(prepared["text"]), rows)
        best = rows[0]
        distance = best.get("_distance")
        if distance is not None and float(distance) > 0.4:
            return None
        return safe_memory_id(str(best.get("id") or ""))

    def create_merge_proposal(self, incoming_text: str, session_id: str, *, valid_from: Any = None,
                              valid_until: Any = None) -> dict[str, Any] | None:
        """Create (never apply) an opt-in, scope-bound merge proposal."""
        if not bool((self.config.get("merging") or {}).get("enabled")):
            return None
        text = incoming_text.strip()
        if not text:
            return None
        if len(text) > 12_000:
            raise ValidationError("merge input exceeds 12000 characters")
        table, _ = self._table(create=False)
        if table is None:
            return None
        vector = self._embedding.embed(text)
        rows = table.search(vector).where(
            f"{scope_where_clause(self.scope_binding, include_legacy_private=False)} AND status = 'active'"
        ).limit(1).to_list()
        if not rows or not self._card_matches_scope(rows[0]):
            return None
        start, end = normalize_validity_window(valid_from, valid_until)
        candidate = {key: value for key, value in rows[0].items() if key != "vector"}
        # Native adapter has no merge LLM authority here: only propose the
        # lossless concatenation, leaving explicit apply to controls.
        proposal = build_proposal(self.agent_id, candidate, {
            "content": text, "sessionId": session_id, "validFrom": start, "validUntil": end,
        }, f"{candidate.get('content', '')}\n{text}")
        if proposal is None:
            return None
        proposal["scopeKey"] = self.scope_key
        from .durable_merge import proposal_revision
        proposal["revision"] = proposal_revision(proposal)
        proposal_path = resolve_inside(str(self.data_dir), "state", "merge-proposals", f"{proposal['proposalId']}.json")
        persist_proposal(proposal_path, proposal)
        self._domain.audit_mutation({"event": "memory.merge_proposed", "agentId": self.agent_id,
                                     "proposalId": proposal["proposalId"], "candidateId": candidate["id"],
                                     "scopeKey": self.scope_key, "result": "proposed"})
        return proposal

    def shutdown(self, timeout_seconds: float = 5.0) -> None:
        self.flush(timeout_seconds)
        self._executor.shutdown(wait=False, cancel_futures=False)
        self._embedding.close()
        try:
            self._llm_cache.close()
        except Exception as error:
            LOGGER.warning("LLM result cache close bypassed: %s", type(error).__name__)

    def flush(self, timeout_seconds: float = 5.0) -> None:
        """Wait for queued captures before a lifecycle boundary discards context."""
        with self._lock:
            futures = list(self._futures)
        wait(futures, timeout=timeout_seconds)

    def _capture_turn(self, user: str, assistant: str, session_id: str,
                      importance: float | None = None, valid_from: Any = None,
                      valid_until: Any = None, expires_at: Any = None,
                      ttl: Any = None) -> None:
        self._domain.on_turn(
            user,
            assistant,
            session_id,
            acl_bindings=self.scope_binding.as_dict(),
        )
        temporal = any(value is not None for value in (valid_from, valid_until, expires_at, ttl))
        if importance is None and not temporal:
            self._remember(user, session_id, "user")
        elif importance is None:
            self._remember(user, session_id, "user", valid_from=valid_from,
                           valid_until=valid_until, expires_at=expires_at, ttl=ttl)
        elif not temporal:
            self._remember(user, session_id, "user", importance=importance)
        else:
            self._remember(user, session_id, "user", importance=importance,
                           valid_from=valid_from, valid_until=valid_until,
                           expires_at=expires_at, ttl=ttl)
        self._remember(assistant, session_id, "assistant")

    @serialized_memory_write
    def _remember(self, content: str, session_id: str, source_role: str, *,
                  importance: float | None = None, valid_from: Any = None,
                  valid_until: Any = None, expires_at: Any = None, ttl: Any = None,
                  record_id: str | None = None, merged_from: list[str] | None = None) -> str | None:
        if record_id is not None:
            record_id = safe_memory_id(record_id)
        content = content.strip()
        if not content:
            return None
        # Tombstone-Block VOR Embedding und LanceDB-Insert: eine gleichlautende,
        # zuvor gelöschte Erinnerung im selben Agent-/Scope-Kontext darf nicht
        # still reaktiviert werden.
        from .tombstone import find_blocking_tombstone_for_capture

        blocking = find_blocking_tombstone_for_capture(self.data_dir, {
            "agentId": self.agent_id,
            "text": content,
            "scope": self.scope_binding.scope_type,
            "scopeKey": self.scope_key,
            "workspaceIdentity": str(self.request_scope.get("workspace") or ""),
            "userPrincipal": str(self.request_scope.get("user") or ""),
            "platform": str(self.request_scope.get("platform") or ""),
            "chat": str(self.request_scope.get("chat") or ""),
        })
        if blocking is not None:
            reason = blocking.get("_blockReason") or "fingerprint match"
            self._log_capture_error(RuntimeError(f"tombstone_blocked ({reason})"))
            return None
        valid_from_ms, valid_until_ms = normalize_validity_window(valid_from, valid_until)
        expiry_ms = normalize_timestamp(expires_at)
        # ttl is deliberately duration-only; an absolute expiresAt wins.  A
        # malformed/negative duration becomes the no-expiry sentinel rather
        # than a guessed deadline.
        if not expiry_ms and isinstance(ttl, str) and ttl in {"session", "short"}:
            duration = 86_400_000 if ttl == "session" else 14 * 86_400_000
            expiry_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000) + duration
        elif not expiry_ms and isinstance(ttl, (int, float)) and not isinstance(ttl, bool):
            try:
                duration = int(ttl)
            except (TypeError, ValueError, OverflowError):
                LOGGER.warning("invalid capture ttl ignored")
                duration = 0
            if 0 < duration <= 3650 * 24 * 60 * 60 * 1000:
                expiry_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000) + duration
        if record_id is not None:
            existing_table, _ = self._table(create=False)
            if existing_table is not None:
                existing = existing_table.search().where(f"id = '{record_id}'").limit(2).to_list()
                if existing:
                    if len(existing) != 1:
                        raise ValueError("duplicate stable memory identifier")
                    row = existing[0]
                    if (not self._card_matches_scope(row) or row.get("status") != "active"
                        or row.get("content") != content or row.get("sourceRole") != source_role
                        or row.get("sessionId") != session_id
                        or normalize_validity_window(row.get("validFrom"), row.get("validUntil")) != (valid_from_ms, valid_until_ms)
                        or normalize_timestamp(row.get("expiresAt")) != expiry_ms
                        or json.loads(row.get("mergedFrom") or "[]") != (merged_from or [])):
                        raise ValueError("stable memory identifier conflicts with existing record")
                    return record_id
        vector = self._embedding.embed(content)
        record = {
            "id": record_id or str(uuid.uuid4()),
            "agentId": self.agent_id,
            "scopeKey": self.scope_key,
            "scopeType": self.scope_binding.scope_type,
            "ownerKey": self.scope_binding.owner_key,
            "workspaceIdentity": self.scope_binding.workspace,
            "ownerPlatform": self.scope_binding.platform,
            "ownerUser": self.scope_binding.user,
            "chatScope": self.scope_binding.chat,
            "aclBindings": self.scope_binding.as_dict(),
            "sessionId": session_id,
            "content": content,
            "status": "active",
            "type": "observation",
            "sourceRole": source_role,
            "createdAt": _utcnow(),
            # Real-world claim validity and hard TTL are separate metadata.
            # Never derive these from createdAt/updatedAt.
            "validFrom": valid_from_ms,
            "validUntil": valid_until_ms,
            "expiresAt": expiry_ms,
            "mergedFrom": json.dumps(merged_from or []),
            "vector": vector,
            # Explicit trust state (upstream 7.4.0): genuine user captures start
            # as `observed`; every other new write is explicitly `untrusted`.
            # A broken cutoff downgrades to `untrusted` — never the reverse.
            "epistemicStatus": decide_epistemic_status_for_capture(
                text=content,
                source_message_role=source_role,
                cutoff_failed=not self._epistemic_cutoff["ok"],
            ),
        }
        table, inserted = self._table(create=True, first_record=record)
        if table is not None and not inserted:
            self._ensure_capture_columns(table)
            table.add([record])
        if table is not None:
            if importance is None:
                self._domain.on_memory(record, table)
            else:
                self._domain.on_memory(record, table, importance=importance)
            # Confirm the exact card persisted under the same ownership and
            # temporal metadata before reporting success to /correct.
            search = getattr(table, "search", None)
            if not callable(search):  # lightweight unit-test table only
                return str(record["id"])
            persisted = search().where(
                f"id = '{record['id']}' AND {scope_where_clause(self.scope_binding, include_legacy_private=False)}"
            ).limit(2).to_list()
            if len(persisted) == 1:
                candidate = persisted[0]
                if (
                    self._card_matches_scope(candidate)
                    and str(candidate.get("content") or "") == content
                    and normalize_validity_window(candidate.get("validFrom"), candidate.get("validUntil"))
                    == (valid_from_ms, valid_until_ms)
                    and normalize_timestamp(candidate.get("expiresAt")) == expiry_ms
                ):
                    return str(record["id"])
        return None

    def list_merge_proposals(self) -> list[dict[str, Any]]:
        """List only valid proposals belonging to the current exact scope."""
        from .durable_merge import proposal_revision
        directory = resolve_inside(str(self.data_dir), "state", "merge-proposals")
        result = []
        if not directory.is_dir():
            return result
        for path in sorted(directory.glob("*.json"))[:500]:
            if path.is_symlink() or path.stat().st_size > 1_000_000:
                continue
            try:
                safe_memory_id(path.stem)
                proposal = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if (isinstance(proposal, dict) and proposal.get("agentId") == self.agent_id
                and proposal.get("scopeKey") == self.scope_key
                and proposal.get("revision") == proposal_revision(proposal)):
                result.append(proposal)
        return result

    @serialized_memory_write
    def apply_merge_proposal(self, proposal_id: str, *, approved_revision: str | None = None) -> bool:
        """Explicit crash-safe merge apply; source is retired only last."""
        from .durable_merge import stable_replacement_id, valid_time_marker, combined_window, proposal_revision
        proposal_id = safe_memory_id(proposal_id)
        if not isinstance(approved_revision, str) or not approved_revision:
            return False
        lexical = self.data_dir / "state" / "merge-proposals" / f"{proposal_id}.json"
        if lexical.is_symlink() or lexical.parent.is_symlink() or lexical.parent.parent.is_symlink():
            return False
        path = resolve_inside(str(self.data_dir), "state", "merge-proposals", f"{proposal_id}.json")
        if path.is_symlink() or (path.exists() and path.stat().st_size > 1_000_000):
            return False
        try:
            proposal = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        if (not isinstance(proposal, dict) or proposal.get("scopeKey") != self.scope_key
            or proposal.get("agentId") != self.agent_id or proposal.get("proposalId") != proposal_id):
            return False
        revision = proposal_revision(proposal)
        if proposal.get("revision") != revision or (approved_revision is not None and approved_revision != revision):
            return False
        if proposal.get("state") not in {"proposed", "prepared", "materialized", "applied"}:
            return False
        snapshot = proposal.get("candidateSnapshot") or {}
        incoming = proposal.get("incomingSnapshot") or {}
        if not isinstance(snapshot, dict) or not isinstance(incoming, dict) or not self._card_matches_scope(snapshot):
            return False
        candidate_id = safe_memory_id(str(proposal.get("candidateId") or ""))
        replacement_id = safe_memory_id(str(proposal.get("replacementId") or ""))
        expected_id = stable_replacement_id(self.agent_id, candidate_id, str(incoming.get("content") or ""))
        expected_lineage = [candidate_id, valid_time_marker(snapshot)]
        merged_text = str(snapshot.get("content") or "") + "\n" + str(incoming.get("content") or "")
        if (snapshot.get("id") != candidate_id or replacement_id != expected_id
            or proposal.get("mergedFrom") != expected_lineage or proposal.get("mergedText") != merged_text
            or has_disjoint_validity_windows(snapshot, incoming)):
            return False
        start, end = combined_window(snapshot, incoming)
        expiry = normalize_timestamp(snapshot.get("expiresAt"))

        def read(identifier):
            table, _ = self._table(create=False)
            if table is None:
                return []
            return table.search().where(f"id = '{identifier}' AND {scope_where_clause(self.scope_binding, include_legacy_private=False)}").limit(2).to_list()

        def replacement_matches(rows):
            if len(rows) != 1 or not self._card_matches_scope(rows[0]):
                return False
            row = rows[0]
            try:
                lineage = json.loads(row.get("mergedFrom") or "null")
            except (TypeError, ValueError):
                return False
            return (isinstance(lineage, list) and lineage == expected_lineage
                and row.get("status") == "active" and row.get("content") == merged_text
                and normalize_validity_window(row.get("validFrom"), row.get("validUntil")) == (start, end)
                and normalize_timestamp(row.get("expiresAt")) == expiry)

        def conflict():
            proposal["state"] = "conflict"
            persist_proposal(path, proposal)
            return False

        def retired_source_matches(rows):
            return (len(rows) == 1 and rows[0].get("status") == "deleted"
                and self._same_correction_source(snapshot, {**rows[0], "status": "active"}))

        rows = read(candidate_id)
        existing = read(replacement_id)
        if proposal["state"] == "applied":
            return replacement_matches(existing) and retired_source_matches(rows)
        # Recovery after source retirement but before proposal acknowledgement.
        if proposal["state"] == "materialized" and replacement_matches(existing) and retired_source_matches(rows):
            proposal["state"] = "applied"
            persist_proposal(path, proposal)
            return True
        if len(rows) != 1 or not self._same_correction_source(snapshot, rows[0]):
            return conflict()
        if existing and not replacement_matches(existing):
            return conflict()
        if existing and proposal["state"] != "materialized":
            # The insert may have survived a crash before graph/metadata/mirror
            # materialization. Never retire the source on table existence alone.
            proposal["state"] = "repair_required"
            persist_proposal(path, proposal)
            return False
        if not existing:
            proposal["state"] = "prepared"
            persist_proposal(path, proposal)
            stored = self._remember(merged_text, str(incoming.get("sessionId") or ""), "merge",
                valid_from=start, valid_until=end, expires_at=expiry,
                record_id=replacement_id, merged_from=expected_lineage)
            if stored != replacement_id:
                return False
            proposal["state"] = "materialized"
            persist_proposal(path, proposal)
        if not replacement_matches(read(replacement_id)):
            return conflict()
        latest = read(candidate_id)
        if len(latest) != 1 or not self._same_correction_source(snapshot, latest[0]):
            if replacement_matches(read(replacement_id)):
                self._abandon_correction_replacement(replacement_id, "merge_source_revalidation_failed")
            return conflict()
        if not self.forget(candidate_id):
            return False
        proposal["state"] = "applied"
        persist_proposal(path, proposal)
        return True

    @staticmethod
    def _schema_names(table: Any) -> set[str]:
        """Return schema names across real LanceDB tables and lightweight fakes."""
        # lancedb exposes `schema` as a property on real tables and as a method
        # on some fakes; accept both, prefer pyarrow's flat `names` when present.
        schema_attr = getattr(table, "schema", None)
        schema = schema_attr() if callable(schema_attr) else schema_attr
        return set(getattr(schema, "names", ()) or ()) | {
            str(getattr(field, "name", "")) for field in getattr(schema, "fields", ()) or ()
        }

    @staticmethod
    def _ensure_capture_columns(table: Any) -> None:
        """Migrate legacy memory tables before appending the current record shape."""
        names = Plur1busRuntime._schema_names(table)
        add_columns = getattr(table, "add_columns", None)
        if not callable(add_columns):
            raise RuntimeError("capture schema migration is unavailable")

        if "epistemicStatus" not in names:
            add_columns({"epistemicStatus": "''"})
            names.add("epistemicStatus")
        if "mergedFrom" not in names:
            add_columns({"mergedFrom": "'[]'"})
            names.add("mergedFrom")
        try:
            import pyarrow as pa
        except ImportError as error:  # pragma: no cover - LanceDB supplies PyArrow
            raise RuntimeError("capture schema migration requires pyarrow") from error

        acl_type = pa.struct([
            pa.field(name, pa.string())
            for name in _ACL_BINDING_STRING_COLUMNS
        ])
        schema_attr = getattr(table, "schema", None)
        schema = schema_attr() if callable(schema_attr) else schema_attr
        # These defaults are material: legacy active rows mean unknown
        # validity/no expiry, never the Unix epoch.  Real Lance schemas expose
        # ``names``; retain minimal older test doubles which cannot represent
        # expression-default migrations.
        if getattr(schema, "names", None) is not None:
            for field in ("validFrom", "validUntil", "expiresAt"):
                if field not in names:
                    add_columns({field: "0"})
                    names.add(field)
        field_reader = getattr(schema, "field", None)
        replace_acl = False
        existing_acl_type = None
        if "aclBindings" in names and callable(field_reader):
            existing_acl_type = field_reader("aclBindings").type
            if pa.types.is_struct(existing_acl_type):
                children = {field.name: field for field in existing_acl_type}
                replace_acl = any(
                    name not in children
                    or not pa.types.is_string(children[name].type)
                    for name in _ACL_BINDING_STRING_COLUMNS
                )
            else:
                replace_acl = True

        if replace_acl:
            # LanceDB cannot widen a Struct through alter_columns. Replacing an
            # empty/null partial column is lossless; populated incompatible ACL
            # evidence must stop for explicit repair rather than be discarded.
            where = "aclBindings IS NOT NULL"
            if existing_acl_type is not None and pa.types.is_string(existing_acl_type):
                where += " AND aclBindings != ''"
            try:
                populated = table.search().where(where).limit(1).to_list()
            except Exception as error:
                raise RuntimeError(
                    "cannot verify incompatible aclBindings values"
                ) from error
            if populated:
                raise RuntimeError(
                    "incompatible aclBindings schema contains non-null values"
                )
            drop_columns = getattr(table, "drop_columns", None)
            if not callable(drop_columns):
                raise RuntimeError("aclBindings schema replacement is unavailable")
            drop_columns(["aclBindings"])
            names.remove("aclBindings")

        missing_strings = [
            name for name in _CAPTURE_SCOPE_STRING_COLUMNS if name not in names
        ]
        missing_acl = "aclBindings" not in names
        if not missing_strings and not missing_acl:
            return

        fields = [pa.field(name, pa.string()) for name in missing_strings]
        if missing_acl:
            fields.append(pa.field("aclBindings", acl_type))
        # Arrow fields initialize legacy rows as null. Do not invent ACL
        # principals for old rows whose opaque scope keys cannot be reversed.
        add_columns(pa.schema(fields))

    def _table(self, create: bool, first_record: dict[str, Any] | None = None):
        try:
            import lancedb
        except ImportError as error:
            raise RuntimeError("PLUR1BUS requires lancedb") from error
        agent_dir = self._writer_route.path
        agent_dir.mkdir(parents=True, exist_ok=True)
        db = lancedb.connect(str(agent_dir))
        try:
            return db.open_table("memories"), False
        except Exception:
            if not create or first_record is None:
                return None, False
            return db.create_table("memories", data=[first_record]), True

    def _recall_tables(self):
        """Open configured recall tables without creating read-only namespaces."""
        try:
            import lancedb
        except ImportError as error:
            raise RuntimeError("PLUR1BUS requires lancedb") from error
        tables = []
        for route in self._recall_routes:
            if not route.path.is_dir():
                continue
            database = lancedb.connect(str(route.path))
            try:
                table = database.open_table("memories")
            except Exception as error:
                self._domain._append_jsonl(
                    self.data_dir
                    / "state"
                    / self.agent_id
                    / "namespace-errors.jsonl",
                    {
                        "namespace": route.name,
                        "errorType": type(error).__name__,
                        "error": str(error),
                    },
                )
                continue
            tables.append((route.name, table))
        return tables

    @staticmethod
    def _scope_key(scope: Any) -> str:
        """Return the canonical key for a request scope (legacy API helper)."""
        return binding_from_scope("agent", scope).key

    def _scope_where(self, suffix: str = "") -> str:
        """Return this runtime's exact pre-limit LanceDB ACL predicate."""
        return scope_where_clause(self.scope_binding) + suffix
