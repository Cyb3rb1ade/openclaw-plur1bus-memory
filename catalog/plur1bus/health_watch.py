"""Bounded, process-local health counters for native Hermes LLM calls."""

from __future__ import annotations

import hashlib
import re
import threading
import time
from collections import deque
from typing import Any

DAY_SECONDS = 24 * 60 * 60
MAX_ENTRIES_PER_OWNER = 500
MAX_OWNERS = 128
_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
_LOCK = threading.Lock()
_REGISTRY: dict[str, deque[dict[str, Any]]] = {}


def owner_key(agent_id: Any, scope_key: Any = None) -> str:
    """Return a non-reversible process registry key for one active scope."""
    agent = agent_id if isinstance(agent_id, str) and _SAFE.fullmatch(agent_id) else "unknown"
    scope = scope_key if isinstance(scope_key, str) else ""
    return hashlib.sha256(f"{agent}\0{scope}".encode("utf-8", "replace")).hexdigest()


def _label(value: Any) -> str | None:
    return value if isinstance(value, str) and _SAFE.fullmatch(value) else None


def _hint(error: BaseException, fallback: Any) -> str:
    """Classify authority expiry without retaining or exporting exception text."""
    message = " ".join(value for value in BaseException.args.__get__(error) if type(value) is str)
    if re.search(r"caller authority is no longer active|not bound to an active session agent", message, re.I):
        return "authority-expired"
    return _label(fallback) or "unknown"


def record_failure(owner: str, *, agent_id: Any, feature: Any, hint: Any,
                   error_class: Any = None, error: BaseException | None = None,
                   at: float | None = None) -> None:
    """Record one allowlisted failure in the owner's bounded 24-hour window."""
    now = time.time() if at is None else at
    if type(now) not in (int, float):
        now = time.time()
    entry = {"at": float(now), "agentId": _label(agent_id),
             "feature": _label(feature) or "unknown",
             "hint": _hint(error, hint) if error is not None else (_label(hint) or "unknown"),
             "errorClass": _label(error_class)}
    with _LOCK:
        if owner not in _REGISTRY:
            if len(_REGISTRY) >= MAX_OWNERS:
                _REGISTRY.pop(next(iter(_REGISTRY)))
            _REGISTRY[owner] = deque()
        rows = _REGISTRY[owner]
        rows.append(entry)
        _prune(rows, float(now))
        while len(rows) > MAX_ENTRIES_PER_OWNER:
            rows.popleft()


def _prune(rows: deque[dict[str, Any]], now: float) -> None:
    cutoff = now - DAY_SECONDS
    while rows and rows[0]["at"] < cutoff:
        rows.popleft()


def snapshot(owner: str, *, now: float | None = None) -> list[dict[str, Any]]:
    """Return grouped safe counters for one owner only."""
    current = time.time() if now is None else now
    with _LOCK:
        rows = _REGISTRY.get(owner)
        if rows is None:
            return []
        _prune(rows, current)
        groups: dict[tuple[str, str | None, str], dict[str, Any]] = {}
        for row in rows:
            key = (row["feature"], row["agentId"], row["hint"])
            group = groups.setdefault(key, {"feature": key[0], "agentId": key[1], "hint": key[2],
                                            "errorClass": row["errorClass"], "count": 0, "lastAt": 0.0})
            group["count"] += 1
            if row["at"] >= group["lastAt"]:
                group["lastAt"] = row["at"]
                group["errorClass"] = row["errorClass"]
        return sorted(groups.values(), key=lambda item: (-item["count"], -item["lastAt"]))[:20]


def reset_for_tests() -> None:
    """Clear process counters for isolated unit tests."""
    with _LOCK:
        _REGISTRY.clear()
