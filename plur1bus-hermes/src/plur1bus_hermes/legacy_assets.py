"""Lossless legacy metadata and workspace asset conversion helpers."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from .identity_migrate import ensure_hermes_identity, sanitize_hermes_context_files

SAFE_STATUSES = {"active", "superseded", "archived", "deleted"}
ID_REFERENCE_KEYS = {
    "memoryId", "memoryIds", "sourceMemoryIds", "usedMemoryIds",
    "activatedMemoryIds", "strengthenedMemoryIds", "selectedIds",
    "targetId", "source", "target",
}
SECRET_NAMES = {".env", ".env.local", ".env.production", "credentials.json", "auth-profiles.json"}
SECRET_FRAGMENTS = ("api-key", "apikey", "coding-key", "secret", "password", "token")
SKIP_DIRECTORIES = {".git", ".secrets", "node_modules", "__pycache__", ".venv", "venv"}


def normalize_legacy_status(value: Any) -> str:
    """Map OpenClaw workflow states to a recall-safe Hermes card status."""
    status = str(value or "").strip().lower()
    return status if status in SAFE_STATUSES else "active"


def stage_card_metadata(
    agent_dir: Path,
    source_agent: str,
    target_agent: str,
    rows: list[dict[str, Any]],
    id_map: dict[str, str],
) -> int:
    """Preserve every non-vector legacy card field in a companion LanceDB table."""
    try:
        import lancedb
    except ImportError as error:
        raise RuntimeError("metadata migration requires lancedb") from error
    database = lancedb.connect(str(agent_dir))
    if "metadata" in database.table_names():
        return database.open_table("metadata").count_rows()
    records = []
    for row in rows:
        original_id = str(row.get("id") or "")
        metadata = {key: value for key, value in row.items() if key != "vector"}
        records.append({
            "id": id_map[original_id],
            "agentId": target_agent,
            "sourceAgent": source_agent,
            "originalId": original_id,
            "legacyStatus": str(row.get("status") or ""),
            "metadataJson": json.dumps(metadata, ensure_ascii=True, sort_keys=True, default=str),
        })
    if records:
        database.create_table("metadata", data=records)
    return len(records)


def stage_complete_assets(
    snapshot: Path,
    staging: Path,
    mapping: dict[str, str],
    id_maps: dict[str, dict[str, str]],
    workspace_map: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Convert selected Neo stores and safely copy agent workspaces and archives."""
    result = {
        "archivesCopied": 0,
        "criticalPushFilesCopied": 0,
        "neoFilesConverted": 0,
        "neoRecordsConverted": 0,
        "workspaceFilesCopied": 0,
        "workspaceFilesExcluded": 0,
        "profilesCreated": 0,
        "identityCompatibility": {},
    }
    _stage_archives(snapshot, staging, mapping, result)
    _stage_critical_push(snapshot, staging, result)
    _stage_neo(snapshot, staging, mapping, id_maps, result)
    _stage_workspaces(snapshot, staging, mapping, workspace_map or {}, result)
    return result


def _stage_archives(snapshot: Path, staging: Path, mapping: dict[str, str], result: dict[str, Any]) -> None:
    source_root = snapshot / "_archive"
    if not source_root.is_dir():
        source_root = snapshot / "archives"
    for source_agent, target_agent in mapping.items():
        source = source_root / source_agent
        if source.is_dir():
            shutil.copytree(source, staging / "archives" / target_agent, dirs_exist_ok=True)
            result["archivesCopied"] += sum(1 for path in source.rglob("*") if path.is_file())


def _stage_critical_push(snapshot: Path, staging: Path, result: dict[str, Any]) -> None:
    source = snapshot / "_critical-push-state"
    if source.is_dir():
        shutil.copytree(source, staging / "critical-push-state" / "legacy", dirs_exist_ok=True)
        result["criticalPushFilesCopied"] = sum(1 for path in source.rglob("*") if path.is_file())


