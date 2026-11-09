"""Exact, agent-scoped cache for deterministic internal LLM transformations."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import os
import sqlite3
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future
from pathlib import Path
from typing import Any, Awaitable, Callable
from .cache_budget import admit


LLM_RESULT_CACHE_PURPOSES = frozenset({
    "capture-summary", "recall-query-summary", "merge-decision",
    "conflict-resolution", "emotion-classification", "episode-analysis",
    "conversation-insights", "skill-extraction", "rem-pattern-analysis",
    "knowledge-update",
    "categorize",
    "contradiction-detection",
    "memory-fact-quality",
    "query-refinement",
    "speaker-mapping",
    "temporal-parsing",
})


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class LlmResultCache:
    """Cache deterministic internal LLM results without persisting prompts or secrets."""

    def __init__(
        self,
        data_dir: Path,
        agent_id: str,
        *,
        ttl_ms: int = 86_400_000,
        max_entries: int = 256,
        persist: bool = False,
        max_bytes: int = 67_108_864,
        cache_version: str = "1",
    ) -> None:
        self.ttl_ms = min(max(int(ttl_ms), 60_000), 604_800_000)
        self.max_entries = min(max(int(max_entries), 0), 10_000)
        self.max_bytes = min(max(int(max_bytes), 0), 1_073_741_824)
        self.cache_version = str(cache_version)
        self._memory: OrderedDict[str, tuple[int, dict[str, Any]]] = OrderedDict()
        self._inflight: dict[tuple[Any, str], asyncio.Task] = {}
        self._sync_inflight: dict[str, Future] = {}
        self._lock = threading.RLock()
        self._closed = False
        self.metrics = {
            "hits": 0,
            "misses": 0,
            "persistHits": 0,
            "persistWrites": 0,
            "persistSkips": 0,
            "coalesced": 0,
            "avoidedTokens": 0,
        }
        self._connection: sqlite3.Connection | None = None
        if persist and self.max_entries:
            cache_dir = Path(data_dir) / "cache" / "llm-result-cache-v1"
            cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(cache_dir, 0o700)
            db_name = _hash(str(agent_id))[:24] + ".sqlite"
            db_path = cache_dir / db_name
            self._connection = sqlite3.connect(db_path, check_same_thread=False)
            self._connection.execute("PRAGMA auto_vacuum=INCREMENTAL")
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA busy_timeout=5000")
            self._connection.execute("PRAGMA auto_vacuum=INCREMENTAL")
            self._connection.execute(
                "CREATE TABLE IF NOT EXISTS results ("
                "cache_key TEXT PRIMARY KEY, response_text TEXT NOT NULL, "
                "usage_json TEXT NOT NULL, expires_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL DEFAULT 0)"
            )
            if "accessed_at" not in {row[1] for row in self._connection.execute("PRAGMA table_info(results)")}:
                self._connection.execute("ALTER TABLE results ADD COLUMN accessed_at INTEGER NOT NULL DEFAULT 0")
            self._connection.execute(
                "DELETE FROM results WHERE expires_at <= ?", (self._now_ms(),)
            )
            self._connection.commit()
            os.chmod(db_path, 0o600)
            self.db_path = db_path
        else:
            self.db_path = None

    @staticmethod
    def _now_ms() -> int:
        return int(time.time() * 1000)

    def make_key(self, request: dict[str, Any]) -> str | None:
        """Return a hashed exact-cache key, or None for a non-allowlisted purpose."""
        purpose = str(request.get("purpose") or "")
        if purpose not in LLM_RESULT_CACHE_PURPOSES:
            return None
        material = {
            "cacheVersion": self.cache_version,
            "purpose": purpose,
            "scopeId": str(request.get("scopeId") or ""),
            "endpoint": str(request.get("endpoint") or ""),
            "credentialHash": _hash(str(request.get("credential") or "")),
            "model": str(request.get("model") or ""),
            "messagesHash": _hash(_canonical(request.get("messages") or [])),
            "maxTokens": int(request.get("maxTokens") or 0),
            "temperature": request.get("temperature"),
            "jsonMode": bool(request.get("jsonMode")),
            "disableThinking": bool(request.get("disableThinking")),
            "headersHash": _hash(_canonical(request.get("headers") or {})),
            "payloadHash": _hash(_canonical(request.get("payload") or {})),
        }
        return _hash(_canonical(material))

    def get_or_compute_sync(
        self, request: dict[str, Any], compute: Callable[[], tuple[str, dict[str, Any] | None]],
    ) -> dict[str, Any]:
        """Coalesce synchronous live calls; cache faults never suppress computation."""
        try:
            key = self.make_key(request) if self.max_entries and not self._closed else None
            cached = self.get(request)
            if cached is not None:
                return cached
        except Exception as error:
            logging.getLogger(__name__).warning("LLM cache read bypassed: %s", type(error).__name__)
            key = None
        if key is None:
            text, usage = compute()
            return {"text": text, "usage": usage or {}, "cached": False}
        with self._lock:
            future = self._sync_inflight.get(key)
            owner = future is None
            if owner:
                future = Future()
                self._sync_inflight[key] = future
            else:
                self.metrics["coalesced"] += 1
        if not owner:
            return dict(future.result())
        try:
            # A preceding owner may have completed between the initial lookup
            # and acquiring the coordination lock.
            try:
                cached = self.get(request)
            except Exception as error:
                logging.getLogger(__name__).warning("LLM cache reread bypassed: %s", type(error).__name__)
                cached = None
            if cached is not None:
                future.set_result(cached)
                return cached
            text, usage = compute()
            result = {"text": text, "usage": usage or {}, "cached": False}
            try:
                self.put(request, text, usage)
            except Exception as error:
                logging.getLogger(__name__).warning("LLM cache write bypassed: %s", type(error).__name__)
            future.set_result(result)
            return result
        except BaseException as error:
            future.set_exception(error)
            raise
        finally:
            with self._lock:
                if self._sync_inflight.get(key) is future:
                    self._sync_inflight.pop(key, None)

    def get(self, request: dict[str, Any]) -> dict[str, Any] | None:
        """Read a valid result from memory or SQLite."""
        cache_key = self.make_key(request)
        if cache_key is None or not self.max_entries or self._closed:
            return None
        now = self._now_ms()
        with self._lock:
            cached = self._memory.get(cache_key)
            if cached and cached[0] > now:
                self._memory.move_to_end(cache_key)
                self.metrics["hits"] += 1
                self.metrics["avoidedTokens"] += int(
                    (cached[1].get("usage") or {}).get("total_tokens") or 0
                )
                return dict(cached[1])
            if cached:
                self._memory.pop(cache_key, None)
            if self._connection is not None:
                row = self._connection.execute(
                    "SELECT response_text, usage_json, expires_at FROM results "
                    "WHERE cache_key = ?",
                    (cache_key,),
                ).fetchone()
                if row and int(row[2]) > now:
                    result = {
                        "text": row[0],
                        "usage": json.loads(row[1]),
                        "cached": True,
                    }
                    self._connection.execute("UPDATE results SET accessed_at=? WHERE cache_key=?", (now, cache_key))
                    self._connection.commit()
                    self._remember(cache_key, int(row[2]), result)
                    self.metrics["hits"] += 1
                    self.metrics["persistHits"] += 1
                    return dict(result)
                if row:
                    self._connection.execute(
                        "DELETE FROM results WHERE cache_key = ?", (cache_key,)
                    )
                    self._connection.commit()
            self.metrics["misses"] += 1
            return None

    def put(
        self,
        request: dict[str, Any],
        text: str,
        usage: dict[str, Any] | None = None,
    ) -> bool:
        """Store a non-empty valid response for an allowlisted purpose."""
        cache_key = self.make_key(request)
        response_text = str(text or "")
        if cache_key is None or not self.max_entries or self._closed or not response_text.strip():
            return False
        if request.get("jsonMode"):
            try:
                json.loads(response_text)
            except (TypeError, ValueError):
                return False
        result = {"text": response_text, "usage": dict(usage or {}), "cached": True}
        expires_at = self._now_ms() + self.ttl_ms
        with self._lock:
            self._remember(cache_key, expires_at, result)
            if self._connection is not None:
                # SQLite may allocate pages/WAL frames beyond payload bytes.
                # Reserve conservative page headroom; this is an admission
                # budget, not an OS-enforced filesystem quota.
                required_bytes = len(response_text.encode("utf-8")) * 2 + len(_canonical(usage or {}).encode("utf-8")) + 32_768
                if not admit(self._connection, self.db_path, "results", now=self._now_ms(),
                             max_entries=self.max_entries, max_bytes=self.max_bytes,
                             required_bytes=required_bytes, protected_key=cache_key):
                    self.metrics["persistSkips"] += 1
                    return True
                self._connection.execute(
                    "INSERT INTO results(cache_key,response_text,usage_json,expires_at,accessed_at) "
                    "VALUES(?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET "
                    "response_text=excluded.response_text, "
                    "usage_json=excluded.usage_json, expires_at=excluded.expires_at, accessed_at=excluded.accessed_at",
                    (cache_key, response_text, _canonical(usage or {}), expires_at, self._now_ms()),
                )
                self._connection.commit()
                self.metrics["persistWrites"] += 1
        return True

    def _remember(
        self,
        cache_key: str,
        expires_at: int,
        result: dict[str, Any],
    ) -> None:
        self._memory[cache_key] = (expires_at, result)
        self._memory.move_to_end(cache_key)
        while len(self._memory) > self.max_entries:
            self._memory.popitem(last=False)

    async def get_or_compute(
        self,
        request: dict[str, Any],
        compute: Callable[[], Awaitable[tuple[str, dict[str, Any] | None]] | tuple[str, dict[str, Any] | None]],
    ) -> dict[str, Any]:
        """Return a cached result or coalesce and execute one live computation."""
        try:
            cached = self.get(request)
        except Exception as error:
            logging.getLogger(__name__).warning("Async LLM cache read bypassed: %s", type(error).__name__)
            cached = None
        if cached is not None:
            return cached
        cache_key = self.make_key(request) if self.max_entries and not self._closed else None
        if cache_key is None:
            value = compute()
            text, usage = await value if inspect.isawaitable(value) else value
            return {"text": text, "usage": usage or {}, "cached": False}
        # Tasks belong to their event loop; never await another loop's task.
        inflight_key = (asyncio.get_running_loop(), cache_key)
        with self._lock:
            task = self._inflight.get(inflight_key)
            if task is None:
                task = asyncio.create_task(self._compute_and_store(request, compute))
                self._inflight[inflight_key] = task
                def release(done: asyncio.Task) -> None:
                    with self._lock:
                        if self._inflight.get(inflight_key) is done:
                            self._inflight.pop(inflight_key, None)
                    # Consume exceptions if every waiter was cancelled.
                    if not done.cancelled():
                        done.exception()
                task.add_done_callback(release)
            else:
                self.metrics["coalesced"] += 1
        return await asyncio.shield(task)

    async def _compute_and_store(
        self,
        request: dict[str, Any],
        compute: Callable[[], Any],
    ) -> dict[str, Any]:
        value = compute()
        text, usage = await value if inspect.isawaitable(value) else value
        try:
            self.put(request, text, usage)
        except Exception as error:
            logging.getLogger(__name__).warning("Async LLM cache write bypassed: %s", type(error).__name__)
        return {"text": text, "usage": usage or {}, "cached": False}

    async def aclose(self) -> None:
        """Drain this loop's computations before closing persistence."""
        loop = asyncio.get_running_loop()
        with self._lock:
            tasks = [task for (owner, _key), task in self._inflight.items() if owner is loop]
        if tasks:
            await asyncio.gather(*(asyncio.shield(task) for task in tasks), return_exceptions=True)
        self.close()

    def close(self) -> None:
        """Sweep expired rows and close the persistent cache."""
        with self._lock:
            self._closed = True
            if self._connection is not None:
                connection = self._connection
                self._connection = None
                try:
                    connection.execute(
                        "DELETE FROM results WHERE expires_at <= ?", (self._now_ms(),)
                    )
                    connection.commit()
                finally:
                    connection.close()
