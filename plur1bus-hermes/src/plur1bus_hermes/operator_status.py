"""Narrow, secret-free operator inspection for one already-authorized runtime.

The functions here deliberately accept a live :class:`Plur1busRuntime` rather
than an agent id or a path.  This makes it impossible for a control caller to
turn a status request into a probe of another agent partition.
"""

from __future__ import annotations

import re
import threading
from collections.abc import Callable, Mapping
import os
from pathlib import Path
from typing import Any

from .namespaces import resolve_namespace_routes, scope_where_clause
from .validation import safe_agent_id, safe_status


_PUBLIC_VALUE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")
_OPTIMIZE_LOCK = threading.Lock()


def _public_value(value: Any) -> str | None:
    """Return a display-safe configured identifier, never a URI or secret."""
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate if _PUBLIC_VALUE.fullmatch(candidate) else None


def _credential_state(config: Mapping[str, Any], provider: str | None, *, reranker: bool) -> str:
    """Report credential configuration without exporting a key or env name."""
    if provider == "disabled":
        return "disabled"
    if provider in {"local-transformers", "local-onnx"}:
        return "not_required"
    explicit_env = str(config.get("apiKeyEnv") or "").strip()
    if provider == "omlx" or (reranker and provider == "openai-compatible"):
        env_name = explicit_env or "OMLX_API_KEY"
        if os.environ.get(env_name):
            return "environment_configured"
        if str(config.get("apiKey") or "").strip():
            return "inline_configured"
        if str(config.get("baseUrl") or "").startswith("http://127.0.0.1:"):
            return "local_default"
        return "environment_missing"
    if reranker and provider == "cohere":
        env_name = explicit_env or "PLUR1BUS_RERANKER_API_KEY"
        return "environment_configured" if os.environ.get(env_name) else "environment_missing"
    if str(config.get("apiKey") or "").strip():
        return "inline_configured"
    if explicit_env:
        return "environment_configured" if os.environ.get(explicit_env) else "environment_missing"
    defaults = (
        ("PLUR1BUS_RERANKER_API_KEY",)
        if reranker
        else ("PLUR1BUS_EMBEDDING_API_KEY", "OPENAI_API_KEY")
    )
    return "default_environment_configured" if any(os.environ.get(name) for name in defaults) else "environment_missing"


def _embedding_projection(config: Any) -> dict[str, Any]:
    embedding = config.get("embedding") if isinstance(config, Mapping) else None
    embedding = embedding if isinstance(embedding, Mapping) else {}
    provider = _public_value(embedding.get("provider", "local-transformers"))
    model = _public_value(
        embedding.get(
            "model",
            "intfloat/multilingual-e5-base" if provider == "local-transformers" else None,
        )
    )
    dimensions = embedding.get("dimensions")
    return {
        "provider": provider,
        "model": model,
        "dimensions": dimensions if isinstance(dimensions, int) and dimensions > 0 else None,
        "configured": provider is not None and model is not None,
        "credentials": _credential_state(embedding, provider, reranker=False),
    }


def _reranker_projection(config: Any) -> dict[str, Any]:
    reranker = config.get("reranker") if isinstance(config, Mapping) else None
    reranker = reranker if isinstance(reranker, Mapping) else {}
    provider = _public_value(reranker.get("provider", "disabled"))
    model = _public_value(
        reranker.get("model", "BAAI/bge-reranker-v2-m3" if provider == "local-transformers" else None)
    )
    return {
        "provider": provider,
        "model": model,
        "configured": provider == "disabled" or (provider is not None and model is not None),
        "credentials": _credential_state(reranker, provider, reranker=True),
    }


def _reject_symlink_components(root: Path, target: Path) -> None:
    """Refuse a route when any component below the data root is a symlink."""
    try:
        relative = target.relative_to(root)
    except ValueError as error:
        raise ValueError("runtime table route escapes data root") from error
    current = root
    if current.is_symlink():
        raise ValueError("runtime data root is a symbolic link")
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("runtime table route contains a symbolic link")


def _exact_route(runtime: Any) -> Path:
    """Validate that runtime's writer route is its canonical private route."""
    agent_id = safe_agent_id(getattr(runtime, "agent_id"))
    raw_data_dir = Path(getattr(runtime, "data_dir")).expanduser()
    if not raw_data_dir.is_absolute() or raw_data_dir.is_symlink() or not raw_data_dir.is_dir():
        raise ValueError("runtime data directory is unavailable")
    data_dir = raw_data_dir.resolve()
    config = getattr(runtime, "config")
    if not isinstance(config, Mapping):
        raise ValueError("runtime configuration is unavailable")
    expected, _ = resolve_namespace_routes(data_dir, agent_id, dict(config))
    relative_route = expected.path.relative_to(data_dir)
    lexical_expected = raw_data_dir.joinpath(relative_route)
    actual = getattr(runtime, "_writer_route", None)
    actual_path = Path(getattr(actual, "path", "")).expanduser()
    # Resolve only after checking the lexical expected route.  A symlinked
    # database must never be followed by the dashboard or compaction action.
    if (
        actual_path != lexical_expected
        or getattr(actual, "name", None) != expected.name
    ):
        raise ValueError("runtime writer route does not match its authorization")
    if actual_path.is_symlink() or not actual_path.is_dir():
        raise ValueError("runtime table directory is unavailable")
    _reject_symlink_components(raw_data_dir, actual_path)
    resolved = actual_path.resolve()
    # The namespace resolver validates any active generation pointer. Its
    # certified target can have a staging-generation basename, not agent_id.
    if resolved != expected.path.resolve():
        raise ValueError("runtime writer route escapes its data root")
    return resolved


