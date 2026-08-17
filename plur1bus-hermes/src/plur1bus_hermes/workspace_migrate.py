"""Snapshot-gated OpenClaw workspace migration with mandatory re-embedding."""

from __future__ import annotations

import argparse
import hashlib
import json
import signal
import shutil
import traceback
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .migrate import (
    _as_list,
    _as_path,
    _copy_snapshot_assets,
    _inventory_agents,
    _migration_scope_key,
    _stage_reminder_import,
    _stage_security_and_index_state,
    _validate_mapping,
)
from .legacy_assets import normalize_legacy_status, stage_card_metadata, stage_complete_assets
from .reembed import _read_json
from .runtime import EmbeddingBackend
from .tombstone import partition_cards_by_tombstone_guard
from .validation import ValidationError, safe_agent_id, safe_memory_id, safe_status, safe_type


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _manifest_hash(report: dict[str, Any]) -> str:
    value = json.dumps(report, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class MigrationInterrupted(RuntimeError):
    """Represent an externally requested, resumable migration stop."""


def _append_event(log_file: Path | None, event: str, **details: Any) -> None:
    """Append one durable JSON event without allowing diagnostics to stop migration."""
    if log_file is None:
        return
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        record = {"timestamp": _utcnow(), "event": event, **details}
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True, ensure_ascii=True) + "\n")
            handle.flush()
    except OSError:
        pass


def _write_resume_progress(staging: Path, progress: dict[str, Any]) -> None:
    """Persist migration progress atomically so an interrupted batch can resume."""
    state_dir = staging / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    target = state_dir / "workspace-migration-progress.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(progress, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(target)


def _migratable_agents(root: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """Return only OpenClaw agent directories that contain a memories table."""
    try:
        import lancedb
    except ImportError as error:
        raise RuntimeError("workspace migration requires the lancedb Python dependency") from error
    store = root / "lancedb-namespaced"
    if not store.is_dir():
        return [], []
    agents: list[dict[str, Any]] = []
    skipped: list[str] = []
    for candidate in sorted(path for path in store.iterdir() if path.is_dir()):
        try:
            agent_id = safe_agent_id(candidate.name)
            tables = lancedb.connect(str(candidate)).table_names()
        except Exception:
            skipped.append(candidate.name)
            continue
        if "memories" not in tables:
            skipped.append(agent_id)
            continue
        agents.append({"agentId": agent_id, "path": str(candidate), "hasData": True})
    return agents, skipped


def _portable_memory_id(raw_id: Any, source_agent: str) -> str:
    """Preserve valid UUIDs and deterministically translate legacy identifiers."""
    value = str(raw_id or "").strip()
    try:
        return safe_memory_id(value)
    except ValidationError:
        if not value:
            raise ValidationError("legacy memory has no id")
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"plur1bus-openclaw:{source_agent}:{value}"))


def _workspace_card(
    row: dict[str, Any],
    agent_id: str,
    source_agent: str,
    vector: list[float],
) -> dict[str, Any]:
    """Preserve portable card metadata while replacing its vector entirely."""
    card_id = _portable_memory_id(row.get("id"), source_agent)
    content = next((str(row[key]).strip() for key in ("content", "text", "memory", "summary") if row.get(key)), "")
    if not content:
        raise ValidationError(f"memory {card_id} has no portable content")
    memory_type = str(row.get("type", row.get("memoryType", "observation")))
    try:
        memory_type = safe_type(memory_type)
    except ValidationError:
        memory_type = "observation"
    card = {
        "id": card_id,
        "agentId": agent_id,
        "scopeKey": _migration_scope_key(),
        "sessionId": str(row.get("sessionId", row.get("sourceSessionId", "workspace-migration"))),
        "content": content,
        "status": normalize_legacy_status(row.get("status")),
        "type": memory_type,
        "sourceRole": "workspace-migration",
        "createdAt": str(row.get("createdAt", row.get("created_at", _utcnow()))),
        "vector": vector,
    }
    # Legacy rows keep an explicitly stored trust state; nothing invents one
    # for rows that never carried it ("" stays legacy, upstream 7.4.0).
    source_epistemic = str(row.get("epistemicStatus") or "").strip()
    if source_epistemic:
        card["epistemicStatus"] = source_epistemic
    return card


def _legacy_rows(snapshot: Path, source_agent: str) -> list[dict[str, Any]]:
    try:
        import lancedb
    except ImportError as error:
        raise RuntimeError("workspace migration requires the lancedb Python dependency") from error
    source_dir = snapshot / "lancedb-namespaced" / source_agent
    try:
        table = lancedb.connect(str(source_dir)).open_table("memories")
    except Exception as error:
        raise RuntimeError(f"legacy memories table is unreadable for {source_agent}") from error
    return [dict(row) for row in table.to_arrow().to_pylist()]


