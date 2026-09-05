"""Safe LanceDB re-embedding for a PLUR1BUS Hermes agent."""

from __future__ import annotations

import argparse
import json
import shutil
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .runtime import EmbeddingBackend
from .validation import ValidationError, safe_agent_id


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _as_path(value: str) -> Path:
    return Path(value).expanduser().resolve()


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"cannot read configuration: {path}") from error
    if not isinstance(value, dict):
        raise ValidationError("PLUR1BUS configuration must be a JSON object")
    return value


def _vector_dimension(value: Any) -> int:
    if hasattr(value, "tolist"):
        value = value.tolist()
    return len(value) if isinstance(value, (list, tuple)) else 0


def _source_rows(agent_dir: Path) -> list[dict[str, Any]]:
    try:
        import lancedb
    except ImportError as error:
        raise RuntimeError("re-embedding requires the lancedb Python dependency") from error
    try:
        table = lancedb.connect(str(agent_dir)).open_table("memories")
    except Exception as error:
        raise RuntimeError(f"unable to open PLUR1BUS memories table: {agent_dir}") from error
    return [dict(row) for row in table.to_arrow().to_pylist()]


def build_report(data_dir: Path, agent_id: str, config: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Inventory an agent table without loading an embedding model or writing data."""
    agent_dir = data_dir / "lancedb" / agent_id
    rows = _source_rows(agent_dir)
    dimensions = Counter(_vector_dimension(row.get("vector")) for row in rows)
    embedding = config.get("embedding")
    if not isinstance(embedding, dict):
        raise ValidationError("configuration has no embedding section")
    target_dimensions = int(embedding.get("dimensions", 0))
    if target_dimensions <= 0:
        raise ValidationError("embedding.dimensions must be positive")
    return {
        "generatedAt": _utcnow(),
        "agentId": agent_id,
        "dataDir": str(data_dir),
        "sourceTable": str(agent_dir),
        "cards": len(rows),
        "sourceVectorDimensions": dict(sorted(dimensions.items())),
        "targetEmbedding": {
            "provider": str(embedding.get("provider", "local-transformers")),
            "model": str(embedding.get("model", "")),
            "dimensions": target_dimensions,
        },
    }, rows


def reembed(data_dir: Path, agent_id: str, config: dict[str, Any], *, apply: bool) -> dict[str, Any]:
    """Rebuild one LanceDB agent table using the configured embedding backend."""
    report, rows = build_report(data_dir, agent_id, config)
    report["mode"] = "apply" if apply else "dry-run"
    if not apply:
        report["status"] = "ready"
        report["nextStep"] = "rerun with --apply after reviewing this report"
        return report
    if not rows:
        report["status"] = "completed"
        report["backupPath"] = ""
        report["reembeddedCards"] = 0
        return report

    agent_dir = data_dir / "lancedb" / agent_id
    lancedb_root = agent_dir.parent
    staging = lancedb_root / f".{agent_id}.reembed-{uuid.uuid4().hex}"
    backup = lancedb_root / f"{agent_id}.backup-before-reembed-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    backend = EmbeddingBackend(dict(config["embedding"]), data_dir.parent)
    cards: list[dict[str, Any]] = []
    try:
        for row in rows:
            content = str(row.get("content", "")).strip()
            if not content:
                raise ValidationError(f"memory {row.get('id', '<unknown>')} has no content to re-embed")
            cards.append({**row, "vector": backend.embed(content)})
        try:
            import lancedb
        except ImportError as error:
            raise RuntimeError("re-embedding requires the lancedb Python dependency") from error
        staging.mkdir(parents=True, exist_ok=False)
        # Tombstone note (7.4.0): this copies rows already live in the agent
        # table verbatim — deleted/archived rows keep their status, no text is
        # newly introduced, so the canonical reinsert guard cannot fire here.
        # Revival protection relies on forget deleting the row itself.
        lancedb.connect(str(staging)).create_table("memories", data=cards)
        shutil.copytree(agent_dir, backup)
        shutil.rmtree(agent_dir)
        try:
            shutil.move(str(staging), str(agent_dir))
        except Exception:
            shutil.move(str(backup), str(agent_dir))
            raise
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    report.update({
        "status": "completed",
        "reembeddedCards": len(cards),
        "backupPath": str(backup),
        "targetVectorDimensions": _vector_dimension(cards[0]["vector"]),
    })
    return report


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI parser for explicit, opt-in re-embedding."""
    parser = argparse.ArgumentParser(description="Re-embed a PLUR1BUS Hermes LanceDB table safely")
    parser.add_argument("--hermes-home", default=str(Path.home() / ".hermes"), help="Hermes home directory")
    parser.add_argument("--config", default="", help="PLUR1BUS config.json; defaults to HERMES_HOME/plugins/plur1bus/config.json")
    parser.add_argument("--data-dir", default="", help="Override configured PLUR1BUS dataDir")
    parser.add_argument("--agent-id", default="", help="Override configured PLUR1BUS agentId")
    parser.add_argument("--apply", action="store_true", help="Build a new table, back up the old table, and switch atomically")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run dry-run or explicit apply and render a machine-readable report."""
    args = build_parser().parse_args(argv)
    hermes_home = _as_path(args.hermes_home)
    config_path = _as_path(args.config) if args.config else hermes_home / "plugins" / "plur1bus" / "config.json"
    try:
        config = _read_json(config_path)
        agent_id = safe_agent_id(str(args.agent_id or config.get("agentId", "default")))
        configured_dir = Path(str(args.data_dir or config.get("dataDir", "plur1bus"))).expanduser()
        data_dir = configured_dir if configured_dir.is_absolute() else hermes_home / configured_dir
        report = reembed(data_dir.resolve(), agent_id, config, apply=args.apply)
    except (RuntimeError, ValidationError, OSError) as error:
        report = {"generatedAt": _utcnow(), "status": "blocked", "error": str(error)}
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["status"] in {"ready", "completed"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
