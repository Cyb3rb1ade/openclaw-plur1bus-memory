"""Installer-facing, explicit per-profile model changes and staged memory migration.

Package installation and data migration have separate approvals and recovery
boundaries. There is no destructive in-place vector resize or implicit model.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

from .generation import _reject_symlink_components, _validate_complete, activate_staged_generation, generation_namespace
from .operator_cli import runtime_view
from .retrieval_admin import (config_path, context_revision, embedding_migration_plan, prepare_embedding,
                              public_config, save_empty_embedding, save_reranker, stage_embedding, validate_target)
from .reembed_staged import _source_snapshot, validate_staged_reembed
from .validation import ValidationError, safe_agent_id


def _view(home: Path, profile: str):
    profile = safe_agent_id(profile)
    home = Path(home).expanduser().absolute()
    if home.parent.name == "profiles":
        raise ValidationError("use the root Hermes home and select the profile separately")
    selected = home if profile == "default" else home / "profiles" / profile
    _reject_symlink_components(home, selected / "config.yaml", message="unsafe Hermes profile")
    if not (selected / "config.yaml").is_file():
        raise ValidationError("select an existing Hermes profile")
    view = runtime_view(home, profile)
    view.hermes_home, view.profile = home, profile
    namespace = generation_namespace(view.config)
    if namespace is not None and (set(view.config["namespaces"]["activeRecallNamespaces"]) != {namespace}
                                  or view.config["namespaces"].get("crossNamespaceRecall") is True):
        raise ValidationError("installer migration requires an isolated named writer; review other namespaces separately")
    return view


def review(home: Path, profile: str, kind: str, target: dict) -> dict:
    """Read-only plan binding model, profile, config and source generation."""
    target = validate_target(kind, target)
    view = _view(home, profile)
    staged = None
    operation = "reranker-change"
    if kind == "embedding":
        staged = embedding_migration_plan(view, target)
        operation = "configure-empty-store" if staged is None else "reembed-memories"
    result = {"schema": 1, "home": str(view.hermes_home), "profile": profile, "agentId": view.agent_id,
              "kind": kind, "target": target, "current": public_config(view.config.get(kind, {})),
              "revision": context_revision(view), "operation": operation, "migration": staged,
              "configPath": str(config_path(view)), "sourceRoute": str(view._writer_route.path),
              "effects": "Model downloads or remote calls occur only after approval. Re-embedding sends memory text to the selected provider. Original vectors remain; activation is separate. All profiles intentionally aliased to this same agent/data root share its generation. Other agents are unchanged."}
    result["confirmation"] = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    return result


def execute(home: Path, profile: str, kind: str, target: dict, action: str = "plan", *, confirmation: str | None = None, stopped: bool = False) -> dict:
    """Plan, stage, validate or activate; each write requires an exact approval."""
    if action not in {"plan", "prepare", "stage", "validate", "activate"}:
        raise ValidationError("unknown retrieval action")
    plan = review(home, profile, kind, target)
    if action == "plan":
        return plan
    view = _view(home, profile)
    config = {**view.config, "embedding": plan["target"]} if kind == "embedding" else view.config
    if action == "validate":
        if plan["migration"] is None:
            raise ValidationError("there is no staged memory migration to validate")
        _validate_complete(plan["migration"], view.data_dir, view.agent_id, config, None)
        return validate_staged_reembed(plan["migration"], view.data_dir, view.agent_id, config)
    if not stopped or confirmation != plan["confirmation"]:
        raise ValidationError("stop affected runtimes and approve the exact current retrieval plan")
    if action == "prepare":
        if kind == "reranker":
            from .retrieval_admin import prepare_reranker
            return prepare_reranker(view, plan["target"], plan["revision"])
        return prepare_embedding(view, plan["target"], plan["revision"])
    if action == "stage":
        if plan["migration"] is None:
            raise ValidationError("staging is only needed for a populated embedding store; use activate for a reviewed config change")
        return stage_embedding(view, plan["target"], plan["migration"], lambda _progress: None, revision=plan["revision"])
    if kind == "reranker":
        return save_reranker(view, plan["target"], plan["revision"])
    if plan["migration"] is not None:
        migration = plan["migration"]
        backups = view.data_dir / "state" / view.agent_id / "retrieval-backups"
        _reject_symlink_components(view.data_dir.absolute(), backups, message="unsafe backup root")
        verified_backup = False
        for backup in sorted(backups.glob(migration["planId"] + "-*")):
            _reject_symlink_components(view.data_dir.absolute(), backup / "snapshot.json", message="unsafe backup")
            metadata = json.loads((backup / "snapshot.json").read_text(encoding="utf-8")) if (backup / "snapshot.json").is_file() else {}
            if metadata.get("complete") is True and metadata.get("plan") == migration:
                for entry in (backup / "database").rglob("*"):
                    _reject_symlink_components(view.data_dir.absolute(), entry, message="unsafe database backup")
                _rows, version, fingerprint = _source_snapshot(backup / "database", None)
                if version == migration["sourceVersion"] and fingerprint == migration["sourceFingerprint"]:
                    verified_backup = True
                    break
        if not verified_backup:
            raise ValidationError("a verified source backup is required; run the installer stage step first")
        # This API obtains exclusive runtime/writer/stage leases and compares all
        # non-vector record fields immediately before/after pointer publication.
        return activate_staged_generation(plan["migration"], view.data_dir, view.agent_id, config,
                                          approved_plan_id=plan["migration"]["planId"])
    return save_empty_embedding(view, plan["target"], plan["revision"], backup_key=plan["confirmation"])
