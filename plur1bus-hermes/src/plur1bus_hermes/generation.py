"""Fail-closed activation of one completed staged embedding generation."""

from __future__ import annotations

import copy
import hashlib
import json
import os
from .file_io import replace_file, sync_parent
import re
import stat
import tempfile
from pathlib import Path
from typing import Any, Mapping

from .namespaces import NamespaceRoute
from .runtime_lease import exclusive_generation_lease
from .validation import ValidationError, safe_agent_id
from .writer_lock import writer_lock

_PLAN_ID = re.compile(r"^[0-9a-f]{24}$")
_SECRET = ("key", "token", "secret", "password", "authorization", "credential")
_MAX_STATE_BYTES = 128 * 1024


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str).encode()).hexdigest()


def _root(data_dir: Path) -> Path:
    raw = Path(data_dir).expanduser().absolute()
    if raw.is_symlink():
        raise ValidationError("generation data root is unsafe")
    return raw.resolve()


def _reject_symlink_components(root: Path, path: Path, *, message: str) -> None:
    root, path = root.absolute(), path.absolute()
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise ValidationError(message) from error
    current = root
    if current.is_symlink():
        raise ValidationError(message)
    for part in relative.parts:
        current /= part
        if current.is_symlink():  # includes dangling links
            raise ValidationError(message)


def _generation_dir(data_dir: Path, agent_id: str) -> Path:
    root = _root(data_dir)
    directory = root / "state" / agent_id / "generations"
    _reject_symlink_components(root, directory, message="generation state path is unsafe")
    return directory


def _pointer(data_dir: Path, agent_id: str) -> Path:
    return _generation_dir(data_dir, agent_id) / "active.json"


def _journal_path(data_dir: Path, agent_id: str, plan_id: str) -> Path:
    if not _PLAN_ID.fullmatch(plan_id):
        raise ValidationError("generation plan id is invalid")
    return _generation_dir(data_dir, agent_id) / f"journal-{plan_id}.json"


def _canonical_source(data_dir: Path, agent_id: str) -> Path:
    root = _root(data_dir)
    source = root / "lancedb" / agent_id
    _reject_symlink_components(root, source, message="canonical generation source route is unsafe")
    if not source.is_dir() or source.resolve() != source:
        raise ValidationError("canonical generation source route is unavailable")
    return source


def _target_for(source: Path, agent_id: str, plan_id: str) -> Path:
    if not _PLAN_ID.fullmatch(plan_id):
        raise ValidationError("generation plan id is invalid")
    return source.parent / f".{agent_id}.reembed-staged-{plan_id}"


