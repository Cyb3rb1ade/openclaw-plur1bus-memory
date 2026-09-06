"""Explicit, revision-bound consent records for bounded workspace imports.

This module is deliberately an operator API, not source discovery.  Callers
must supply one concrete directory; no profile, model, or browser input can
select a path.  Applying an approved consent delegates to the append-only
source-sync importer and never writes back into the source tree.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from .namespaces import NamespaceRoute, ScopeBinding, resolve_namespace_routes
from .source_sync import apply_source_sync, plan_source_sync
from .validation import ValidationError, resolve_inside, safe_agent_id
from .writer_lock import writer_lock


def _utcnow() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def _route_payload(route: NamespaceRoute | Any) -> dict[str, Any]:
    """Make the writable namespace route durable and comparison-safe."""
    payload = {
        "name": str(getattr(route, "name", "")),
        "path": str(Path(getattr(route, "path", "")).expanduser().resolve()),
        "writable": bool(getattr(route, "writable", False)),
    }
    # Namespace generations are optional on the current Hermes contract but
    # become part of consent automatically once route resolution exposes one.
    generation = getattr(route, "generation", None)
    if generation is not None:
        payload["generation"] = str(generation)
    return payload


def _canonical_runtime(runtime: Any) -> tuple[Path, str, ScopeBinding, NamespaceRoute]:
    """Return only the runtime's canonical, already-authorized destination."""
    agent_id = safe_agent_id(str(getattr(runtime, "agent_id", "")))
    binding = getattr(runtime, "scope_binding", None)
    if not isinstance(binding, ScopeBinding) or binding.agent_id != agent_id:
        raise ValidationError("workspace consent requires the runtime's canonical scope binding")
    data_dir = Path(getattr(runtime, "data_dir", "")).expanduser().resolve()
    if not data_dir.is_absolute() or data_dir == Path(data_dir.anchor):
        raise ValidationError("workspace consent requires a non-root runtime data directory")
    config = getattr(runtime, "config", {})
    if not isinstance(config, dict):
        raise ValidationError("workspace consent requires the runtime's concrete config")
    try:
        writer_route, _ = resolve_namespace_routes(data_dir, agent_id, config)
    except ValueError as error:
        raise ValidationError("workspace consent cannot resolve the writer namespace") from error
    actual_route = getattr(runtime, "_writer_route", None)
    if actual_route is not None and _route_payload(actual_route) != _route_payload(writer_route):
        raise ValidationError("runtime writer route differs from its canonical namespace route")
    return data_dir, agent_id, binding, writer_route


def _state_path(data_dir: Path, agent_id: str, binding: ScopeBinding, source: Path) -> Path:
    scope_key = hashlib.sha256(binding.scope_key.encode("utf-8")).hexdigest()
    source_key = hashlib.sha256(str(source).encode("utf-8")).hexdigest()
    unresolved = Path(data_dir) / "state" / agent_id / "workspace-consent" / scope_key / f"{source_key}.json"
    if unresolved.is_symlink():
        raise ValidationError("workspace consent record is a symlink; refusing overwrite")
    return resolve_inside(str(data_dir), "state", agent_id, "workspace-consent", scope_key, f"{source_key}.json")


def _explicit_source_path(source: Path) -> Path:
    """Validate a caller-supplied directory spelling without discovering files."""
    if not isinstance(source, Path):
        raise ValidationError("source must be an explicit pathlib.Path directory")
    raw = source.expanduser().absolute()
    if raw == Path(raw.anchor) or raw.is_symlink():
        raise ValidationError("source must be an explicit non-root non-symlink directory")
    # Reject user-controlled links before resolving them. macOS commonly spells
    # the same physical directory through the system-owned /var -> /private
    # alias, which is the sole permitted ancestor alias.
    for parent in raw.parents:
        if parent.is_symlink() and parent != Path("/var"):
            raise ValidationError("source ancestors must not be symlinks")
    # macOS commonly spells the same physical directory through /var and
    # /private.  Canonicalize only after rejecting a caller-supplied symlink.
    candidate = raw.resolve()
    if candidate == Path(candidate.anchor):
        raise ValidationError("source must be an explicit non-root non-symlink directory")
    return candidate


def _destination(data_dir: Path, agent_id: str, binding: ScopeBinding, writer_route: NamespaceRoute, source: Path) -> dict[str, Any]:
    return {
        "agentId": agent_id,
        "scopeKey": binding.scope_key,
        "scopeType": binding.scope_type,
        "aclBindings": binding.as_dict(),
        "dataRoute": str(data_dir),
        "writerRoute": _route_payload(writer_route),
        "consentStatePath": str(_state_path(data_dir, agent_id, binding, source)),
    }


def plan_workspace_consent(runtime: Any, source: Path) -> dict[str, Any]:
    """Build a read-only plan for one explicit source and canonical runtime."""
    source = _explicit_source_path(source)
    data_dir, agent_id, binding, writer_route = _canonical_runtime(runtime)
    try:
        manifest = plan_source_sync(source)
    except ValueError as error:
        raise ValidationError("workspace source cannot be planned") from error
    source_path = Path(manifest["source"])
    destination = _destination(data_dir, agent_id, binding, writer_route, source_path)
    immutable = {
        "schemaVersion": 1,
        "sourceManifest": manifest,
        "sourceRevision": manifest["revision"],
        "destination": destination,
    }
    return {
        **immutable,
        # This is the operator confirmation value.  It binds both the source
        # manifest and the destination; sourceRevision remains visible for UI.
        "revision": _digest(immutable),
        "dryRun": True,
    }


def _record_revision(record: Mapping[str, Any]) -> str:
    return _digest({key: value for key, value in record.items() if key != "recordRevision"})


