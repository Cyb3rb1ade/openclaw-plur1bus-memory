"""Read-only preflight and manifest generator for an OpenClaw-to-Hermes move."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .tombstone import partition_cards_by_tombstone_guard
from .validation import ValidationError, safe_agent_id
from .validation import safe_memory_id, safe_status, safe_type


def _as_path(value: str) -> Path:
    return Path(value).expanduser().resolve()


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _inventory_agents(source: Path) -> list[dict[str, Any]]:
    store = source / "lancedb-namespaced"
    if not store.is_dir():
        return []
    agents = []
    for candidate in sorted(store.iterdir()):
        if not candidate.is_dir():
            continue
        try:
            agent_id = safe_agent_id(candidate.name)
        except ValidationError:
            continue
        agents.append({"agentId": agent_id, "path": str(candidate), "hasData": any(candidate.iterdir())})
    return agents


def _validate_mapping(raw_map: dict[str, Any], agents: list[dict[str, Any]], auto_map: bool) -> tuple[dict[str, str], list[str]]:
    errors: list[str] = []
    legacy_ids = {entry["agentId"] for entry in agents}
    mapping: dict[str, str] = {}
    if raw_map:
        for source_id, target_id in raw_map.items():
            try:
                source = safe_agent_id(str(source_id))
                target = safe_agent_id(str(target_id))
            except ValidationError as error:
                errors.append(str(error))
                continue
            if source not in legacy_ids:
                errors.append(f"agent map references unknown legacy agent: {source}")
                continue
            mapping[source] = target
    elif auto_map and len(legacy_ids) == 1:
        only_agent = next(iter(legacy_ids))
        mapping[only_agent] = only_agent
    elif legacy_ids:
        errors.append("explicit --agent-map is required unless exactly one legacy agent is present with --auto-map")
    return mapping, errors


def _manifest_hash(report: dict[str, Any]) -> str:
    canonical = json.dumps(report, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _migration_scope_key() -> str:
    scope = {"workspace": "default", "user": "", "chat": ""}
    return uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(scope, sort_keys=True)).hex


def _as_list(value: Any) -> list[float] | None:
    if hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, (list, tuple)):
        return None
    try:
        return [float(item) for item in value]
    except (TypeError, ValueError):
        return None


def _card_from_legacy(row: dict[str, Any], target_agent: str) -> dict[str, Any]:
    card_id = safe_memory_id(str(row.get("id", "")))
    content = next((str(row[key]).strip() for key in ("content", "text", "memory", "summary") if row.get(key)), "")
    if not content:
        raise ValidationError(f"memory {card_id} has no portable content")
    vector = next((_as_list(row.get(key)) for key in ("vector", "embedding", "embeddingVector") if row.get(key) is not None), None)
    if not vector:
        raise ValidationError(f"memory {card_id} has no portable vector")
    status = safe_status(str(row.get("status", "active")))
    memory_type = str(row.get("type", row.get("memoryType", "observation")))
    try:
        memory_type = safe_type(memory_type)
    except ValidationError:
        memory_type = "observation"
    card = {
        "id": card_id,
        "agentId": target_agent,
        "scopeKey": _migration_scope_key(),
        "sessionId": str(row.get("sessionId", row.get("sourceSessionId", "migration"))),
        "content": content,
        "status": status,
        "type": memory_type,
        "sourceRole": "migration",
        "createdAt": str(row.get("createdAt", row.get("created_at", _utcnow()))),
        "vector": vector,
    }
    # Legacy rows keep an explicitly stored trust state; nothing invents one
    # for rows that never carried it ("" stays legacy, upstream 7.4.0).
    source_epistemic = str(row.get("epistemicStatus") or "").strip()
    if source_epistemic:
        card["epistemicStatus"] = source_epistemic
    return card


def _copy_agent_cards(snapshot: Path, target: Path, source_agent: str, target_agent: str) -> dict[str, Any]:
    try:
        import lancedb
    except ImportError as error:
        raise RuntimeError("migration requires the lancedb Python dependency") from error
    source_dir = snapshot / "lancedb-namespaced" / source_agent
    source_db = lancedb.connect(str(source_dir))
    try:
        source_table = source_db.open_table("memories")
    except Exception as error:
        raise RuntimeError(f"legacy memories table is unreadable for {source_agent}") from error
    rows = source_table.to_arrow().to_pylist()
    cards = [_card_from_legacy(dict(row), target_agent) for row in rows]
    # Canonical reinsert guard (upstream 7.4.0): a forgotten text bound to the
    # migration target scope is never revived by a bulk copy. Blocked cards are
    # skipped and counted honestly instead of failing the whole migration.
    cards, blocked_cards = partition_cards_by_tombstone_guard(
        target, target_agent, cards, scope="workspace", workspace_identity="default",
    )
    target_dir = target / "lancedb" / target_agent
    if target_dir.exists():
        raise RuntimeError(f"target agent directory already exists: {target_dir}")
    target_dir.mkdir(parents=True, exist_ok=False)
    target_db = lancedb.connect(str(target_dir))
    if cards:
        target_db.create_table("memories", data=cards)
    return {
        "sourceAgent": source_agent,
        "targetAgent": target_agent,
        "cardsCopied": len(cards),
        "cardsTombstoneBlocked": len(blocked_cards),
    }


def _copy_snapshot_assets(snapshot: Path, staging: Path) -> dict[str, Any]:
    """Copy immutable migration assets and record, never regenerate, note hashes."""
    archives_source = snapshot / "archives"
    obsidian_source = snapshot / "obsidian"
    assets: dict[str, Any] = {"archivesCopied": 0, "obsidianNotesCopied": 0, "managedBlocks": []}
    if archives_source.is_dir():
        shutil.copytree(archives_source, staging / "archives")
        assets["archivesCopied"] = sum(1 for path in archives_source.rglob("*") if path.is_file())
    if obsidian_source.is_dir():
        shutil.copytree(obsidian_source, staging / "obsidian")
        for note in sorted(obsidian_source.rglob("*.md")):
            text = note.read_text(encoding="utf-8", errors="replace")
            assets["obsidianNotesCopied"] += 1
            if 'id="graph-links"' in text:
                assets["managedBlocks"].append({
                    "path": str(note.relative_to(obsidian_source)),
                    "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                })
    return assets


def _stage_reminder_import(snapshot: Path, staging: Path, agent_map: dict[str, str]) -> dict[str, Any]:
    """Create reviewable Hermes cron-create proposals without mutating scheduler state."""
    reminders = snapshot / "reminders"
    result: dict[str, Any] = {"proposals": 0, "skipped": 0, "path": ""}
    proposals: list[dict[str, str]] = []
    if reminders.is_dir():
        for reminder_file in sorted(reminders.rglob("*.json")):
            try:
                payload = json.loads(reminder_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                result["skipped"] += 1
                continue
            records = payload.get("reminders", payload) if isinstance(payload, dict) else payload
            if not isinstance(records, list):
                result["skipped"] += 1
                continue
            for index, record in enumerate(records):
                if not isinstance(record, dict):
                    result["skipped"] += 1
                    continue
                schedule = str(record.get("schedule") or record.get("cron") or "").strip()
                prompt = str(record.get("prompt") or record.get("message") or record.get("text") or "").strip()
                if not schedule or not prompt:
                    result["skipped"] += 1
                    continue
                source_agent = str(record.get("agentId") or "default")
                proposals.append({
                    "name": str(record.get("name") or record.get("title") or f"PLUR1BUS migrated reminder {index + 1}"),
                    "schedule": schedule,
                    "prompt": prompt,
                    "profile": agent_map.get(source_agent, source_agent),
                    "legacySource": str(reminder_file.relative_to(reminders)),
                })
    state_dir = staging / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    destination = state_dir / "cron-import-proposals.json"
    destination.write_text(json.dumps({"jobs": proposals}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    result["proposals"] = len(proposals)
    result["path"] = "state/cron-import-proposals.json"
    return result


def _stage_security_and_index_state(snapshot: Path, staging: Path) -> dict[str, Any]:
    """Invalidate legacy confirmations by reference and mandate index rebuilding."""
    nonce_files = []
    for path in snapshot.rglob("*.json"):
        name = path.name.lower()
        if "nonce" in name or "confirmation" in name:
            nonce_files.append({
                "path": str(path.relative_to(snapshot)),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            })
    state_dir = staging / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "invalidated-nonces.json").write_text(
        json.dumps({"reason": "OpenClaw-to-Hermes cutover", "sources": nonce_files}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (state_dir / "index-rebuild-required.json").write_text(
        json.dumps({"required": ["ann", "semantic-lens", "link-index"], "reason": "runtime indexes are not copied across stores"}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return {"invalidatedNonceSources": len(nonce_files), "indexRebuildRequired": True}


def run_dry_run(args: argparse.Namespace) -> dict[str, Any]:
    source = _as_path(args.source)
    target = _as_path(args.target)
    snapshot = _as_path(args.snapshot) if args.snapshot else None
    agents = _inventory_agents(source)
    mapping, map_errors = _validate_mapping(args.agent_map, agents, args.auto_map)
    errors = list(map_errors)
    if target == source or target.is_relative_to(source):
        errors.append("target must be outside the source store")
    for target_name in ("lancedb", "archives", "obsidian", "state"):
        if (target / target_name).exists():
            errors.append(f"target already contains PLUR1BUS {target_name} data")
    if not source.is_dir():
        errors.append("source store does not exist")
    if args.require_snapshot and not (snapshot and snapshot.is_dir()):
        errors.append("a readable --snapshot is required for a cutover-ready manifest")
    if snapshot and not snapshot.is_dir():
        errors.append("snapshot path is not a directory")
    lock_path = source / ".plur1bus-migration.lock"
    if lock_path.exists():
        errors.append("migration ownership lock already exists")
    report: dict[str, Any] = {
        "generatedAt": _utcnow(),
        "mode": "dry-run",
        "status": "ready" if not errors else "blocked",
        "source": str(source),
        "target": str(target),
        "snapshot": str(snapshot) if snapshot else "",
        "checks": {
            "sourceExists": source.is_dir(),
            "lancedbPathReadable": (source / "lancedb-namespaced").is_dir(),
            "obsidianPathReadable": (source / "obsidian").is_dir(),
            "remindersPathReadable": (source / "reminders").is_dir(),
            "snapshotReadable": bool(snapshot and snapshot.is_dir()),
            "ownershipLockPresent": lock_path.exists(),
            "targetOutsideSource": not (target == source or target.is_relative_to(source)),
            "targetLanceDbAbsent": not (target / "lancedb").exists(),
            "targetArchivesAbsent": not (target / "archives").exists(),
            "targetObsidianAbsent": not (target / "obsidian").exists(),
            "targetStateAbsent": not (target / "state").exists(),
        },
        "legacyAgents": agents,
        "agentMapMode": "auto" if args.auto_map else "manual",
        "agentMap": mapping,
        "invalidatedNonces": "required-at-cutover",
        "runtimeIndexes": "rebuild-required",
        "errors": errors,
    }
    report["manifestSha256"] = _manifest_hash(report)
    return report


def run_migrate(args: argparse.Namespace) -> dict[str, Any]:
    report = run_dry_run(args)
    if args.dry_run:
        return report
    report["mode"] = "migrate"
    if not args.apply:
        report["status"] = "blocked"
        report["errors"].append("pass --apply only after reviewing a ready dry-run manifest")
        return report
    if not args.snapshot:
        report["status"] = "blocked"
        report["errors"].append("--apply requires a read-only --snapshot")
        return report
    snapshot = _as_path(args.snapshot)
    apply_args = argparse.Namespace(**vars(args))
    apply_args.source = str(snapshot)
    apply_args.snapshot = str(snapshot)
    apply_args.require_snapshot = True
    report = run_dry_run(apply_args)
    report["mode"] = "migrate"
    if report["status"] != "ready":
        return report
    target = _as_path(args.target)
    staging = target.parent / f".{target.name}.plur1bus-migration-{uuid.uuid4().hex}"
    copied = []
    try:
        for source_agent, target_agent in report["agentMap"].items():
            copied.append(_copy_agent_cards(snapshot, staging, source_agent, target_agent))
        assets = _copy_snapshot_assets(snapshot, staging)
        reminder_import = _stage_reminder_import(snapshot, staging, report["agentMap"])
        migration_state = _stage_security_and_index_state(snapshot, staging)
    except (RuntimeError, ValidationError) as error:
        shutil.rmtree(staging, ignore_errors=True)
        report["status"] = "blocked"
        report["errors"].append(str(error))
        report["copiedAgents"] = copied
        return report
    target.mkdir(parents=True, exist_ok=True)
    for asset_name in ("lancedb", "archives", "obsidian", "state"):
        staged_asset = staging / asset_name
        if staged_asset.exists():
            shutil.move(str(staged_asset), str(target / asset_name))
    shutil.rmtree(staging, ignore_errors=True)
    report["status"] = "completed"
    report["copiedAgents"] = copied
    report["assets"] = assets
    report["reminderImport"] = reminder_import
    report["migrationState"] = migration_state
    report["pendingStages"] = ["activate-cron-proposals", "runtime-index-rebuild"]
    manifest_dir = target / "manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / "openclaw-migration.json"
    report["manifestSha256"] = _manifest_hash({key: value for key, value in report.items() if key != "manifestSha256"})
    manifest_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    report["manifestPath"] = str(manifest_path)
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="PLUR1BUS Hermes migration preflight")
    parser.add_argument("source", help="Source OpenClaw store root")
    parser.add_argument("target", help="Target Hermes data root")
    parser.add_argument("--snapshot", default="", help="Read-only backup snapshot for cutover validation")
    parser.add_argument("--agent-map", default="{}", help="JSON mapping from legacy agent IDs to Hermes profile IDs")
    parser.add_argument("--auto-map", action="store_true", help="Allow 1:1 mapping only when exactly one legacy agent exists")
    parser.add_argument("--dry-run", action="store_true", help="Inventory and validation only")
    parser.add_argument("--apply", action="store_true", help="Copy cards and vectors from the supplied snapshot after preflight")
    parser.add_argument("--require-snapshot", action="store_true", help="Fail the manifest unless --snapshot is a readable directory")
    parser.add_argument("--report", default="", help="Optional path for the generated JSON manifest")
    return parser


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parsed = build_parser().parse_args(argv)
    try:
        parsed.agent_map = json.loads(parsed.agent_map)
    except json.JSONDecodeError as error:
        raise SystemExit(f"--agent-map must be valid JSON: {error}") from error
    if not isinstance(parsed.agent_map, dict):
        raise SystemExit("--agent-map must be a JSON object")
    return parsed


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = run_migrate(args)
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.report:
        report_path = _as_path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if report["status"] in {"ready", "completed"} and (args.dry_run or args.apply) else 2


if __name__ == "__main__":
    raise SystemExit(main())
