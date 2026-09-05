"""Bounded persistent caches for PLUR1BUS embedding and deterministic results."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any


class EmbeddingCache:
    """Thread-safe LRU+TTL cache with an optional SQLite persistence layer."""

    def __init__(self, config: dict[str, Any], root: Path) -> None:
        self.config = config
        self.max_entries = max(0, min(100_000, int(config.get("cacheMaxEntries", 4096))))
        self.ttl_seconds = max(60, int(config.get("cacheTtlSeconds", 7 * 86_400)))
        self.persist = bool(config.get("cachePersist", True))
        self._memory: OrderedDict[str, tuple[float, list[float]]] = OrderedDict()
        self._lock = threading.RLock()
        self._database: sqlite3.Connection | None = None
        if self.persist:
            cache_dir = Path(str(config.get("cacheDir") or root / "cache"))
            cache_dir.mkdir(parents=True, exist_ok=True)
            self._database = sqlite3.connect(str(cache_dir / "embedding-cache-v2.sqlite"), check_same_thread=False)
            self._database.execute("PRAGMA journal_mode=WAL")
            self._database.execute("PRAGMA busy_timeout=5000")
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
            "textHash": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()

    def get(self, text: str, purpose: str = "passage") -> list[float] | None:
        key = self.key(text, purpose)
        now = time.time()
        with self._lock:
            cached = self._memory.get(key)
            if cached and cached[0] > now:
                self._memory.move_to_end(key)
                return list(cached[1])
            self._memory.pop(key, None)
            if self._database is None:
                return None
            row = self._database.execute(
                "SELECT vector, expires FROM embeddings WHERE key = ? AND expires > ?",
                (key, now),
            ).fetchone()
            if not row:
                return None
            vector = [float(value) for value in json.loads(row[0])]
            self._database.execute("UPDATE embeddings SET accessed = ? WHERE key = ?", (now, key))
            self._database.commit()
            self._remember(key, vector, float(row[1]))
            return vector

    def set(self, text: str, vector: list[float], purpose: str = "passage") -> None:
        expected = int(self.config.get("dimensions", len(vector)))
        if len(vector) != expected:
            return
        key = self.key(text, purpose)
        now = time.time()
        expires = now + self.ttl_seconds
        with self._lock:
            self._remember(key, vector, expires)
            if self._database is not None:
                self._database.execute(
                    "INSERT INTO embeddings(key, vector, expires, accessed) VALUES(?, ?, ?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET vector=excluded.vector, expires=excluded.expires, accessed=excluded.accessed",
                    (key, json.dumps(vector, separators=(",", ":")), expires, now),
                )
                self._database.commit()
                self._trim_database()

    def close(self) -> None:
        with self._lock:
            if self._database is not None:
                self._database.close()
                self._database = None

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