def _portable_content(row: dict[str, Any]) -> str:
    return next(
        (
            str(row[key]).strip()
            for key in ("content", "text", "memory", "summary")
            if row.get(key)
        ),
        "",
    )


def _pending_resume_rows(
    rows: list[dict[str, Any]],
    existing_rows: list[dict[str, Any]],
    source_agent: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    existing = Counter(
        (
            str(row.get("id") or ""),
            _portable_content(row),
        )
        for row in existing_rows
    )
    pending_rows: list[dict[str, Any]] = []
    contents: list[str] = []
    for row in rows:
        content = _portable_content(row)
        if not content:
            raise ValidationError(f"legacy memory {row.get('id', '<unknown>')} has no portable content")
        signature = (_portable_memory_id(row.get("id"), source_agent), content)
        if existing[signature] > 0:
            existing[signature] -= 1
            continue
        pending_rows.append(row)
        contents.append(content)
    return pending_rows, contents


def run_dry_run(args: argparse.Namespace) -> dict[str, Any]:
    """Validate a complete migration without loading embedding models or writing data."""
    source = _as_path(args.source)
    target = _as_path(args.target)
    snapshot = _as_path(args.snapshot) if args.snapshot else None
    agents, skipped_agents = _migratable_agents(source)
    mapping, map_errors = _validate_mapping(args.agent_map, agents, args.auto_map)
    errors = list(map_errors)
    if not source.is_dir():
        errors.append("source workspace does not exist")
    if target == source or target.is_relative_to(source):
        errors.append("target must be outside the source workspace")
    if not snapshot or not snapshot.is_dir():
        errors.append("a readable --snapshot is required")
    elif mapping:
        snapshot_agents, _ = _migratable_agents(snapshot)
        snapshot_ids = {entry["agentId"] for entry in snapshot_agents}
        for source_agent in mapping:
            if source_agent not in snapshot_ids:
                errors.append(f"snapshot has no readable memories table for agent: {source_agent}")
    if target.exists() and any(target.iterdir()) and not args.replace_target:
        errors.append("target already contains data; pass --replace-target to back it up before activation")
    embedding = args.config.get("embedding") if isinstance(args.config, dict) else None
    if not isinstance(embedding, dict):
        errors.append("PLUR1BUS config requires an embedding section")
        embedding = {}
    dimensions = int(embedding.get("dimensions", 0) or 0)
    if dimensions <= 0:
        errors.append("embedding.dimensions must be positive")
    report: dict[str, Any] = {
        "generatedAt": _utcnow(),
        "mode": "dry-run",
        "status": "ready" if not errors else "blocked",
        "source": str(source),
        "snapshot": str(snapshot) if snapshot else "",
        "target": str(target),
        "agents": agents,
        "skippedSourceAgents": skipped_agents,
        "agentMap": mapping,
        "embeddingMigration": {
            "required": True,
            "provider": str(embedding.get("provider", "")),
            "model": str(embedding.get("model", "")),
            "targetDimensions": dimensions,
            "rerankingMigrationRequired": False,
        },
        "assetScope": ["card metadata", "_archive", "_neo", "agent workspaces", "Obsidian", "adaptive learning", "critical-push state", "reminder proposals", "nonce invalidation", "index-rebuild state"],
        "excludedScope": ["OpenClaw credentials", "sessions", "runtime caches", "scheduler state"],
        "errors": errors,
    }
    report["manifestSha256"] = _manifest_hash(report)
    return report


def _stage_agents(
    snapshot: Path,
    staging: Path,
    mapping: dict[str, str],
    config: dict[str, Any],
    batch_size: int,
    log_file: Path | None = None,
) -> tuple[list[dict[str, Any]], dict[str, dict[int, int]], dict[str, dict[str, str]]]:
    """Build every target agent table using only fresh embedding vectors."""
    try:
        import lancedb
    except ImportError as error:
        raise RuntimeError("workspace migration requires the lancedb Python dependency") from error
    backend = EmbeddingBackend(dict(config["embedding"]), staging.parent)
    copied: list[dict[str, Any]] = []
    old_dimensions: dict[str, dict[int, int]] = {}
    id_maps: dict[str, dict[str, str]] = {}
    for source_agent, target_agent in mapping.items():
        rows = _legacy_rows(snapshot, source_agent)
        id_map = {
            str(row.get("id") or ""): _portable_memory_id(row.get("id"), source_agent)
            for row in rows
        }
        id_maps[source_agent] = id_map
        old_dimensions[source_agent] = dict(Counter(len(vector) for vector in (_as_list(row.get("vector")) for row in rows) if vector))
        agent_dir = staging / "lancedb" / safe_agent_id(target_agent)
        existing_rows: list[dict[str, Any]] = []
        table = None
        if agent_dir.exists():
            try:
                table = lancedb.connect(str(agent_dir)).open_table("memories")
                existing_rows = [dict(card) for card in table.to_arrow().to_pylist()]
            except Exception as error:
                raise RuntimeError(f"unable to resume staged agent {target_agent}") from error
        else:
            agent_dir.mkdir(parents=True, exist_ok=False)
        metadata_count = stage_card_metadata(agent_dir, source_agent, target_agent, rows, id_map)
        pending_rows, contents = _pending_resume_rows(rows, existing_rows, source_agent)
        # Canonical reinsert guard (upstream 7.4.0): forgotten text bound to
        # the migration target scope is never revived by a bulk re-embed.
        # Blocked rows are skipped before embedding and counted honestly.
        allowed_rows, blocked_rows = partition_cards_by_tombstone_guard(
            staging, target_agent,
            [{"content": content} for content in contents],
            scope="workspace", workspace_identity="default",
        )
        if blocked_rows:
            blocked_contents = {str(card["content"]) for card in blocked_rows}
            kept = [
                (row, content)
                for row, content in zip(pending_rows, contents, strict=True)
                if content not in blocked_contents
            ]
            pending_rows = [row for row, _ in kept]
            contents = [content for _, content in kept]
            _append_event(
                log_file,
                "tombstone_blocked",
                sourceAgent=source_agent,
                targetAgent=target_agent,
                blockedCards=len(blocked_rows),
            )
        completed_rows = len(existing_rows)
        _append_event(
            log_file,
            "agent_started",
            sourceAgent=source_agent,
            targetAgent=target_agent,
            totalCards=len(rows),
            resumedCards=completed_rows,
        )
        for start in range(0, len(contents), batch_size):
            batch_rows = pending_rows[start:start + batch_size]
            vectors = backend.embed_many(contents[start:start + batch_size])
            cards = [
                _workspace_card(row, target_agent, source_agent, vector)
                for row, vector in zip(batch_rows, vectors, strict=True)
            ]
            if table is None:
                table = lancedb.connect(str(agent_dir)).create_table("memories", data=cards)
            else:
                table.add(cards)
            completed_rows += len(cards)
            progress = {
                "updatedAt": _utcnow(),
                "currentSourceAgent": source_agent,
                "currentTargetAgent": target_agent,
                "completedCardsForCurrentAgent": completed_rows,
                "totalCardsForCurrentAgent": len(rows),
                "completedAgents": [entry["targetAgent"] for entry in copied],
            }
            _write_resume_progress(staging, progress)
            _append_event(log_file, "batch_completed", **progress)
        copied.append({
            "sourceAgent": source_agent,
            "targetAgent": target_agent,
            "cardsReembedded": len(rows) - len(blocked_rows),
            "cardsResumed": len(rows) - len(pending_rows) - len(blocked_rows),
            "cardsTombstoneBlocked": len(blocked_rows),
            "metadataPreserved": metadata_count,
        })
        _write_resume_progress(staging, {
            "updatedAt": _utcnow(),
            "currentSourceAgent": "",
            "currentTargetAgent": "",
            "completedCardsForCurrentAgent": 0,
            "totalCardsForCurrentAgent": 0,
            "completedAgents": [entry["targetAgent"] for entry in copied],
        })
        _append_event(
            log_file,
            "agent_completed",
            sourceAgent=source_agent,
            targetAgent=target_agent,
            totalCards=len(rows),
        )
    return copied, old_dimensions, id_maps


def run_migrate(args: argparse.Namespace) -> dict[str, Any]:
    """Stage and atomically deploy a snapshot-backed workspace migration."""
    report = run_dry_run(args)
    if not args.apply:
        return report
    report["mode"] = "apply"
    if report["status"] != "ready":
        return report
    snapshot = _as_path(args.snapshot)
    target = _as_path(args.target)
    staging = _as_path(args.resume_staging) if args.resume_staging else target.parent / f".{target.name}.workspace-migration-{uuid.uuid4().hex}"
    if args.resume_staging and not staging.is_dir():
        report["status"] = "blocked"
        report.setdefault("errors", []).append("--resume-staging must name an existing staging directory")
        return report
    log_file = _as_path(args.log_file) if args.log_file else staging / "state" / "workspace-migration-events.jsonl"
    backup = target.parent / f"{target.name}.backup-before-workspace-migration-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    _append_event(
        log_file,
        "migration_started",
        source=str(snapshot),
        staging=str(staging),
        target=str(target),
        batchSize=args.batch_size,
        agentMap=report["agentMap"],
    )
    try:
        copied, old_dimensions, id_maps = _stage_agents(
            snapshot,
            staging,
            report["agentMap"],
            args.config,
            args.batch_size,
            log_file,
        )
        assets = stage_complete_assets(
            snapshot,
            staging,
            report["agentMap"],
            id_maps,
            getattr(args, "workspace_map", {}),
        )
        reminders = _stage_reminder_import(snapshot, staging, report["agentMap"])
        state = _stage_security_and_index_state(snapshot, staging)
        manifest_dir = staging / "manifests"
        manifest_dir.mkdir(parents=True, exist_ok=True)
        report.update({
            "status": "completed",
            "reembeddedAgents": copied,
            "sourceVectorDimensions": old_dimensions,
            "assets": assets,
            "reminderImport": reminders,
            "migrationState": state,
            "pendingStages": ["activate-cron-proposals", "runtime-index-rebuild"],
            "replacedTargetBackup": str(backup) if target.exists() else "",
        })
        report["manifestSha256"] = _manifest_hash({key: value for key, value in report.items() if key != "manifestSha256"})
        manifest_path = manifest_dir / "workspace-migration.json"
        manifest_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        if target.exists():
            shutil.move(str(target), str(backup))
        try:
            shutil.move(str(staging), str(target))
        except Exception:
            if backup.exists() and not target.exists():
                shutil.move(str(backup), str(target))
            raise
        report["manifestPath"] = str(target / "manifests" / "workspace-migration.json")
        _append_event(log_file, "migration_completed", target=str(target), manifestPath=report["manifestPath"])
        return report
    except Exception as error:
        report["status"] = "blocked"
        report.setdefault("errors", []).append(str(error))
        _append_event(
            log_file,
            "migration_failed",
            errorType=type(error).__name__,
            error=str(error),
            traceback=traceback.format_exc(),
        )
        return report
    finally:
        if report.get("status") == "completed":
            shutil.rmtree(staging, ignore_errors=True)


