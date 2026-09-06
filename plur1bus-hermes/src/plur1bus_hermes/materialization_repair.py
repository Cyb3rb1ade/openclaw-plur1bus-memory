"""Idempotent missing-artifact repair; the authoritative source is never retired here."""
from __future__ import annotations

from datetime import datetime, timezone
import os
from typing import Any
import uuid

from .cognition import analyze_text, contradiction_score
from .validation import safe_memory_id, resolve_inside
from .writer_lock import writer_lock


def repair_materialization(domain: Any, record: dict[str, Any], table: Any) -> dict[str, Any]:
    """Fill missing scoped metadata, mirror and graph entries without overwrites."""
    report = {"complete": False, "repaired": [], "conflicts": []}
    identifier = safe_memory_id(record.get("id"))
    selector = domain._scope_selector(record=record)
    if (record.get("status") != "active" or record.get("agentId") != domain.agent_id
        or record.get("scopeKey") != selector.scope_key):
        report["conflicts"].append("scope-or-status")
        return report
    with writer_lock(domain.data_dir):
        rows = [row for row in domain._metadata_rows_for_scope(selector) if row.get("id") == identifier]
        if len(rows) > 1 or (rows and domain._metadata_json(rows[0]).get("text") != record.get("content")):
            report["conflicts"].append("metadata")
            return report
        if not rows:
            domain._store_metadata(record)
            report["repaired"].append("metadata")
        workspace = domain._scope_workspace_dir(selector)
        raw_note = workspace / "plur1bus" / "memories" / f"{identifier}.md"
        if any(path.is_symlink() for path in (raw_note, raw_note.parent, raw_note.parent.parent)):
            report["conflicts"].append("mirror-symlink")
            return report
        note = resolve_inside(str(workspace), "plur1bus", "memories", f"{identifier}.md")
        prefix = (
            f"---\nid: {identifier}\nagent: {domain.agent_id}\nstatus: active\n"
            f"type: {record.get('type', 'observation')}\ncreated: {record.get('createdAt', '')}\n"
            f"tags:\n  - plur1bus/memory\n  - plur1bus/agent/{domain.agent_id}\n---\n\n"
            f"{record.get('content', '')}\n\n"
        )
        if note.exists():
            if not note.is_file() or note.stat().st_size > 256_000:
                report["conflicts"].append("mirror-type-or-size")
                return report
            text = note.read_text()
            if not text.startswith(prefix) or text.count('<section id="graph-links">') != 1 or text.count("</section>") != 1:
                report["conflicts"].append("manual-mirror-change")
                return report
        else:
            note.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(note, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(descriptor, "w") as handle:
                handle.write(prefix + '<section id="graph-links">\n<!-- PLUR1BUS managed graph links -->\n</section>\n')
                handle.flush()
                os.fsync(handle.fileno())
            report["repaired"].append("mirror")
        neo = domain._scope_neo_dir(selector)
        cognition = domain._read_jsonl(neo / "memory-cognition.jsonl")
        stamp = {"agentId": domain.agent_id, "scopeKey": selector.scope_key,
                 "aclBindings": selector.acl_bindings,
                 "createdAt": datetime.now(timezone.utc).isoformat()}
        if not any(row.get("id") == identifier and row.get("scopeKey") == selector.scope_key for row in cognition):
            domain._append_jsonl(neo / "memory-cognition.jsonl", {
                **stamp, "id": identifier, **analyze_text(str(record.get("content") or "")),
            })
        edges = domain._read_jsonl(neo / "memory-graph.jsonl")
        known = {(row.get("source"), row.get("target"), row.get("type"), row.get("scopeKey")) for row in edges}
        neighbors = domain._filter_rows(table.search(record["vector"]).where(
            selector.where(" AND status = 'active'")
        ).limit(4).to_list(), selector)
        for neighbor in neighbors:
            target = safe_memory_id(neighbor.get("id"))
            if target == identifier:
                continue
            contradiction = contradiction_score(str(record.get("content") or ""), str(neighbor.get("content") or ""))
            semantic = max(0.0, min(1.0, 1.0 - float(neighbor.get("_distance", 1.0))))
            for kind, strength in (("contradiction", contradiction), ("semantic", semantic if semantic >= 0.5 else 0)):
                key = (identifier, target, kind, selector.scope_key)
                if strength and key not in known:
                    domain._append_jsonl(neo / "memory-graph.jsonl", {
                        **stamp, "source": identifier, "target": target, "type": kind,
                        "strength": strength, "directed": False, "observations": 1,
                        "updatedAt": stamp["createdAt"], "lastReinforcedAt": stamp["createdAt"],
                        "algorithmVersion": "hermes-1.0",
                    })
                    known.add(key)
                    report["repaired"].append("graph-edge")
                if kind == "contradiction" and strength:
                    disclosures = domain._read_jsonl(neo / "contradiction-disclosure.jsonl")
                    if not any(row.get("newMemoryId") == identifier and row.get("existingMemoryId") == target for row in disclosures):
                        domain._append_jsonl(neo / "contradiction-disclosure.jsonl", {
                            **stamp, "id": str(uuid.uuid4()), "newMemoryId": identifier,
                            "existingMemoryId": target, "score": strength, "status": "requires_review",
                        })
        domain._classify_materialized_memory(record, domain._metadata_for(record), selector)
        domain.audit_mutation({**stamp, "event": "memory.materialization_repair",
                               "memoryId": identifier, "result": "repaired", "components": report["repaired"]})
        # Managed mirror links are handled by the existing explicit index rebuild;
        # repairing JSON graph edges never overwrites a user's mirror blocks.
        report["complete"] = True
        report["mirrorLinksRequireRebuild"] = True
        return report
