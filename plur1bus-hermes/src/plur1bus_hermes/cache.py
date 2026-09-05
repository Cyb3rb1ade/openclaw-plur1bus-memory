"""Bounded persistent caches for PLUR1BUS embedding and deterministic results."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import sqlite3
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from .validation import ValidationError


@dataclass
class _EmbeddingInFlight:
    """One owner computation and its result for identical cache requests."""

    event: threading.Event = field(default_factory=threading.Event)
    result: list[float] | None = None
    error: BaseException | None = None


class EmbeddingCache:
    """Thread-safe LRU+TTL cache with an optional SQLite persistence layer."""

    def __init__(self, config: dict[str, Any], root: Path) -> None:
        self.config = config
        self.max_entries = max(0, min(100_000, int(config.get("cacheMaxEntries", 4096))))
        self.ttl_seconds = max(60, int(config.get("cacheTtlSeconds", 7 * 86_400)))
        self.persist = bool(config.get("cachePersist", False))
        self.max_bytes = max(0, min(1_073_741_824, int(config.get("cacheMaxBytes", 67_108_864))))
        self.metrics = {"hits": 0, "misses": 0, "persistHits": 0, "persistWrites": 0, "persistSkips": 0, "coalesced": 0}
        self._memory: OrderedDict[str, tuple[float, list[float]]] = OrderedDict()
        self._lock = threading.RLock()
        self._inflight: dict[str, _EmbeddingInFlight] = {}
        self._database: sqlite3.Connection | None = None
        self._db_path: Path | None = None
        if self.persist and self.max_entries:
            cache_dir = Path(str(config.get("cacheDir") or root / "cache"))
            cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            self._db_path = cache_dir / "embedding-cache-v2.sqlite"
            self._database = sqlite3.connect(str(self._db_path), check_same_thread=False)
            os.chmod(self._db_path, 0o600)
            self._database.execute("PRAGMA journal_mode=WAL")
            self._database.execute("PRAGMA busy_timeout=5000")
            self._database.execute("PRAGMA auto_vacuum=INCREMENTAL")
            self._database.execute(
                "CREATE TABLE IF NOT EXISTS embeddings "
                "(key TEXT PRIMARY KEY, vector TEXT NOT NULL, expires REAL NOT NULL, accessed REAL NOT NULL)"
            )
            self._database.execute("DELETE FROM embeddings WHERE expires <= ?", (time.time(),))
            self._database.commit()

    def key(self, text: str, purpose: str = "passage") -> str:
        normalized = " ".join(text.strip().split())
        payload = {
            "provider": self.config.get("provider"),
            "model": self.config.get("model"),
            "dimensions": int(self.config.get("dimensions", 0)),
            "scopeId": self.config.get("_scopeId", "shared"),
            "cacheVersion": self.config.get("cacheVersion", "2"),
            # Asymmetric models embed the same string differently as a question
            # than as a stored passage, so the two must not share an entry.
            "purpose": purpose,
            "routingHash": hashlib.sha256(json.dumps({
                key: value for key, value in self.config.items()
                if not key.startswith("cache") and key not in {"_scopeId", "dimensions", "model", "provider"}
            }, sort_keys=True, default=str).encode("utf-8")).hexdigest(),
            "textHash": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()

    def get(self, text: str, purpose: str = "passage") -> list[float] | None:
        """Return cached data or safely fall back to a live embedding."""
        try:
            return self._get(text, purpose)
        except Exception as error:
            logging.getLogger(__name__).warning("Embedding cache read bypassed: %s", type(error).__name__)
            return None

    def _get(self, text: str, purpose: str) -> list[float] | None:
        key = self.key(text, purpose)
        return self._get_by_key(key)

    def _get_by_key(self, key: str) -> list[float] | None:
        now = time.time()
        with self._lock:
            cached = self._memory.get(key)
            if cached and cached[0] > now:
                self._memory.move_to_end(key)
                self.metrics["hits"] += 1
                return list(cached[1])
            self._memory.pop(key, None)
            if self._database is None:
                self.metrics["misses"] += 1
                return None
            row = self._database.execute(
                "SELECT vector, expires FROM embeddings WHERE key = ? AND expires > ?",
                (key, now),
            ).fetchone()
            if not row:
                self.metrics["misses"] += 1
                return None
            vector = [float(value) for value in json.loads(row[0])]
            self._database.execute("UPDATE embeddings SET accessed = ? WHERE key = ?", (now, key))
            self._database.commit()
            self._remember(key, vector, float(row[1]))
            self.metrics["hits"] += 1
            self.metrics["persistHits"] += 1
            return vector

    def set(self, text: str, vector: list[float], purpose: str = "passage") -> None:
        """Cache valid vectors without making cache failures fatal to callers."""
        try:
            self._set(text, vector, purpose)
        except Exception as error:
            logging.getLogger(__name__).warning("Embedding cache write bypassed: %s", type(error).__name__)

    def get_or_compute(
        self,
        text: str,
        compute: Callable[[], list[float]],
        purpose: str = "passage",
    ) -> list[float]:
        """Return an embedding while coalescing one identical live computation.

        Cache read/write failures are bypassed. A backend failure or malformed
        vector remains visible to every waiting caller so normal fallback logic
        still decides what to do next.
        """
        cached = self.get(text, purpose)
        if cached is not None:
            return list(cached)
        try:
            cache_key = self.key(text, purpose)
        except Exception as error:
            logging.getLogger(__name__).warning("Embedding cache key bypassed: %s", type(error).__name__)
            return self._compute_valid(compute)
        with self._lock:
            # A value may have appeared between the first cache read and this
            # request joining the live-operation map.
            try:
                cached = self._get_by_key(cache_key)
            except Exception as error:
                logging.getLogger(__name__).warning("Embedding cache read bypassed: %s", type(error).__name__)
                cached = None
            if cached is not None:
                return list(cached)
            operation = self._inflight.get(cache_key)
            if operation is None:
                operation = _EmbeddingInFlight()
                self._inflight[cache_key] = operation
                owner = True
            else:
                self.metrics["coalesced"] += 1
                owner = False
        if not owner:
            operation.event.wait()
            if operation.error is not None:
                raise operation.error
            if operation.result is None:
                raise RuntimeError("embedding computation ended without a result")
            return list(operation.result)
        try:
            result = self._compute_valid(compute)
            # set() is fail-open: disk/cache failures cannot alter a good
            # backend result or strand waiters.
            self.set(text, result, purpose)
            operation.result = list(result)
            return list(result)
        except BaseException as error:
            operation.error = error
            raise
        finally:
            with self._lock:
                if self._inflight.get(cache_key) is operation:
                    self._inflight.pop(cache_key, None)
                operation.event.set()

    def _compute_valid(self, compute: Callable[[], list[float]]) -> list[float]:
        """Copy and validate a backend result before it can become shareable."""
        value = compute()
        if not isinstance(value, (list, tuple)):
            raise ValidationError("embedding computation did not return a vector")
        vector = [float(item) for item in value]
        expected = int(self.config.get("dimensions", len(vector)))
        if not vector or len(vector) != expected or any(not math.isfinite(item) for item in vector):
            raise ValidationError("embedding computation returned an invalid vector")
        return vector

    def _set(self, text: str, vector: list[float], purpose: str) -> None:
        expected = int(self.config.get("dimensions", len(vector)))
        if not self.max_entries or len(vector) != expected or not vector or any(not math.isfinite(float(value)) for value in vector):
            return
        key = self.key(text, purpose)
        now = time.time()
        expires = now + self.ttl_seconds
        with self._lock:
            self._remember(key, vector, expires)
            if self._database is not None:
                required_bytes = len(json.dumps(vector).encode("utf-8")) * 2 + 32_768
                if self._disk_bytes() + required_bytes >= self.max_bytes:
                    self.metrics["persistSkips"] += 1
                    return
                self._database.execute(
                    "INSERT INTO embeddings(key, vector, expires, accessed) VALUES(?, ?, ?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET vector=excluded.vector, expires=excluded.expires, accessed=excluded.accessed",
                    (key, json.dumps(vector, separators=(",", ":")), expires, now),
                )
                self._database.commit()
                self._trim_database()
                self.metrics["persistWrites"] += 1

    def _disk_bytes(self) -> int:
        """Count the SQLite database and WAL toward the persistent budget."""
        if self._db_path is None:
            return 0
        return sum(path.stat().st_size for path in (
            self._db_path, Path(str(self._db_path) + "-wal"),
        ) if path.exists())

    def close(self) -> None:
        with self._lock:
            if self._database is not None:
                database = self._database
                self._database = None
                try:
                    database.close()
                except Exception as error:
                    logging.getLogger(__name__).warning("Embedding cache close failed: %s", type(error).__name__)

    def _remember(self, key: str, vector: list[float], expires: float) -> None:
        if self.max_entries == 0:
            return
        self._memory[key] = (expires, list(vector))
        self._memory.move_to_end(key)
        while len(self._memory) > self.max_entries:
            self._memory.popitem(last=False)

    def _trim_database(self) -> None:
        if self._database is None or self.max_entries == 0:
            return
        count = int(self._database.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0])
        overflow = count - self.max_entries
        if overflow > 0:
            self._database.execute(
                "DELETE FROM embeddings WHERE key IN "
                "(SELECT key FROM embeddings ORDER BY accessed ASC LIMIT ?)",
                (overflow,),
            )
            self._database.commit()
