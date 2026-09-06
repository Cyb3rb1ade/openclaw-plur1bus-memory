"""Bounded best-effort SQLite cache pruning, never authoritative-data GC."""

from __future__ import annotations

import sqlite3
from pathlib import Path


_LAYOUTS = {
    "embeddings": ("key", "expires", "accessed"),
    "results": ("cache_key", "expires_at", "accessed_at"),
}


def disk_bytes(path: Path) -> int:
    """Count the database and WAL, including frames pinned by other readers."""
    return sum(item.stat().st_size for item in (path, Path(str(path) + "-wal")) if item.exists())


def reclaim(connection: sqlite3.Connection) -> None:
    """Try bounded vacuum/checkpoint without waiting on another connection."""
    previous = int(connection.execute("PRAGMA busy_timeout").fetchone()[0])
    connection.execute("PRAGMA busy_timeout=0")
    try:
        connection.execute("PRAGMA incremental_vacuum(256)").fetchall()
        connection.commit()
        # A busy result is expected with live readers: admission below still
        # counts the retained WAL. Never delete SQLite/WAL files manually.
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
    finally:
        connection.execute(f"PRAGMA busy_timeout={previous}")


def admit(
    connection: sqlite3.Connection, path: Path, table: str, *, now: float,
    max_entries: int, max_bytes: int, required_bytes: int, protected_key: str,
) -> bool:
    """Prune expired/LRU cache entries toward 90%, then enforce admission.

    Call under the cache mutex before INSERT. Physical byte limits are a
    conservative admission budget, not an OS quota. Four bounded LRU passes
    avoid unbounded cleanup when another reader prevents WAL truncation.
    """
    key, expiry, accessed = _LAYOUTS[table]  # identifiers never come from config
    if max_entries <= 0 or required_bytes >= max_bytes:
        return False
    try:
        connection.execute(f"DELETE FROM {table} WHERE {expiry} <= ?", (now,))
        exists = connection.execute(f"SELECT 1 FROM {table} WHERE {key}=?", (protected_key,)).fetchone()
        count = int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        overflow = max(0, count + (0 if exists else 1) - max_entries)
        if overflow:
            connection.execute(
                f"DELETE FROM {table} WHERE {key} IN (SELECT {key} FROM {table} "
                f"WHERE {key} != ? ORDER BY {accessed}, {key} LIMIT ?)", (protected_key, overflow),
            )
        connection.commit()
        soft_limit = int(max_bytes * 0.9)
        if disk_bytes(path) + required_bytes >= soft_limit:
            reclaim(connection)
            for _ in range(4):
                if disk_bytes(path) + required_bytes < soft_limit:
                    break
                removed = connection.execute(
                    f"DELETE FROM {table} WHERE {key} IN (SELECT {key} FROM {table} "
                    f"WHERE {key} != ? ORDER BY {accessed}, {key} LIMIT 64)", (protected_key,),
                ).rowcount
                connection.commit()
                reclaim(connection)
                if not removed:
                    break
        return disk_bytes(path) + required_bytes < max_bytes
    except Exception:
        connection.rollback()
        raise  # caller logs and falls back to the already computed live value
