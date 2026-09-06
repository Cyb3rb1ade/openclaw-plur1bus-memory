"""Staged, resumable re-embedding with no live-table or config mutation.

The functions here are deliberately separate from :mod:`reembed`: staging
creates a new target table and leaves the configured writer untouched.  An
operator must perform any later gateway-offline switch as a distinct audited
operation; this module therefore reports ``completion='staged'``, never
``active``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
from . import file_lock as fcntl
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from .namespaces import resolve_namespace_routes
from .runtime import EmbeddingBackend
from .validation import ValidationError, safe_agent_id

_PLAN_VERSION = 1
_CHECKPOINT = "reembed-staged-checkpoint.json"
_PLAN_ID_RE = re.compile(r"^[0-9a-f]{24}$")


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


def _embedding_fingerprint(config: Mapping[str, Any]) -> dict[str, Any]:
    embedding = config.get("embedding")
    if not isinstance(embedding, Mapping):
        raise ValidationError("configuration has no embedding section")
    try:
        dimensions = int(embedding.get("dimensions", 0))
    except (TypeError, ValueError) as error:
        raise ValidationError("embedding.dimensions must be positive") from error
    if dimensions <= 0:
        raise ValidationError("embedding.dimensions must be positive")
    if embedding.get("fallback") is not None or embedding.get("fallbackProvider") is not None:
        # A fallback can silently mix two vector spaces in one target.  Staging
        # has to stop on primary failure so the operator can make one explicit
        # target-vector-space decision.
        raise ValidationError("staged re-embedding does not permit embedding fallbacks")
    public = {
        "provider": str(embedding.get("provider") or "local-transformers"),
        "model": str(embedding.get("model") or ""),
        "dimensions": dimensions,
    }
    if not public["model"]:
        raise ValidationError("embedding.model is required")
    return {**public, "fingerprint": _digest(_semantic_embedding_config(embedding))}


def _semantic_embedding_config(value: Mapping[str, Any]) -> dict[str, Any]:
    """Hash all vector-space inputs; credentials/headers never leave as plaintext."""
    secret_markers = ("key", "token", "secret", "password", "authorization", "credential")

    def clean(item: Any, key: str = "") -> Any:
        lowered = key.casefold()
        if lowered == "headers" or any(marker in lowered for marker in secret_markers):
            return {"valueHash": _digest(item)}
        if isinstance(item, Mapping):
            return {str(name): clean(child, str(name)) for name, child in sorted(item.items(), key=lambda pair: str(pair[0]))}
        if isinstance(item, (list, tuple)):
            return [clean(child, key) for child in item]
        if isinstance(item, (str, int, float, bool)) or item is None:
            return item
        return str(item)

    return clean(value)


def _connect(path: Path, connect: Callable[[str], Any] | None) -> Any:
    if connect is None:
        try:
            import lancedb
        except ImportError as error:  # pragma: no cover - environment-dependent
            raise RuntimeError("re-embedding requires the lancedb Python dependency") from error
        connect = lancedb.connect
    return connect(str(path))


def _exact_source_route(data_dir: Path, agent_id: str, config: Mapping[str, Any]) -> Path:
    """Return only the canonical private writer route, never a caller path."""
    raw_data_dir = Path(data_dir).expanduser().absolute()
    if raw_data_dir.is_symlink():
        raise ValidationError("canonical private source route is unavailable")
    data_dir = raw_data_dir.resolve()
    # First-generation staging is deliberately bound to the canonical private
    # writer.  It must not consult normal generation-aware routing: during a
    # pointer_swapped crash that routing correctly fails closed until recovery.
    # Legacy namespace staging retains its existing resolver behaviour.
    if config.get("namespaces") is None:
        expected = data_dir / "lancedb" / agent_id
    else:
        route, _ = resolve_namespace_routes(data_dir, agent_id, dict(config))
        expected = route.path.expanduser()
    if not expected.is_absolute() or not expected.is_dir():
        raise ValidationError("canonical private source route is unavailable")
    current = expected
    while current != data_dir:
        if current.is_symlink() or current.parent == current:
            raise ValidationError("canonical private source route is invalid")
        current = current.parent
    resolved = expected.resolve()
    if resolved != expected or resolved.parent != expected.parent or resolved.name != agent_id:
        raise ValidationError("canonical private source route is invalid")
    return resolved


def _table_version(table: Any, rows: list[dict[str, Any]]) -> str:
    value = getattr(table, "version", None)
    try:
        value = value() if callable(value) else value
    except Exception:
        value = None
    # Some LanceDB versions do not expose a table version.  The deterministic
    # source manifest is still a pinned version and detects every row change.
    return str(value) if value is not None else f"manifest:{_digest(rows)}"


def _source_snapshot(source: Path, connect: Callable[[str], Any] | None) -> tuple[list[dict[str, Any]], str, str]:
    table = _connect(source, connect).open_table("memories")
    rows = [dict(row) for row in table.to_arrow().to_pylist()]
    return rows, _table_version(table, rows), _digest(rows)


def _schema_preserving_data(cards: list[dict[str, Any]], table: Any, dimensions: int) -> Any:
    """Keep non-vector Arrow fields (notably empty ACL structs) intact."""
    schema_getter = getattr(table, "schema", None)
    schema = schema_getter() if callable(schema_getter) else schema_getter
    if schema is None or not hasattr(schema, "get_field_index"):
        return cards
    try:
        import pyarrow as pa
        index = schema.get_field_index("vector")
        if index < 0:
            raise ValidationError("source table has no vector field")
        old = schema.field(index)
        target_schema = schema.set(index, pa.field("vector", pa.list_(pa.float32(), dimensions), nullable=old.nullable))
        return pa.Table.from_pylist(cards, schema=target_schema)
    except ValidationError:
        raise
    except Exception as error:
        raise ValidationError("unable to preserve staged target schema") from error


def _target_dir(source: Path, agent_id: str, plan_id: str) -> Path:
    if not _PLAN_ID_RE.fullmatch(plan_id):
        raise ValidationError("staged re-embedding plan id is invalid")
    return source.parent / f".{agent_id}.reembed-staged-{plan_id}"


@contextmanager
def _stage_lock(source: Path, agent_id: str, plan_id: str):
    """Serialize applies for one deterministic target without following links."""
    lock = source.parent / f".{agent_id}.reembed-staged-{plan_id}.lock"
    if lock.is_symlink():
        raise ValidationError("staged re-embedding lock is unsafe")
    fd = fcntl.open_lock(lock)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _checkpoint_path(target: Path) -> Path:
    return target / _CHECKPOINT


def _write_checkpoint(path: Path, value: Mapping[str, Any]) -> None:
    if path.is_symlink():
        raise ValidationError("staged re-embedding checkpoint is unsafe")
    temporary = path.with_suffix(".tmp")
    if temporary.is_symlink():
        raise ValidationError("staged re-embedding checkpoint is unsafe")
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def _read_checkpoint(path: Path) -> dict[str, Any]:
    if path.is_symlink():
        raise ValidationError("staged re-embedding checkpoint is unsafe")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError("staged re-embedding checkpoint is unavailable") from error
    if not isinstance(value, dict):
        raise ValidationError("staged re-embedding checkpoint is invalid")
    return value


def plan_staged_reembed(
    data_dir: Path, agent_id: str, config: Mapping[str, Any], *, connect: Callable[[str], Any] | None = None
) -> dict[str, Any]:
    """Create a read-only plan; this never loads an embedding backend or writes."""
    agent_id = safe_agent_id(agent_id)
    source = _exact_source_route(Path(data_dir).expanduser().absolute(), agent_id, config)
    if config.get("namespaces") is None:
        from .generation import read_generation
        active = read_generation(data_dir, agent_id)
        if active is not None:
            source = Path(active["targetRoute"])
    rows, source_version, source_fingerprint = _source_snapshot(source, connect)
    return _make_plan(source, agent_id, rows, source_version, source_fingerprint, config)


def _make_plan(source: Path, agent_id: str, rows: list[dict[str, Any]], source_version: str, source_fingerprint: str, config: Mapping[str, Any]) -> dict[str, Any]:
    """Build the sole accepted plan shape from verified current inputs."""
    if not rows:
        raise ValidationError("source table is empty; no re-embedding is required")
    target = _embedding_fingerprint(config)
    plan_id = _digest({"source": str(source), "sourceVersion": source_version, "sourceFingerprint": source_fingerprint, "target": target["fingerprint"]})[:24]
    return {
        "planVersion": _PLAN_VERSION,
        "planId": plan_id,
        "agentId": agent_id,
        "sourceRoute": str(source),
        "sourceVersion": source_version,
        "sourceFingerprint": source_fingerprint,
        "sourceCards": len(rows),
        "targetEmbedding": target,
        "targetRoute": str(_target_dir(source, agent_id, plan_id)),
        "completion": "planned",
        "active": False,
    }


def _validate_plan(plan: Mapping[str, Any], data_dir: Path, agent_id: str, config: Mapping[str, Any], connect: Callable[[str], Any] | None) -> tuple[Path, list[dict[str, Any]]]:
    if not isinstance(plan, Mapping) or int(plan.get("planVersion", 0)) != _PLAN_VERSION or str(plan.get("agentId") or "") != agent_id:
        raise ValidationError("staged re-embedding plan does not match this agent")
    source = _exact_source_route(data_dir, agent_id, config)
    if config.get("namespaces") is None:
        from .generation import _source_route, _read_pointer_raw
        source = _source_route(data_dir, agent_id, str(plan.get("sourceRoute") or ""))
        active = _read_pointer_raw(data_dir, agent_id, require_verified=False)
        if active is not None and active["targetRoute"] not in {str(source), str(plan.get("targetRoute"))}:
            raise ValidationError("staged re-embedding active source changed")
        if active is None and source.name != agent_id:
            raise ValidationError("staged re-embedding active source changed")
    if str(source) != str(plan.get("sourceRoute") or ""):
        raise ValidationError("staged re-embedding source route changed")
    rows, version, fingerprint = _source_snapshot(source, connect)
    if version != str(plan.get("sourceVersion") or "") or fingerprint != str(plan.get("sourceFingerprint") or ""):
        raise ValidationError("source table changed; create a new staged plan")
    expected = _make_plan(source, agent_id, rows, version, fingerprint, config)
    if dict(plan) != expected:
        raise ValidationError("staged re-embedding plan does not match verified source and target")
    return source, rows


def _finite_vector(vector: Any, dimensions: int) -> list[float]:
    if hasattr(vector, "tolist"):
        vector = vector.tolist()
    if not isinstance(vector, (list, tuple)) or len(vector) != dimensions:
        raise ValidationError("staged embedding dimensions mismatch")
    values = [float(value) for value in vector]
    if any(not math.isfinite(value) for value in values):
        raise ValidationError("staged embedding contains non-finite values")
    return values


def _target_row_count(target: Path, connect: Callable[[str], Any] | None) -> int:
    """Count staged rows through the table so checkpoint recovery cannot duplicate."""
    table = _connect(target, connect).open_table("memories")
    count = getattr(table, "count_rows", None)
    if callable(count):
        value = count()
        if isinstance(value, int) and value >= 0:
            return value
    return len(table.to_arrow().to_pylist())


def _apply_staged_reembed_unlocked(
    plan: Mapping[str, Any], data_dir: Path, agent_id: str, config: Mapping[str, Any], *, batch_size: int = 100,
    connect: Callable[[str], Any] | None = None, backend_factory: Callable[[dict[str, Any], Path], Any] = EmbeddingBackend,
) -> dict[str, Any]:
    """Write at most one resumable batch to the separate staged target table."""
    agent_id = safe_agent_id(agent_id)
    if batch_size < 1 or batch_size > 1000:
        raise ValidationError("batch_size must be between 1 and 1000")
    data_dir = Path(data_dir).expanduser().absolute()
    source, rows = _validate_plan(plan, data_dir, agent_id, config, connect)
    target = _target_dir(source, agent_id, str(plan["planId"]))
    checkpoint_file = _checkpoint_path(target)
    existing_table_rows: int | None = None
    if target.exists():
        if target.is_symlink() or not target.is_dir() or target.resolve().parent != source.parent:
            raise ValidationError("staged re-embedding target is unsafe")
        checkpoint = _read_checkpoint(checkpoint_file)
        if checkpoint.get("plan") != dict(plan):
            raise ValidationError("staged target belongs to a different plan")
        try:
            existing_table_rows = _target_row_count(target, connect)
        except Exception as error:
            if checkpoint.get("tableInitialized") is True:
                raise ValidationError("staged target table is unavailable") from error
            logging.getLogger(__name__).debug("staged target has not been initialized: %s", type(error).__name__)
            existing_table_rows = None
    else:
        target.mkdir(mode=0o700, parents=False)
        checkpoint = {"plan": dict(plan), "cursor": 0, "completed": False, "written": 0, "tableInitialized": False}
        _write_checkpoint(checkpoint_file, checkpoint)
    cursor = int(checkpoint.get("cursor", 0))
    if cursor < 0 or cursor > len(rows):
        raise ValidationError("staged re-embedding checkpoint cursor is invalid")
    if cursor == len(rows):
        return {"completion": "staged", "active": False, "targetRoute": str(target), "cursor": cursor, "cards": len(rows)}
    if cursor and existing_table_rows != cursor:
        raise ValidationError("staged target/checkpoint mismatch; refusing duplicate batch")
    if cursor == 0 and existing_table_rows not in {None, 0}:
        raise ValidationError("staged target/checkpoint mismatch; refusing duplicate batch")
    backend = backend_factory(dict(config["embedding"]), data_dir.parent)
    batch = rows[cursor:cursor + batch_size]
    cards: list[dict[str, Any]] = []
    dimensions = int(plan["targetEmbedding"]["dimensions"])
    try:
        for row in batch:
            content = str(row.get("content") or "").strip()
            if not content:
                raise ValidationError("memory has no content to re-embed")
            cards.append({**row, "vector": _finite_vector(backend.embed(content), dimensions)})
    finally:
        close = getattr(backend, "close", None)
        if callable(close):
            close()
    # Inference can take long enough for another process to alter the source.
    # Revalidate the exact pinned snapshot before the first target mutation.
    _validate_plan(plan, data_dir, agent_id, config, connect)
    database = _connect(target, connect)
    if cursor == 0 and existing_table_rows is None:
        source_table = _connect(source, connect).open_table("memories")
        database.create_table("memories", data=_schema_preserving_data(cards, source_table, dimensions))
    else:
        target_table = database.open_table("memories")
        target_table.add(_schema_preserving_data(cards, target_table, dimensions))
    checkpoint.update({"cursor": cursor + len(cards), "written": cursor + len(cards), "completed": cursor + len(cards) == len(rows), "tableInitialized": True})
    _write_checkpoint(checkpoint_file, checkpoint)
    return {"completion": "staged" if checkpoint["completed"] else "in_progress", "active": False, "targetRoute": str(target), "cursor": checkpoint["cursor"], "cards": len(rows), "batchWritten": len(cards)}


def apply_staged_reembed(
    plan: Mapping[str, Any], data_dir: Path, agent_id: str, config: Mapping[str, Any], *, batch_size: int = 100,
    connect: Callable[[str], Any] | None = None, backend_factory: Callable[[dict[str, Any], Path], Any] = EmbeddingBackend,
) -> dict[str, Any]:
    """Serialize one safe staged apply for the verified, deterministic plan."""
    safe_agent = safe_agent_id(agent_id)
    plan_id = str(plan.get("planId") or "") if isinstance(plan, Mapping) else ""
    if not _PLAN_ID_RE.fullmatch(plan_id):
        raise ValidationError("staged re-embedding plan id is invalid")
    source = _exact_source_route(Path(data_dir).expanduser().absolute(), safe_agent, config)
    with _stage_lock(source, safe_agent, plan_id):
        return _apply_staged_reembed_unlocked(
            plan, data_dir, safe_agent, config, batch_size=batch_size,
            connect=connect, backend_factory=backend_factory,
        )


def validate_staged_reembed(
    plan: Mapping[str, Any], data_dir: Path, agent_id: str, config: Mapping[str, Any], *,
    connect: Callable[[str], Any] | None = None,
) -> dict[str, Any]:
    """Validate a completed target table without switching it into production."""
    if not isinstance(plan, Mapping):
        raise ValidationError("staged re-embedding plan is invalid")
    agent_id = safe_agent_id(agent_id)
    if str(plan.get("agentId") or "") != agent_id:
        raise ValidationError("staged re-embedding plan does not match this agent")
    # Never call a target valid while its source pin cannot be verified live.
    source, _ = _validate_plan(plan, Path(data_dir).expanduser().absolute(), agent_id, config, connect)
    plan_id = str(plan.get("planId") or "")
    target = Path(str(plan.get("targetRoute") or "")).expanduser().absolute()
    if target != _target_dir(source, agent_id, plan_id) or target.is_symlink() or not target.is_dir():
        raise ValidationError("staged re-embedding target is unsafe")
    checkpoint = _read_checkpoint(_checkpoint_path(target))
    if checkpoint.get("plan") != dict(plan) or not checkpoint.get("completed"):
        raise ValidationError("staged re-embedding is incomplete or belongs to another plan")
    rows = [dict(row) for row in _connect(target, connect).open_table("memories").to_arrow().to_pylist()]
    dimensions = int((plan.get("targetEmbedding") or {}).get("dimensions", 0))
    if len(rows) != int(plan.get("sourceCards", -1)):
        raise ValidationError("staged target row count differs from pinned source")
    for row in rows:
        _finite_vector(row.get("vector"), dimensions)
    return {"completion": "staged", "active": False, "validated": True, "targetRoute": str(target), "cards": len(rows)}