def _connect(path: Path, connect: Callable[[str], Any] | None) -> Any:
    if connect is None:
        try:
            import lancedb
        except ImportError as error:  # pragma: no cover - installation issue
            raise RuntimeError("PLUR1BUS requires lancedb") from error
        connect = lancedb.connect
    # We only connect to an existing, validated directory.  `open_table` is
    # used below instead of create_table, so status cannot create a table.
    return connect(str(path))


def _open_exact_table(runtime: Any, connect: Callable[[str], Any] | None) -> Any:
    return _connect(_exact_route(runtime), connect).open_table("memories")


def read_operator_status(
    runtime: Any, *, connect: Callable[[str], Any] | None = None
) -> dict[str, Any]:
    """Return aggregate state for runtime's writer table without exposing paths."""
    agent_id = safe_agent_id(getattr(runtime, "agent_id"))
    projection = {
        "schemaVersion": 1,
        "agentId": agent_id,
        "scopeType": str(
            getattr(getattr(runtime, "scope_binding", None), "scope_type", "agent-private")
        ),
        "embedding": _embedding_projection(getattr(runtime, "config", {})),
        "reranker": _reranker_projection(getattr(runtime, "config", {})),
        "storage": {"status": "unavailable", "cards": None},
        "configured": False,
    }
    try:
        table = _open_exact_table(runtime, connect)
        binding = getattr(runtime, "scope_binding", None)
        if binding is None:
            raise ValueError("runtime scope binding is unavailable")
        cards = table.count_rows(scope_where_clause(binding))
        if not isinstance(cards, int) or cards < 0:
            raise ValueError("invalid table row count")
        projection["storage"] = {"status": "ready", "cards": cards}
        projection["configured"] = bool(projection["embedding"]["configured"])
    except Exception:
        # Error text can contain endpoint, path, or credential material.  The
        # fixed code is intentionally the only diagnostic exported here.
        projection["storage"] = {
            "status": "degraded",
            "cards": None,
            "code": "table_unavailable",
        }
    return projection


def browse_runtime_memories(runtime: Any, *, query: str = "", status: str = "active",
                            offset: int = 0, limit: int = 20,
                            connect: Callable[[str], Any] | None = None) -> dict[str, Any]:
    """Read a bounded page from the exact authorized scope, without embeddings or writes.

    This is literal substring inspection, not recall: archived/expired records may
    be inspected explicitly, and neither vectors nor internal provenance is exported.
    """
    if not isinstance(query, str) or len(query) > 200 or any(ord(c) < 32 for c in query):
        raise ValueError("invalid search query")
    safe_status(status)
    if type(offset) is not int or not 0 <= offset <= 100000 or type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError("invalid page bounds")
    table = _open_exact_table(runtime, connect)
    binding = getattr(runtime, "scope_binding", None)
    if binding is None:
        raise ValueError("runtime scope binding is unavailable")
    predicate = f"({scope_where_clause(binding)}) AND status = '{status}'"
    if query:
        literal = query.lower().replace("'", "''")
        predicate += f" AND strpos(lower(content), '{literal}') > 0"
    # Schema intersection supports old stores without migrating them during a GET.
    allowed = {"id", "content", "status", "type", "createdAt", "updatedAt", "expiresAt",
               "validFrom", "validUntil", "epistemicStatus", "sourceRole", "importance"}
    columns = sorted(allowed.intersection(table.schema.names))
    rows = table.search().where(predicate).select(columns).offset(offset).limit(limit + 1).to_list()
    items = [{key: row[key] for key in columns if key in row} for row in rows[:limit]]
    for item in items:
        content = item.get("content")
        if isinstance(content, str) and len(content) > 32768:
            item["content"] = content[:32768]
            item["contentTruncated"] = True
    return {"items": items,
            "offset": offset, "limit": limit, "hasMore": len(rows) > limit,
            "searchMode": "literal-substring", "status": status}


def optimize_runtime_table(
    runtime: Any,
    *,
    authorized: bool,
    connect: Callable[[str], Any] | None = None,
) -> dict[str, Any]:
    """Compact exactly runtime's existing table after caller-side authorization.

    This invokes only LanceDB's physical ``optimize`` primitive.  It never
    deletes rows, applies a retention policy, or creates a missing table.
    """
    if authorized is not True:
        return {"ok": False, "code": "unauthorized"}
    if not _OPTIMIZE_LOCK.acquire(blocking=False):
        return {"ok": False, "code": "busy"}
    try:
        table = _open_exact_table(runtime, connect)
        optimize = getattr(table, "optimize", None)
        if not callable(optimize):
            return {"ok": False, "code": "optimize_unavailable"}
        stats = optimize()
        return {"ok": True, "code": "optimized", "stats": _safe_stats(stats)}
    except Exception:
        return {"ok": False, "code": "optimize_failed"}
    finally:
        _OPTIMIZE_LOCK.release()


def _safe_stats(value: Any) -> dict[str, int]:
    """Project only bounded integer optimization counters from a result."""
    if not isinstance(value, Mapping):
        return {}
    projected: dict[str, int] = {}
    for source, public in (
        ("fragments_removed", "fragmentsRemoved"),
        ("fragments_added", "fragmentsAdded"),
    ):
        count = value.get(source)
        if isinstance(count, int) and count >= 0:
            projected[public] = count
    return projected