def build_parser() -> argparse.ArgumentParser:
    """Build an explicit snapshot migration command for all mapped agents."""
    parser = argparse.ArgumentParser(description="Migrate OpenClaw PLUR1BUS workspaces to Hermes with re-embedding")
    parser.add_argument("source", help="OpenClaw PLUR1BUS store root")
    parser.add_argument("target", help="Empty Hermes PLUR1BUS data root")
    parser.add_argument("--snapshot", required=True, help="Read-only snapshot used as the migration source")
    parser.add_argument("--config", required=True, help="Hermes PLUR1BUS config.json containing the target embedding model")
    parser.add_argument("--agent-map", default="{}", help="JSON mapping from OpenClaw agent IDs to Hermes agent IDs")
    parser.add_argument("--workspace-map", default="{}", help="Optional JSON mapping from source agent IDs to OpenClaw workspace paths")
    parser.add_argument("--auto-map", action="store_true", help="Allow identity mapping only for exactly one source agent")
    parser.add_argument("--identity-map", action="store_true", help="Map every valid source agent to the same Hermes agent ID")
    parser.add_argument("--replace-target", action="store_true", help="Back up an existing target root before the staged switch")
    parser.add_argument("--batch-size", type=int, default=16, help="Number of texts per oMLX embedding request")
    parser.add_argument("--resume-staging", default="", help="Resume an interrupted staging directory without re-embedding completed cards")
    parser.add_argument("--apply", action="store_true", help="Stage, re-embed, and deploy after a ready dry-run")
    parser.add_argument("--report", default="", help="Optional JSON report path")
    parser.add_argument("--log-file", default="", help="Append migration lifecycle and traceback events as JSONL")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run a dry-run by default and require --apply for all writes."""
    args = build_parser().parse_args(argv)
    previous_handlers: dict[int, Any] = {}

    def interrupt_handler(signum: int, _frame: Any) -> None:
        raise MigrationInterrupted(f"migration interrupted by signal {signal.Signals(signum).name}")

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.signal(signum, interrupt_handler)
    try:
        if args.batch_size <= 0:
            raise ValueError("--batch-size must be positive")
        args.agent_map = json.loads(args.agent_map)
        if not isinstance(args.agent_map, dict):
            raise ValueError("--agent-map must be a JSON object")
        args.workspace_map = json.loads(args.workspace_map)
        if not isinstance(args.workspace_map, dict):
            raise ValueError("--workspace-map must be a JSON object")
        if args.identity_map:
            if args.agent_map or args.auto_map:
                raise ValueError("--identity-map cannot be combined with --agent-map or --auto-map")
            args.agent_map = {
                entry["agentId"]: entry["agentId"]
                for entry in _migratable_agents(_as_path(args.source))[0]
            }
        args.config = _read_json(_as_path(args.config))
        report = run_migrate(args)
    except Exception as error:
        report = {"generatedAt": _utcnow(), "status": "blocked", "errors": [str(error)]}
        _append_event(
            _as_path(args.log_file) if args.log_file else None,
            "command_failed",
            errorType=type(error).__name__,
            error=str(error),
            traceback=traceback.format_exc(),
        )
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.report:
        report_path = _as_path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if report["status"] in {"ready", "completed"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