def _without_secrets(value: Any, key: str = "") -> Any:
    """Project secrets out; activation rejects any config that would change."""
    lowered = key.casefold()
    if lowered.endswith("env") and isinstance(value, str):
        return value
    if lowered == "headers" or any(marker in lowered for marker in _SECRET):
        return None
    if isinstance(value, Mapping):
        return {str(name): cleaned for name, child in value.items() if (cleaned := _without_secrets(child, str(name))) is not None}
    if isinstance(value, list):
        return [_without_secrets(item, key) for item in value]
    return value if isinstance(value, (str, int, float, bool)) or value is None else str(value)


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    if path.is_symlink() or path.parent.is_symlink():
        raise ValidationError("generation state path is unsafe")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = -1
            handle.write(json.dumps(value, sort_keys=True, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        if path.is_symlink():
            raise ValidationError("generation state path is unsafe")
        replace_file(temporary, path)
        temporary = ""
        os.chmod(path, 0o600)
        sync_parent(path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def _read_json_existing(path: Path, *, label: str) -> dict[str, Any] | None:
    """Only a genuinely absent state file is optional."""
    try:
        details = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise ValidationError(f"generation {label} is unavailable") from error
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode):
        raise ValidationError(f"generation {label} is unsafe")
    try:
        if path.stat().st_size > _MAX_STATE_BYTES:
            raise ValidationError(f"generation {label} is oversized")
        value = json.loads(path.read_text(encoding="utf-8"))
    except ValidationError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(f"generation {label} is invalid") from error
    if not isinstance(value, dict):
        raise ValidationError(f"generation {label} is invalid")
    return value


def _source_route(data_dir: Path, agent_id: str, route: str, depth: int = 0) -> Path:
    """Accept the original store or a certified earlier generation, never an arbitrary path."""
    source = _canonical_source(data_dir, agent_id)
    if route == str(source):
        return source
    match = re.fullmatch(r"\." + re.escape(agent_id) + r"\.reembed-staged-([0-9a-f]{24})", Path(route).name)
    if depth >= 64 or not match or Path(route) != source.parent / Path(route).name:
        raise ValidationError("generation source route is not certified")
    prior = _read_json_existing(_journal_path(data_dir, agent_id, match[1]), label="source journal")
    if prior is None or prior.get("state") != "verified":
        raise ValidationError("generation source journal is not verified")
    manifest = _manifest_valid(prior.get("manifest"), data_dir, agent_id, depth + 1)
    if manifest["targetRoute"] != route:
        raise ValidationError("generation source journal route mismatch")
    return Path(route)


def _manifest_valid(manifest: Any, data_dir: Path, agent_id: str, depth: int = 0) -> dict[str, Any]:
    if not isinstance(manifest, dict) or safe_agent_id(str(manifest.get("agentId") or "")) != agent_id:
        raise ValidationError("generation manifest is invalid")
    if manifest.get("version") != 1:
        raise ValidationError("generation manifest version is unsupported")
    unsigned = {key: value for key, value in manifest.items() if key != "digest"}
    if not isinstance(manifest.get("digest"), str) or manifest["digest"] != _digest(unsigned):
        raise ValidationError("generation manifest digest is invalid")
    plan_id, selected = str(manifest.get("planId") or ""), manifest.get("selectedEmbedding")
    if not _PLAN_ID.fullmatch(plan_id) or not isinstance(selected, dict):
        raise ValidationError("generation manifest is invalid")
    try:
        dimensions = int(selected.get("dimensions", 0))
    except (TypeError, ValueError) as error:
        raise ValidationError("generation manifest embedding is invalid") from error
    if dimensions <= 0 or not isinstance(selected.get("model"), str) or not selected["model"]:
        raise ValidationError("generation manifest embedding is invalid")
    if not isinstance(manifest.get("embeddingFingerprint"), str) or not manifest["embeddingFingerprint"]:
        raise ValidationError("generation manifest embedding is invalid")
    if manifest.get("selectedEmbeddingFingerprint") != _digest(selected) or _without_secrets(selected) != selected:
        raise ValidationError("generation manifest selected embedding is invalid")
    source = _source_route(data_dir, agent_id, str(manifest.get("sourceRoute") or ""), depth)
    target = _target_for(source, agent_id, plan_id)
    _reject_symlink_components(_root(data_dir), target, message="generation target route is unsafe")
    if str(manifest.get("sourceRoute") or "") != str(source) or str(manifest.get("targetRoute") or "") != str(target):
        raise ValidationError("generation manifest route does not match canonical generation")
    if not target.is_dir() or target.resolve() != target or not isinstance(manifest.get("sourcePin"), str) or not manifest["sourcePin"]:
        raise ValidationError("generation manifest route or source pin is invalid")
    return manifest


def _journal_valid(value: Any, data_dir: Path, agent_id: str, *, require_verified: bool) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("state") not in {"prepared", "pointer_swapped", "verified"}:
        raise ValidationError("generation journal is invalid")
    if require_verified and value["state"] != "verified":
        raise ValidationError("generation activation recovery is required")
    plan, manifest = value.get("plan"), value.get("manifest")
    if not isinstance(plan, dict) or not isinstance(manifest, dict):
        raise ValidationError("generation journal is invalid")
    checked = _manifest_valid(manifest, data_dir, agent_id)
    if str(plan.get("planId") or "") != checked["planId"] or str(plan.get("agentId") or "") != agent_id:
        raise ValidationError("generation journal does not match manifest")
    return value


def _read_pointer_raw(data_dir: Path, agent_id: str, *, require_verified: bool) -> dict[str, Any] | None:
    value = _read_json_existing(_pointer(data_dir, agent_id), label="pointer")
    if value is None:
        return None
    manifest = _manifest_valid(value, data_dir, agent_id)
    journal_value = _read_json_existing(_journal_path(data_dir, agent_id, str(manifest["planId"])), label="journal")
    if journal_value is None:
        raise ValidationError("generation pointer has no journal")
    journal = _journal_valid(journal_value, data_dir, agent_id, require_verified=require_verified)
    if journal["manifest"].get("digest") != manifest["digest"]:
        raise ValidationError("generation pointer does not match journal")
    return manifest


def read_generation(data_dir: Path, agent_id: str) -> dict[str, Any] | None:
    """Return a verified active manifest; existing invalid state never falls back."""
    return _read_pointer_raw(data_dir, safe_agent_id(agent_id), require_verified=True)


def effective_generation_config(data_dir: Path, agent_id: str, config: Mapping[str, Any]) -> dict[str, Any]:
    """Project selected embedding config only after verified activation."""
    result = copy.deepcopy(dict(config))
    manifest = read_generation(data_dir, agent_id)
    if manifest is not None:
        result["embedding"] = copy.deepcopy(manifest["selectedEmbedding"])
    return result


def resolve_generation_route(data_dir: Path, agent_id: str, canonical_route: NamespaceRoute) -> NamespaceRoute:
    """Switch only the exact canonical source route named by a verified pointer."""
    manifest = read_generation(data_dir, agent_id)
    if manifest is None:
        return canonical_route
    source = _canonical_source(data_dir, safe_agent_id(agent_id))
    try:
        route_path = canonical_route.path.expanduser().absolute().resolve()
    except OSError as error:
        raise ValidationError("canonical writer route is unavailable") from error
    if route_path != source:
        raise ValidationError("active generation does not match canonical writer route")
    return NamespaceRoute(canonical_route.name, Path(manifest["targetRoute"]), canonical_route.writable)


def _non_vector_identity(rows: list[dict[str, Any]]) -> list[str]:
    return sorted(_digest({key: value for key, value in row.items() if key != "vector"}) for row in rows)


def _validate_complete(plan: Mapping[str, Any], data_dir: Path, agent_id: str, target_config: Mapping[str, Any], connect: Any) -> tuple[Path, Path]:
    from .reembed_staged import _connect, validate_staged_reembed

    source = _source_route(data_dir, agent_id, str(plan.get("sourceRoute") or ""))
    if str(plan.get("sourceRoute") or "") != str(source):
        raise ValidationError("staged generation source route changed")
    target = _target_for(source, agent_id, str(plan.get("planId") or ""))
    if str(plan.get("targetRoute") or "") != str(target):
        raise ValidationError("staged generation target route changed")
    _reject_symlink_components(_root(data_dir), target, message="generation target route is unsafe")
    if not validate_staged_reembed(plan, data_dir, agent_id, target_config, connect=connect).get("validated"):
        raise ValidationError("staged generation is incomplete")
    source_rows = [dict(row) for row in _connect(source, connect).open_table("memories").to_arrow().to_pylist()]
    target_rows = [dict(row) for row in _connect(target, connect).open_table("memories").to_arrow().to_pylist()]
    if _non_vector_identity(source_rows) != _non_vector_identity(target_rows):
        raise ValidationError("staged generation changed non-vector memory identity")
    return source, target


def _manifest(plan: Mapping[str, Any], source: Path, target: Path, agent_id: str, target_config: Mapping[str, Any]) -> dict[str, Any]:
    embedding = target_config.get("embedding")
    if not isinstance(embedding, Mapping):
        raise ValidationError("target generation has no embedding configuration")
    selected = copy.deepcopy(dict(embedding))
    if _without_secrets(selected) != selected:
        raise ValidationError("generation activation requires credential environment references")
    target_embedding = plan.get("targetEmbedding")
    if not isinstance(target_embedding, Mapping):
        raise ValidationError("staged generation embedding fingerprint is invalid")
    try:
        dimensions = int(selected.get("dimensions", 0))
    except (TypeError, ValueError) as error:
        raise ValidationError("target generation embedding is invalid") from error
    if (not str(target_embedding.get("fingerprint") or "") or dimensions != int(target_embedding.get("dimensions", 0))
            or str(selected.get("model") or "") != str(target_embedding.get("model") or "")):
        raise ValidationError("staged generation embedding does not match plan")
    value = {"version": 1, "agentId": agent_id, "planId": str(plan["planId"]),
             "sourceRoute": str(source), "targetRoute": str(target), "sourcePin": str(plan["sourceFingerprint"]),
             "embeddingFingerprint": str(target_embedding["fingerprint"]), "selectedEmbedding": selected,
             "selectedEmbeddingFingerprint": _digest(selected)}
    return {**value, "digest": _digest(value)}


def _journal_record(state: str, plan: Mapping[str, Any], manifest: Mapping[str, Any], old_pointer=None) -> dict[str, Any]:
    return {"state": state, "plan": dict(plan), "manifest": dict(manifest), "oldPointer": old_pointer}


def _activation_preconditions(plan: Mapping[str, Any], data_dir: Path, agent_id: str, config: Mapping[str, Any], approved: str) -> None:
    if approved != str(plan.get("planId") or "") or not _PLAN_ID.fullmatch(approved):
        raise ValidationError("approved staged generation plan does not match")
    if config.get("namespaces") is not None:
        raise ValidationError("generation activation requires the single private writer route")
    source = _source_route(data_dir, agent_id, str(plan.get("sourceRoute") or ""))
    _manifest(plan, source, _target_for(source, agent_id, approved), agent_id, config)


def activate_staged_generation(plan: Mapping[str, Any], data_dir: Path, agent_id: str, target_config: Mapping[str, Any], *, approved_plan_id: str, connect: Any = None) -> dict[str, Any]:
    """Atomically activate one validated staged target; source stays untouched."""
    agent_id = safe_agent_id(agent_id)
    _activation_preconditions(plan, data_dir, agent_id, target_config, approved_plan_id)
    from .reembed_staged import _stage_lock
    with exclusive_generation_lease(Path(data_dir)):
        with writer_lock(Path(data_dir)):
            source = _source_route(data_dir, agent_id, str(plan.get("sourceRoute") or ""))
            with _stage_lock(source, agent_id, approved_plan_id):
                target = _target_for(source, agent_id, approved_plan_id)
                manifest = _manifest(plan, source, target, agent_id, target_config)
                prior = _read_pointer_raw(data_dir, agent_id, require_verified=False)
                if prior is not None:
                    # New captures after a successful activation are legitimate:
                    # immutable pointer+journal identity, not table equality, proves idempotence.
                    verified = read_generation(data_dir, agent_id)
                    if verified.get("digest") == manifest["digest"]:
                        return {"activated": True, "idempotent": True, "planId": approved_plan_id, "targetRoute": str(target)}
                    if verified["targetRoute"] != str(source):
                        raise ValidationError("a different generation is already active")
                # Revalidate exclusively under the stage lock immediately before publication.
                source, target = _validate_complete(plan, data_dir, agent_id, target_config, connect)
                journal = _journal_path(data_dir, agent_id, approved_plan_id)
                existing = _read_json_existing(journal, label="journal")
                if existing is not None:
                    checked = _journal_valid(existing, data_dir, agent_id, require_verified=False)
                    if checked["manifest"].get("digest") != manifest["digest"]:
                        raise ValidationError("generation recovery journal does not match plan")
                else:
                    _atomic_json(journal, _journal_record("prepared", plan, manifest, prior))
                pointer = _pointer(data_dir, agent_id)
                try:
                    _atomic_json(pointer, manifest)
                    _atomic_json(journal, _journal_record("pointer_swapped", plan, manifest, prior))
                    _validate_complete(plan, data_dir, agent_id, target_config, connect)
                except Exception:
                    current = _read_json_existing(pointer, label="pointer")
                    if current is not None and current.get("digest") == manifest["digest"]:
                        if prior is None:
                            pointer.unlink()
                        else:
                            _atomic_json(pointer, prior)
                    _atomic_json(journal, _journal_record("prepared", plan, manifest, prior))
                    raise
                _atomic_json(journal, _journal_record("verified", plan, manifest, prior))
                return {"activated": True, "idempotent": False, "planId": approved_plan_id, "targetRoute": str(target), "sourceRoute": str(source)}


def recover_generation(data_dir: Path, agent_id: str, target_config: Mapping[str, Any], *, approved_plan_id: str, connect: Any = None) -> dict[str, Any]:
    """Recover a prepared pointer only after plan and manifest validation."""
    agent_id = safe_agent_id(agent_id)
    if not _PLAN_ID.fullmatch(approved_plan_id) or target_config.get("namespaces") is not None:
        raise ValidationError("generation recovery request is invalid")
    journal_path = _journal_path(data_dir, agent_id, approved_plan_id)
    raw = _read_json_existing(journal_path, label="journal")
    if raw is None:
        raise ValidationError("generation journal is unavailable")
    journal = _journal_valid(raw, data_dir, agent_id, require_verified=False)
    plan = journal["plan"]
    if str(plan.get("planId") or "") != approved_plan_id:
        raise ValidationError("generation journal plan is invalid")
    source = _source_route(data_dir, agent_id, str(plan.get("sourceRoute") or ""))
    target = _target_for(source, agent_id, approved_plan_id)
    expected = _manifest(plan, source, target, agent_id, target_config)
    if journal["manifest"].get("digest") != expected["digest"]:
        raise ValidationError("generation journal does not match expected manifest")
    if journal["state"] == "verified":
        active = read_generation(data_dir, agent_id)
        if active is None or active.get("digest") != expected["digest"]:
            raise ValidationError("generation verified journal has no matching pointer")
        return {"activated": True, "idempotent": True, "planId": approved_plan_id, "targetRoute": str(target)}
    # Incomplete activations must still match their staged snapshot. Completed
    # generations may legitimately contain new captures and are not re-frozen.
    _validate_complete(plan, data_dir, agent_id, target_config, connect)
    pending_pointer = _read_pointer_raw(data_dir, agent_id, require_verified=False)
    if journal["state"] == "prepared" and pending_pointer is not None and pending_pointer["targetRoute"] == str(source):
        return activate_staged_generation(plan, data_dir, agent_id, target_config, approved_plan_id=approved_plan_id, connect=connect)
    if journal["state"] == "pointer_swapped" or pending_pointer is not None:
        with exclusive_generation_lease(Path(data_dir)):
            with writer_lock(Path(data_dir)):
                from .reembed_staged import _stage_lock
                with _stage_lock(source, agent_id, approved_plan_id):
                    current = _read_pointer_raw(data_dir, agent_id, require_verified=False)
                    if current is None or current.get("digest") != expected["digest"]:
                        raise ValidationError("generation recovery pointer does not match journal")
                    _validate_complete(plan, data_dir, agent_id, target_config, connect)
                    _atomic_json(journal_path, _journal_record("verified", plan, expected, journal.get("oldPointer")))
        return {"activated": True, "idempotent": False, "recovered": True, "planId": approved_plan_id, "targetRoute": str(target)}
    return activate_staged_generation(plan, data_dir, agent_id, target_config, approved_plan_id=approved_plan_id, connect=connect)
