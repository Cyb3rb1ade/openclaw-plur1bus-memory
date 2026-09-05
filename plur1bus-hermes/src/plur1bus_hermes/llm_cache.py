"""Exact, agent-scoped cache for deterministic internal LLM transformations."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import sqlite3
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Awaitable, Callable


LLM_RESULT_CACHE_PURPOSES = frozenset({
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
        self._inflight: dict[str, asyncio.Task] = {}
        self._lock = threading.RLock()
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
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA busy_timeout=5000")
            self._connection.execute("PRAGMA auto_vacuum=INCREMENTAL")
            self._connection.execute(
                "CREATE TABLE IF NOT EXISTS results ("
                "cache_key TEXT PRIMARY KEY, response_text TEXT NOT NULL, "
                "usage_json TEXT NOT NULL, expires_at INTEGER NOT NULL)"
            )
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
            "temperature": float(request.get("temperature") or 0),
            "jsonMode": bool(request.get("jsonMode")),
            "disableThinking": bool(request.get("disableThinking")),
            "headersHash": _hash(_canonical(request.get("headers") or {})),
        }
        return _hash(_canonical(material))

    def get(self, request: dict[str, Any]) -> dict[str, Any] | None:
        """Read a valid result from memory or SQLite."""
        cache_key = self.make_key(request)
        if cache_key is None or not self.max_entries:
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
        if cache_key is None or not self.max_entries or not response_text.strip():
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
                if self.db_path and self.max_bytes and self.db_path.stat().st_size >= self.max_bytes:
                    self.metrics["persistSkips"] += 1
                    return True
                self._connection.execute(
                    "INSERT INTO results(cache_key,response_text,usage_json,expires_at) "
                    "VALUES(?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET "
                    "response_text=excluded.response_text, "
                    "usage_json=excluded.usage_json, expires_at=excluded.expires_at",
                    (cache_key, response_text, _canonical(usage or {}), expires_at),
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
        cached = self.get(request)
        if cached is not None:
            return cached
        cache_key = self.make_key(request)
        if cache_key is None:
            value = compute()
            text, usage = await value if inspect.isawaitable(value) else value
            return {"text": text, "usage": usage or {}, "cached": False}
        with self._lock:
            task = self._inflight.get(cache_key)
            if task is None:
                task = asyncio.create_task(self._compute_and_store(request, compute))
                self._inflight[cache_key] = task
            else:
                self.metrics["coalesced"] += 1
        try:
            return await task
        finally:
            with self._lock:
                if self._inflight.get(cache_key) is task:
                    self._inflight.pop(cache_key, None)

    async def _compute_and_store(
        self,
        request: dict[str, Any],
        compute: Callable[[], Any],
    ) -> dict[str, Any]:
        value = compute()
        text, usage = await value if inspect.isawaitable(value) else value
        self.put(request, text, usage)
        return {"text": text, "usage": usage or {}, "cached": False}

    def close(self) -> None:
        """Sweep expired rows and close the persistent cache."""
        with self._lock:
            if self._connection is not None:
                self._connection.execute(
                    "DELETE FROM results WHERE expires_at <= ?", (self._now_ms(),)
                )
                self._connection.commit()
                self._connection.close()
                self._connection = None