def _read_record(path: Path) -> dict[str, Any] | None:
    if path.is_symlink():
        raise ValidationError("workspace consent record is a symlink; refusing overwrite")
    try:
        from .file_lock import open_existing
        fd = open_existing(path)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise ValidationError("workspace consent record is unreadable; refusing overwrite") from error
    try:
        with os.fdopen(fd, "rb") as handle:
            metadata = os.fstat(handle.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 64_000:
                raise ValidationError("workspace consent record is not a bounded regular file")
            data = handle.read(64_001)
            if len(data) != metadata.st_size:
                raise ValidationError("workspace consent record changed during read")
        raw = json.loads(data.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("workspace consent record is unreadable; refusing overwrite") from error
    if not isinstance(raw, dict) or raw.get("recordRevision") != _record_revision(raw):
        raise ValidationError("workspace consent record was manually changed; refusing overwrite")
    return raw


def _new_record(plan: Mapping[str, Any], approved_revision: str) -> dict[str, Any]:
    if approved_revision != plan.get("revision"):
        raise ValidationError("exact workspace consent revision approval is required")
    record = {
        "schemaVersion": 1,
        "sourceManifest": plan["sourceManifest"],
        "sourceRevision": plan["sourceRevision"],
        "destination": plan["destination"],
        "revision": plan["revision"],
        "status": "approved",
        "approvedAt": _utcnow(),
    }
    record["recordRevision"] = _record_revision(record)
    return record


def _write_new(path: Path, record: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or path.is_symlink():
        raise ValidationError("workspace consent state path is unsafe")
    fd, temporary = tempfile.mkstemp(prefix=".consent-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        try:
            os.link(temporary, path)
        except FileExistsError as error:
            raise ValidationError("workspace consent already exists; inspect or revoke it explicitly") from error
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _write_replace(path: Path, record: Mapping[str, Any]) -> None:
    """Replace only a record validated while holding the local writer lock."""
    if path.is_symlink():
        raise ValidationError("workspace consent state path is unsafe")
    fd, temporary = tempfile.mkstemp(prefix=".consent-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def approve_workspace_consent(runtime: Any, plan: Mapping[str, Any], *, approved_revision: str) -> dict[str, Any]:
    """Persist consent only for a freshly re-planned, exact operator revision."""
    if not isinstance(plan, Mapping):
        raise ValidationError("workspace consent plan must be an object")
    source_manifest = plan.get("sourceManifest")
    if not isinstance(source_manifest, Mapping) or not isinstance(source_manifest.get("source"), str):
        raise ValidationError("workspace consent plan has no explicit source")
    fresh = plan_workspace_consent(runtime, Path(source_manifest["source"]))
    if dict(plan) != fresh:
        raise ValidationError("workspace consent plan is stale, changed, or bound to another destination")
    data_dir, agent_id, binding, _writer_route = _canonical_runtime(runtime)
    path = _state_path(data_dir, agent_id, binding, Path(fresh["sourceManifest"]["source"]))
    record = _new_record(fresh, approved_revision)
    with writer_lock(data_dir):
        existing = _read_record(path)
        if existing is not None:
            if existing.get("status") == "approved" and existing.get("revision") == record["revision"]:
                return {"approved": True, "idempotent": True, "revision": record["revision"], "destination": record["destination"]}
            if existing.get("status") != "revoked":
                raise ValidationError("a different workspace consent exists; revoke it explicitly first")
            _write_replace(path, record)
        else:
            _write_new(path, record)
    return {"approved": True, "idempotent": False, "revision": record["revision"], "destination": record["destination"]}


def revoke_workspace_consent(runtime: Any, source: Path, *, approved_revision: str) -> dict[str, Any]:
    """Revoke one destination-bound consent without touching source or memories."""
    data_dir, agent_id, binding, _writer_route = _canonical_runtime(runtime)
    # Revocation intentionally does not re-read the source.  This lets an
    # operator revoke stale consent even if the directory was changed/deleted.
    path = _state_path(data_dir, agent_id, binding, _explicit_source_path(source))
    with writer_lock(data_dir):
        record = _read_record(path)
        if record is None or record.get("revision") != approved_revision:
            raise ValidationError("exact approved workspace consent revision is required to revoke")
        if record.get("status") == "revoked":
            return {"revoked": True, "idempotent": True, "revision": approved_revision}
        if record.get("status") != "approved":
            raise ValidationError("workspace consent state is invalid")
        revoked = dict(record)
        revoked.update({"status": "revoked", "revokedAt": _utcnow()})
        revoked["recordRevision"] = _record_revision(revoked)
        _write_replace(path, revoked)
    return {"revoked": True, "idempotent": False, "revision": approved_revision}


def apply_workspace_consent(runtime: Any, source: Path, *, approved_revision: str) -> dict[str, Any]:
    """Apply only a live, exact consent; source changes and revocation fail closed."""
    data_dir, agent_id, binding, _writer_route = _canonical_runtime(runtime)
    fresh = plan_workspace_consent(runtime, source)
    path = _state_path(data_dir, agent_id, binding, Path(fresh["sourceManifest"]["source"]))
    with writer_lock(data_dir):
        record = _read_record(path)
        if record is None or record.get("status") != "approved":
            raise ValidationError("workspace source has no active operator consent")
        if approved_revision != record.get("revision") or record.get("revision") != fresh.get("revision"):
            raise ValidationError("workspace source or destination changed; a new exact consent is required")
        if record.get("destination") != fresh.get("destination"):
            raise ValidationError("workspace consent destination changed; refusing import")
        return apply_source_sync(runtime, fresh["sourceManifest"], approved_revision=fresh["sourceRevision"])