def _stage_neo(
    snapshot: Path,
    staging: Path,
    mapping: dict[str, str],
    id_maps: dict[str, dict[str, str]],
    result: dict[str, Any],
) -> None:
    source_root = snapshot / "lancedb-namespaced" / "_neo" / "workspaces"
    if not source_root.is_dir():
        return
    for source_agent, target_agent in mapping.items():
        aliases = {source_agent, f"workspace-{source_agent}"}
        if source_agent == "main":
            aliases.add("workspace")
        merged: dict[str, dict[str, dict[str, Any]]] = {}
        for alias in sorted(aliases):
            source_dir = source_root / alias
            if not source_dir.is_dir():
                continue
            for source_file in sorted(path for path in source_dir.iterdir() if path.is_file()):
                destination = staging / "neo" / target_agent / "sources" / alias / source_file.name
                destination.parent.mkdir(parents=True, exist_ok=True)
                if source_file.suffix == ".jsonl":
                    records = _convert_jsonl(source_file, destination, target_agent, id_maps[source_agent])
                    result["neoRecordsConverted"] += len(records)
                    by_id = merged.setdefault(source_file.name, {})
                    for record in records:
                        key = str(record.get("id") or json.dumps(record, sort_keys=True, default=str))
                        by_id[key] = record
                elif source_file.suffix == ".json":
                    _convert_json_file(source_file, destination, target_agent, id_maps[source_agent])
                else:
                    shutil.copy2(source_file, destination)
                result["neoFilesConverted"] += 1
        for name, records in merged.items():
            destination = staging / "neo" / target_agent / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("w", encoding="utf-8") as handle:
                for record in records.values():
                    handle.write(json.dumps(record, ensure_ascii=True, sort_keys=True, default=str) + "\n")


def _convert_jsonl(source: Path, destination: Path, target_agent: str, id_map: dict[str, str]) -> list[dict[str, Any]]:
    records = []
    with source.open("r", encoding="utf-8", errors="replace") as input_handle:
        for line in input_handle:
            try:
                loaded = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(loaded, dict):
                records.append(_transform_record(loaded, target_agent, id_map))
    with destination.open("w", encoding="utf-8") as output_handle:
        for record in records:
            output_handle.write(json.dumps(record, ensure_ascii=True, sort_keys=True, default=str) + "\n")
    return records


def _convert_json_file(source: Path, destination: Path, target_agent: str, id_map: dict[str, str]) -> None:
    try:
        loaded = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        shutil.copy2(source, destination)
        return
    transformed = _transform_record(loaded, target_agent, id_map)
    destination.write_text(
        json.dumps(transformed, ensure_ascii=True, indent=2, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )


def _transform_record(value: Any, target_agent: str, id_map: dict[str, str], parent_key: str = "") -> Any:
    if isinstance(value, dict):
        transformed = {}
        for key, item in value.items():
            if key == "agentId":
                transformed[key] = target_agent
            elif key == "workspaceKey":
                transformed[key] = target_agent
            else:
                transformed[key] = _transform_record(item, target_agent, id_map, key)
        return transformed
    if isinstance(value, list):
        return [_transform_record(item, target_agent, id_map, parent_key) for item in value]
    if parent_key in ID_REFERENCE_KEYS and isinstance(value, str):
        return id_map.get(value, value)
    return value


def _stage_workspaces(
    snapshot: Path,
    staging: Path,
    mapping: dict[str, str],
    workspace_map: dict[str, str],
    result: dict[str, Any],
) -> None:
    openclaw_root = snapshot.parents[2]
    for source_agent, target_agent in mapping.items():
        configured = workspace_map.get(source_agent)
        source = Path(configured).expanduser().resolve() if configured else openclaw_root / (
            "workspace" if source_agent == "main" else f"workspace-{source_agent}"
        )
        profile_root = staging / "profiles" / target_agent
        destination_root = profile_root / "workspace"
        destination_root.mkdir(parents=True, exist_ok=True)
        profile = {
            "id": target_agent,
            "profileName": "bernd" if source_agent == "main" else target_agent,
            "displayName": "Bernd" if source_agent == "main" else source_agent.capitalize(),
            "sourceAgent": source_agent,
            "sourceWorkspace": str(source),
        }
        (profile_root / "profile.json").write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        result["profilesCreated"] += 1
        if not source.is_dir():
            continue
        for path in source.rglob("*"):
            if not path.is_file() or path.is_symlink():
                continue
            relative = path.relative_to(source)
            if _is_secret_or_runtime_path(relative):
                result["workspaceFilesExcluded"] += 1
                continue
            destination = destination_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
            result["workspaceFilesCopied"] += 1
        result["identityCompatibility"][target_agent] = {
            "contextFiles": sanitize_hermes_context_files(destination_root),
            "identity": ensure_hermes_identity(destination_root),
        }


def _is_secret_or_runtime_path(relative: Path) -> bool:
    if any(part in SKIP_DIRECTORIES for part in relative.parts):
        return True
    name = relative.name.lower()
    return name in SECRET_NAMES or any(fragment in name for fragment in SECRET_FRAGMENTS)
