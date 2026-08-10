"""Local PLUR1BUS storage, embedding, and reranking runtime for Hermes."""

from __future__ import annotations

import json
import logging
import os
import threading
import urllib.error
import urllib.request
import uuid
from concurrent.futures import Future, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .cache import EmbeddingCache
from .domain import Plur1busDomain
from .llm_cache import LlmResultCache
from .semantic_input import prepare_semantic_input
from .namespaces import resolve_namespace_routes
from .shared_pools import SharedPoolStore, SharedPrincipal
from .cognition import parse_temporal_range
from .query_refinement import refine_query
from .llm_backend import InternalLlmBackend
from .validation import ValidationError, safe_agent_id, safe_memory_id


def _utcnow() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


OMLX_BASE_URL = "http://127.0.0.1:8000/v1"

LOGGER = logging.getLogger(__name__)

# Mirror of upstream PLUR1BUS MAX_POSTPROCESSING_RETRIES (7.2.1 parity).
MAX_CAPTURE_RETRIES = 5


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
        self._cache = EmbeddingCache(config, hermes_home)

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
        if not texts:
            return []
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
            expected = int(self.config.get("dimensions", len(vector)))
            if len(vector) != expected:
                raise ValidationError(f"embedding dimensions mismatch: expected {expected}, got {len(vector)}")
            results[index] = vector
            self._cache.set(text, vector, purpose)
        return [value for value in results if value is not None]

    def close(self) -> None:
        """Close persistent cache handles owned by this backend."""
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
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as error:
            raise RuntimeError("local embeddings require sentence-transformers") from error
        model_name = str(config.get("model", "intfloat/multilingual-e5-base"))
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

    def _embed_remote(self, config: dict[str, Any], text: str, *, purpose: str) -> list[float]:
        key = os.environ.get(str(config.get("apiKeyEnv", "PLUR1BUS_EMBEDDING_API_KEY")), "")
        if not key:
            raise RuntimeError("remote embedding API key is not configured")
        base_url = str(config.get("baseUrl") or "https://api.openai.com/v1").rstrip("/")
        body = {"model": config["model"], "input": text, "encoding_format": "float"}
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

    def __init__(self, data_dir: Path, config: dict[str, Any], agent_id: str, scope: dict[str, Any] | None = None) -> None:
        self.data_dir = data_dir
        self.config = config
        self.agent_id = safe_agent_id(agent_id)
        self.request_scope = dict(scope or {})
        self.scope_key = self._scope_key(self.request_scope)
        self._writer_route, self._recall_routes = resolve_namespace_routes(
            data_dir, self.agent_id, config
        )
        self._shared_pools = SharedPoolStore(
            data_dir,
            SharedPrincipal(
                workspace=str(
                    self.request_scope.get("workspace")
                    or config.get("workspaceId")
                    or self.agent_id
                ),
                platform=str(self.request_scope.get("platform") or ""),
                account=str(self.request_scope.get("account") or ""),
                user=str(self.request_scope.get("user") or ""),
            ),
        )
        embedding_config = dict(config.get("embedding", {}))
        embedding_config["_scopeId"] = self.agent_id
        self._embedding = EmbeddingBackend(embedding_config, data_dir)
        self._reranker = RerankerBackend(dict(config.get("reranker", {})), data_dir.parent)
        self._domain = Plur1busDomain(data_dir, self.agent_id, config)
        llm_cache_config = dict(config.get("llmResultCache", {}))
        self._llm_cache = LlmResultCache(
            data_dir,
            self.agent_id,
            ttl_ms=llm_cache_config.get("ttlMs", 86_400_000),
            max_entries=llm_cache_config.get("maxEntries", 256),
            persist=llm_cache_config.get("persist", False),
            max_bytes=llm_cache_config.get("maxBytes", 67_108_864),
            cache_version=llm_cache_config.get("cacheVersion", "1"),
        )
        self._internal_llm = InternalLlmBackend(config, self.agent_id)
        self._domain.set_llm_backend(self._internal_llm)
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="plur1bus-capture")
        self._futures: set[Future[None]] = set()
        self._lock = threading.RLock()

    def capture_async(self, user: str, assistant: str, session_id: str) -> None:
        self._resubmit_capture_retries()
        self._submit_capture(
            {"user": user, "assistant": assistant, "sessionId": session_id},
            attempts=0,
        )

    def _submit_capture(self, payload: dict[str, Any], attempts: int) -> None:
        future = self._executor.submit(
            self._capture_turn,
            str(payload.get("user") or ""),
            str(payload.get("assistant") or ""),
            str(payload.get("sessionId") or ""),
        )
        with self._lock:
            self._futures.add(future)
        future.add_done_callback(
            lambda done: self._finish_capture_future(done, payload, attempts)
        )

    def _finish_capture_future(self, future: Future[None], payload: dict[str, Any], attempts: int) -> None:
        with self._lock:
            self._futures.discard(future)
        try:
            future.result()
        except Exception as error:
            self._log_capture_error(error)
            self._record_capture_retry(payload, attempts + 1)

    def _capture_retry_path(self) -> Path:
        return self.data_dir / "state" / "capture-retry.jsonl"

    @staticmethod
    def _retry_key(entry: dict[str, Any]) -> tuple[str, str, str]:
        return (
            str(entry.get("user") or ""),
            str(entry.get("assistant") or ""),
            str(entry.get("sessionId") or ""),
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
        temp_path = path.with_name(path.name + ".tmp")
        temp_path.write_text(
            "".join(json.dumps(entry, sort_keys=True) + "\n" for entry in entries),
            encoding="utf-8",
        )
        os.replace(temp_path, path)

    def _resubmit_capture_retries(self) -> None:
        """Requeue pending retries through the normal capture future path.

        Resubmitted payloads leave the retry file here; a failed retry appends
        itself back with an incremented attempts counter, so a payload is never
        queued twice at the same time.
        """
        with self._lock:
            entries = self._read_capture_retries()
            if not entries:
                return
            pending = []
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
                    continue
                pending.append((entry, attempts))
            self._write_capture_retries([])
        for entry, attempts in pending:
            self._submit_capture(entry, attempts)

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
            else:
                entries.append({
                    "user": key[0],
                    "assistant": key[1],
                    "sessionId": key[2],
                    "attempts": attempts,
                    "lastErrorAt": _utcnow(),
                })
            self._write_capture_retries(entries)

    def recall(self, query: str, limit: int = 5, explain: bool = False) -> str:
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
        where_clause = (
            f"agentId = '{self.agent_id}' AND "
            f"scopeKey = '{self.scope_key}' AND status = 'active'"
        )
        if temporal_range:
            where_clause += (
                f" AND createdAt >= '{temporal_range['start']}'"
                f" AND createdAt < '{temporal_range['end']}'"
            )
        for namespace, recall_table in recall_tables:
            namespace_rows = recall_table.search(vector).where(
                where_clause
            ).limit(adaptive_limit * 3).to_list()
            for row in namespace_rows:
                row["_namespace"] = namespace
            rows.extend(namespace_rows)
        rows.extend(
            self._shared_pools.recall_rows(vector, adaptive_limit * 2)
        )
        poor_first_pass = not rows or all(
            row.get("_distance") is not None
            and float(row["_distance"]) > 0.65
            for row in rows
        )
        refined_query = refine_query(semantic_query)
        if poor_first_pass and refined_query and refined_query != semantic_query.lower():
            refined_vector = self._embedding.embed(refined_query, purpose="query")
            for namespace, recall_table in recall_tables:
                refined_rows = recall_table.search(refined_vector).where(
                    where_clause
                ).limit(adaptive_limit * 2).to_list()
                for row in refined_rows:
                    row["_namespace"] = namespace
                    row["_queryVariant"] = "refined"
                rows.extend(refined_rows)
        rows = self._reranker.rerank(semantic_query, rows)[:adaptive_limit]
        deduplicated = []
        seen_content = set()
        for row in rows:
            canonical = " ".join(
                str(row.get("content") or "").lower().split()
            )
            if not canonical or canonical in seen_content:
                continue
            seen_content.add(canonical)
            deduplicated.append(row)
        rows = self._domain.boost_recall(
            deduplicated, recall_tables[0][1], adaptive_limit + 3
        )
        recalled = "\n".join(
            f"- {str(row['content'])[:2000]}"
            for row in rows
            if row.get("content")
        )
        recalled = recalled[:12000]
        overlay = self._domain.recall_overlay(semantic_query, rows)
        explanation = self._domain.explain_recall(rows) if explain else ""
        compression = (
            "<memory-input-compression>"
            f"original={prepared['originalLength']} compressed={len(semantic_query)}"
            "</memory-input-compression>"
            if prepared["compressed"]
            else ""
        )
        return "\n\n".join(
            part for part in (recalled, overlay, explanation, compression) if part
        )

    def remember_async(self, text: str, session_id: str, source_role: str = "user") -> None:
        future = self._executor.submit(self._remember, text, session_id, source_role)
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

    def forget(self, memory_id: str) -> bool:
        """Archive a card before marking it inactive; never hard-delete it."""
        card_id = safe_memory_id(memory_id)
        table, _ = self._table(create=False)
        if table is None:
            return False
        rows = table.search().where(f"id = '{card_id}' AND agentId = '{self.agent_id}' AND scopeKey = '{self.scope_key}'").limit(1).to_list()
        if not rows:
            return False
        archive_dir = self.data_dir / "archives"
        archive_dir.mkdir(parents=True, exist_ok=True)
        (archive_dir / f"{card_id}.json").write_text(json.dumps(rows[0], indent=2, sort_keys=True) + "\n", encoding="utf-8")
        table.update(where=f"id = '{card_id}'", values={"status": "archived"})
        return True

    def correct_async(self, memory_id: str, replacement: str, session_id: str) -> bool:
        if not self.forget(memory_id):
            return False
        self.remember_async(replacement, session_id, source_role="correction")
        return True

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
            f"agentId = '{self.agent_id}' AND "
            f"scopeKey = '{self.scope_key}' AND status = 'active'"
        ).limit(5).to_list()
        if not rows:
            return None
        rows = self._reranker.rerank(str(prepared["text"]), rows)
        best = rows[0]
        distance = best.get("_distance")
        if distance is not None and float(distance) > 0.4:
            return None
        return safe_memory_id(str(best.get("id") or ""))

    def shutdown(self, timeout_seconds: float = 5.0) -> None:
        self.flush(timeout_seconds)
        self._executor.shutdown(wait=False, cancel_futures=False)
        self._embedding.close()
        self._llm_cache.close()

    def flush(self, timeout_seconds: float = 5.0) -> None:
        """Wait for queued captures before a lifecycle boundary discards context."""
        with self._lock:
            futures = list(self._futures)
        wait(futures, timeout=timeout_seconds)

    def _capture_turn(self, user: str, assistant: str, session_id: str) -> None:
        self._domain.on_turn(user, assistant, session_id)
        self._remember(user, session_id, "user")
        self._remember(assistant, session_id, "assistant")

    def _remember(self, content: str, session_id: str, source_role: str) -> None:
        content = content.strip()
        if not content:
            return
        vector = self._embedding.embed(content)
        record = {
            "id": str(uuid.uuid4()),
            "agentId": self.agent_id,
            "scopeKey": self.scope_key,
            "sessionId": session_id,
            "content": content,
            "status": "active",
            "type": "observation",
            "sourceRole": source_role,
            "createdAt": _utcnow(),
            "vector": vector,
        }
        table, inserted = self._table(create=True, first_record=record)
        if table is not None and not inserted:
            table.add([record])
        if table is not None:
            self._domain.on_memory(record, table)

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
    def _scope_key(scope: dict[str, Any]) -> str:
        del scope
        normalized = {"workspace": "default", "user": "", "chat": ""}
        return uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(normalized, sort_keys=True)).hex
